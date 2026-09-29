// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Aws,
  Duration,
  Stack,
  aws_aps as aps,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_efs as efs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { API_METRICS_PORT, GRAFANA_PORT, discoveryName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { tagService } from '../tagging.js';
import { addExecVolumes } from './exec-support.js';
import { grafanaLogsDashboard } from './log-queries.js';
import {
  grafanaBucketName,
  grafanaHost,
  namePrefix,
  removalPolicyOf,
  secretPrefix,
} from '../util.js';

export interface ObservabilityProps {
  config: Config;
  cluster: ecs.ICluster;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  namespace: string;
  alb: elbv2.IApplicationLoadBalancer;
  httpsListener: elbv2.IApplicationListener;
  hostedZone: route53.IHostedZone;
  alertTopic: sns.ITopic;
  /** Service label -> log group, for the Grafana logs dashboard. */
  logGroups: Record<string, logs.ILogGroup>;
}

const ASSET_DIR = join(import.meta.dirname, '../../observability/grafana');
const AWS_CLI_IMAGE = 'public.ecr.aws/aws-cli/aws-cli:2.37.4';

// Users baked into the upstream images. Every container runs as one of them.
const GRAFANA_USER = { uid: '472', gid: '0' };
const PROMETHEUS_USER = { uid: '65534', gid: '65534' };

type Mount =
  // Image-declared VOLUME path: Fargate copies the directory, with its owner.
  | { kind: 'image'; path: string }
  // EFS access point that forces the service's POSIX user.
  | { kind: 'efs'; path: string; accessPoint: efs.IAccessPoint };

interface ServiceOptions {
  image: string;
  user: { uid: string; gid: string };
  cpu: number;
  memoryMiB: number;
  capacity: 'FARGATE' | 'FARGATE_SPOT';
  port: number;
  healthPath: string;
  environment: Record<string, string>;
  secrets?: Record<string, ecs.Secret>;
  command?: string;
  mounts: Mount[];
  /** Stop the old task before starting the new one (single-writer state). */
  singleWriter?: boolean;
  /**
   * Seconds ECS ignores load balancer health checks after a task starts.
   * Grafana's first start runs about 650 database migrations on EFS (about
   * a minute) before it listens.
   */
  healthCheckGracePeriodSeconds?: number;
}

/**
 * Prometheus and Grafana with the Helm chart's dashboards and alert rules.
 *
 * - Prometheus runs in agent mode: it scrapes the API metrics endpoint
 *   through Cloud Map and remote-writes to Amazon Managed Service for
 *   Prometheus (AMP). Its WAL lives in the image's /prometheus volume.
 * - Grafana reads logs straight from CloudWatch Logs through its CloudWatch
 *   data source. The Helm chart uses Loki for this. On AWS, CloudWatch
 *   already holds every log line, so a second store would only duplicate it.
 * - Grafana keeps its database on EFS and is provisioned from S3 at start:
 *   dashboards, alert rules, and the routing policy from the CSMS repo, plus
 *   generated data sources (AMP and CloudWatch through the task role), the
 *   CloudWatch logs dashboard, and an SNS contact point.
 *
 * Every container runs as its image's non-root user with a read-only root
 * filesystem.
 */
export class Observability extends Construct {
  readonly grafanaHost: string;
  private readonly props: ObservabilityProps;
  private readonly fileSystem: efs.FileSystem;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    this.props = props;
    const { config, alertTopic } = props;
    const o = config.observability;
    const prefix = namePrefix(config);
    const bucket = s3.Bucket.fromBucketName(this, 'GrafanaBucket', grafanaBucketName(config));

    const workspace = new aps.CfnWorkspace(this, 'Amp', { alias: prefix });
    const ampEndpoint = workspace.attrPrometheusEndpoint;

    // --- EFS for Grafana's database ---

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: props.vpc,
      description: 'EVtivity observability EFS',
      allowAllOutbound: false,
    });
    efsSg.addIngressRule(props.securityGroup, ec2.Port.tcp(2049), 'NFS from tasks');
    this.fileSystem = new efs.FileSystem(this, 'Efs', {
      fileSystemName: `${prefix}-observability`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: efsSg,
      encrypted: true,
      enableAutomaticBackups: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: removalPolicyOf(config.storage.removal),
    });
    const accessPoint = (name: string, user: { uid: string; gid: string }): efs.AccessPoint =>
      this.fileSystem.addAccessPoint(`Ap-${name}`, {
        path: `/${name}`,
        createAcl: { ownerUid: user.uid, ownerGid: user.gid, permissions: '750' },
        posixUser: { uid: user.uid, gid: user.gid },
      });
    const grafanaAp = accessPoint('grafana', GRAFANA_USER);

    // --- Prometheus (agent) ---

    const prometheusConfig = [
      'global:',
      `  scrape_interval: ${String(o.prometheus.scrapeIntervalSeconds)}s`,
      '  external_labels:',
      `    environment: ${config.env}`,
      'scrape_configs:',
      '  - job_name: evtivity-api',
      '    metrics_path: /metrics',
      '    dns_sd_configs:',
      `      - names: ['${discoveryName('api')}.${props.namespace}']`,
      '        type: A',
      `        port: ${String(API_METRICS_PORT)}`,
      '        refresh_interval: 30s',
      'remote_write:',
      `  - url: ${ampEndpoint}api/v1/remote_write`,
      '    sigv4:',
      `      region: ${Aws.REGION}`,
    ].join('\n');

    const prometheus = this.service('prometheus', {
      image: `prom/prometheus:${o.prometheus.version}`,
      user: PROMETHEUS_USER,
      cpu: o.prometheus.cpu,
      memoryMiB: o.prometheus.memoryMiB,
      capacity: o.prometheus.capacity,
      port: 9090,
      healthPath: '/-/ready',
      environment: { PROMETHEUS_CONFIG: prometheusConfig },
      command: [
        'printf "%s" "$PROMETHEUS_CONFIG" > /prometheus/prometheus.yml',
        'exec /bin/prometheus --config.file=/prometheus/prometheus.yml --agent --storage.agent.path=/prometheus/agent',
      ].join(' && '),
      mounts: [{ kind: 'image', path: '/prometheus' }],
    });
    prometheus.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({ actions: ['aps:RemoteWrite'], resources: [workspace.attrArn] }),
    );

    // --- Grafana provisioning ---

    const datasources = [
      'apiVersion: 1',
      'datasources:',
      '  - name: Prometheus',
      '    type: prometheus',
      '    uid: prometheus',
      '    access: proxy',
      `    url: ${ampEndpoint}`,
      '    isDefault: true',
      '    editable: false',
      '    jsonData:',
      '      httpMethod: POST',
      '      sigV4Auth: true',
      '      sigV4AuthType: default',
      `      sigV4Region: ${Aws.REGION}`,
      '  - name: CloudWatch',
      '    type: cloudwatch',
      '    uid: cloudwatch',
      '    editable: false',
      '    jsonData:',
      '      authType: default',
      `      defaultRegion: ${Aws.REGION}`,
    ].join('\n');
    const logsDashboard = grafanaLogsDashboard(
      Object.fromEntries(
        Object.entries(props.logGroups).map(([label, g]) => [label, g.logGroupName]),
      ),
    );
    // The copied routing policy sends everything to `email-alerts`. Here that
    // receiver publishes to the environment's SNS topic, whose email
    // subscription delivers the message.
    const contactPoints = [
      'apiVersion: 1',
      'contactPoints:',
      '  - orgId: 1',
      '    name: email-alerts',
      '    receivers:',
      '      - uid: sns-default',
      '        type: sns',
      '        settings:',
      `          topic_arn: ${alertTopic.topicArn}`,
      `          subject: '[${config.env}] {{ template "default.title" . }}'`,
      `          message: '{{ template "evtivity.sns.message" . }}'`,
      '          sigv4:',
      `            region: ${Aws.REGION}`,
    ].join('\n');
    // Grafana's default message template reads `.Values`, which the SNS
    // notifier's alert data does not have, so every SNS message logged a
    // template error. This one uses only standard alert fields.
    const templates = [
      'apiVersion: 1',
      'templates:',
      '  - orgId: 1',
      '    name: evtivity-sns',
      '    template: |',
      '      {{ define "evtivity.sns.message" }}{{ range .Alerts }}[{{ .Status }}] {{ .Labels.alertname }}',
      '      {{ with .Annotations.summary }}{{ . }}',
      '      {{ end }}{{ with .Annotations.description }}{{ . }}',
      '      {{ end }}{{ with .GeneratorURL }}{{ . }}',
      '      {{ end }}',
      '      {{ end }}{{ end }}',
    ].join('\n');

    const provisioning = new s3deploy.BucketDeployment(this, 'GrafanaProvisioning', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'grafana/',
      sources: [
        s3deploy.Source.asset(ASSET_DIR),
        s3deploy.Source.data('provisioning/datasources/datasources.yml', datasources),
        s3deploy.Source.jsonData('dashboards/logs.json', logsDashboard),
        s3deploy.Source.data('provisioning/alerting/contactpoints.yml', contactPoints),
        s3deploy.Source.data('provisioning/alerting/templates.yml', templates),
      ],
      prune: true,
      retainOnDelete: false,
      memoryLimit: 256,
    });

    // --- Grafana ---

    const adminSecret = new secretsmanager.Secret(this, 'GrafanaAdmin', {
      secretName: `${secretPrefix(config)}/grafana-admin`,
      description: 'Grafana admin password (user: admin)',
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: removalPolicyOf(config.secrets.removal),
    });

    this.grafanaHost = grafanaHost(config);
    const grafanaHome = '/var/lib/grafana';
    const grafana = this.service('grafana', {
      image: `grafana/grafana:${o.grafana.version}`,
      user: GRAFANA_USER,
      cpu: o.grafana.cpu,
      memoryMiB: o.grafana.memoryMiB,
      capacity: o.grafana.capacity,
      port: GRAFANA_PORT,
      healthPath: '/api/health',
      environment: {
        GF_SECURITY_ADMIN_USER: 'admin',
        GF_SERVER_ROOT_URL: `https://${this.grafanaHost}`,
        GF_SERVER_HTTP_PORT: String(GRAFANA_PORT),
        GF_SECURITY_COOKIE_SECURE: 'true',
        GF_AUTH_ANONYMOUS_ENABLED: 'false',
        GF_USERS_ALLOW_SIGN_UP: 'false',
        GF_AUTH_SIGV4_AUTH_ENABLED: 'true',
        GF_ANALYTICS_REPORTING_ENABLED: 'false',
        GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
        GF_LOG_MODE: 'console',
        GF_PATHS_DATA: grafanaHome,
        GF_PATHS_PROVISIONING: `${grafanaHome}/provisioning`,
        GF_PATHS_PLUGINS: `${grafanaHome}/plugins`,
        TMPDIR: `${grafanaHome}/tmp`,
        AWS_REGION: Aws.REGION,
        // Changes to the dashboards or alert files roll the service so
        // Grafana re-reads its provisioning.
        // Resolve the tokens (AMP endpoint, topic ARN, log group names) to
        // their CloudFormation form first. Unresolved token strings carry a
        // global counter that shifts when unrelated constructs change, which
        // would restart Grafana.
        PROVISIONING_REVISION: hashDirectory(
          ASSET_DIR,
          JSON.stringify(
            Stack.of(this).resolve([datasources, contactPoints, templates, logsDashboard]),
          ),
        ),
      },
      secrets: { GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminSecret) },
      mounts: [{ kind: 'efs', path: grafanaHome, accessPoint: grafanaAp }],
      // SQLite on EFS takes a single writer.
      singleWriter: true,
      healthCheckGracePeriodSeconds: 300,
    });
    this.addGrafanaProvisioner(grafana.taskDefinition, grafana.logGroup, bucket, grafanaHome);
    grafana.service.node.addDependency(provisioning);
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'],
        resources: [workspace.attrArn],
      }),
    );
    // Logs Insights queries for the logs dashboard, scoped to this
    // environment's log groups. Listing log groups and reading or stopping a
    // query by id take no log group resource.
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:StartQuery', 'logs:GetLogGroupFields', 'logs:GetLogEvents'],
        resources: Object.values(props.logGroups).map((g) => g.logGroupArn),
      }),
    );
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StopQuery'],
        resources: ['*'],
      }),
    );
    // Read-only CloudWatch metrics for the CloudWatch data source. These
    // actions take no resource, and without them its health check fails.
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );
    alertTopic.grantPublish(grafana.taskDefinition.taskRole);
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('grafana/*')],
      }),
    );
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['grafana/*', 'grafana/'] } },
      }),
    );

    // The ALB forwards grafana.<zone> to Grafana. The web ACL in the ALB
    // stack blocks every source address outside the Grafana allowlist.
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'GrafanaTargets', {
      vpc: props.vpc,
      port: GRAFANA_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(15),
      healthCheck: { path: '/api/health', healthyHttpCodes: '200', interval: Duration.seconds(30) },
    });
    grafana.service.attachToApplicationTargetGroup(targetGroup);
    new elbv2.ApplicationListenerRule(this, 'GrafanaRule', {
      listener: props.httpsListener,
      priority: 60,
      conditions: [elbv2.ListenerCondition.hostHeaders([this.grafanaHost])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
    new route53.ARecord(this, 'GrafanaDns', {
      zone: props.hostedZone,
      recordName: this.grafanaHost,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb)),
    });
  }

  private service(
    name: string,
    opts: ServiceOptions,
  ): {
    service: ecs.FargateService;
    taskDefinition: ecs.FargateTaskDefinition;
    logGroup: logs.LogGroup;
  } {
    const { config, cluster, securityGroup } = this.props;
    const scope = new Construct(this, `Svc-${name}`);
    tagService(scope, name);

    const logGroup = new logs.LogGroup(scope, 'Logs', {
      logGroupName: `/evtivity/${config.env}/${name}`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });
    const taskDefinition = new ecs.FargateTaskDefinition(scope, 'Task', {
      family: `${namePrefix(config)}-${name}`,
      cpu: opts.cpu,
      memoryLimitMiB: opts.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const url = `http://127.0.0.1:${String(opts.port)}${opts.healthPath}`;
    const container = taskDefinition.addContainer(name, {
      image: ecs.ContainerImage.fromRegistry(opts.image),
      user: `${opts.user.uid}:${opts.user.gid}`,
      readonlyRootFilesystem: true,
      privileged: false,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
      environment: opts.environment,
      secrets: opts.secrets,
      portMappings: [{ containerPort: opts.port, protocol: ecs.Protocol.TCP }],
      stopTimeout: Duration.seconds(60),
      healthCheck: {
        command: ['CMD-SHELL', `wget -q -O /dev/null ${url} || exit 1`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(90),
      },
      ...(opts.command != null && { entryPoint: ['sh', '-c'], command: [opts.command] }),
    });
    for (const mount of opts.mounts) {
      this.addMount(taskDefinition, container, name, mount);
    }
    if (config.ecs.executeCommand) addExecVolumes(taskDefinition, container);

    const service = new ecs.FargateService(scope, 'Service', {
      serviceName: `${namePrefix(config)}-${name}`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      capacityProviderStrategies: [{ capacityProvider: opts.capacity, weight: 1 }],
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: config.ecs.executeCommand,
      minHealthyPercent: opts.singleWriter === true ? 0 : 100,
      maxHealthyPercent: opts.singleWriter === true ? 100 : 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      cloudMapOptions: { name, dnsTtl: Duration.seconds(10) },
      ...(opts.healthCheckGracePeriodSeconds != null && {
        healthCheckGracePeriod: Duration.seconds(opts.healthCheckGracePeriodSeconds),
      }),
    });
    return { service, taskDefinition, logGroup };
  }

  private addMount(
    taskDefinition: ecs.FargateTaskDefinition,
    container: ecs.ContainerDefinition,
    name: string,
    mount: Mount,
  ): void {
    // One volume per mount kind per service. The Grafana provisioner reuses
    // `grafana-efs` by name.
    const volume = `${name}-${mount.kind}`;
    if (mount.kind === 'image') {
      taskDefinition.addVolume({ name: volume });
    } else {
      taskDefinition.addVolume({
        name: volume,
        efsVolumeConfiguration: {
          fileSystemId: this.fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: mount.accessPoint.accessPointId, iam: 'ENABLED' },
        },
      });
      taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          resources: [this.fileSystem.fileSystemArn],
          conditions: {
            StringEquals: { 'elasticfilesystem:AccessPointArn': mount.accessPoint.accessPointArn },
          },
        }),
      );
    }
    container.addMountPoints({ containerPath: mount.path, sourceVolume: volume, readOnly: false });
  }

  /**
   * Copies Grafana's provisioning files and dashboards from S3 onto its EFS
   * volume before Grafana starts, running as the Grafana user.
   */
  private addGrafanaProvisioner(
    taskDefinition: ecs.FargateTaskDefinition,
    logGroup: logs.ILogGroup,
    bucket: s3.IBucket,
    home: string,
  ): void {
    const grafana = taskDefinition.defaultContainer;
    if (grafana == null) throw new Error('Grafana task has no container');
    const init = taskDefinition.addContainer('provision', {
      image: ecs.ContainerImage.fromRegistry(AWS_CLI_IMAGE),
      user: `${GRAFANA_USER.uid}:${GRAFANA_USER.gid}`,
      essential: false,
      readonlyRootFilesystem: true,
      privileged: false,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'provision', logGroup }),
      environment: { HOME: `${home}/tmp`, BUCKET: bucket.bucketName },
      entryPoint: ['sh', '-c'],
      command: [
        [
          'set -e',
          `mkdir -p ${home}/tmp ${home}/provisioning ${home}/dashboards`,
          `aws s3 sync --delete --only-show-errors "s3://$BUCKET/grafana/provisioning" ${home}/provisioning`,
          `aws s3 sync --delete --only-show-errors "s3://$BUCKET/grafana/dashboards" ${home}/dashboards`,
          // Grafana logs an error at start when this directory is missing.
          `mkdir -p ${home}/provisioning/plugins`,
          'echo provisioning ready',
        ].join('\n'),
      ],
    });
    init.addMountPoints({ containerPath: home, sourceVolume: 'grafana-efs', readOnly: false });
    grafana.addContainerDependencies({
      container: init,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });
  }
}

/** Stable hash of every file under `dir` plus extra generated content. */
function hashDirectory(dir: string, extra: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(entry).update(readFileSync(path));
    }
  };
  walk(dir);
  hash.update(extra);
  return hash.digest('hex').slice(0, 16);
}

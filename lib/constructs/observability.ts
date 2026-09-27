// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Aws,
  Duration,
  aws_aps as aps,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_efs as efs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_logs_destinations as logDestinations,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { API_METRICS_PORT, GRAFANA_PORT, LOKI_PORT, discoveryName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { tagService } from '../tagging.js';
import {
  grafanaBucketName,
  lokiBucketName,
  namePrefix,
  removalPolicyOf,
  secretPrefix,
  zoneApex,
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
  /** Loki `service` label -> log group to forward. */
  logGroups: Record<string, logs.ILogGroup>;
}

const ASSET_DIR = join(import.meta.dirname, '../../observability/grafana');
const AWS_CLI_IMAGE = 'public.ecr.aws/aws-cli/aws-cli:2.37.4';

// Users baked into the upstream images. Every container runs as one of them.
const GRAFANA_USER = { uid: '472', gid: '0' };
const PROMETHEUS_USER = { uid: '65534', gid: '65534' };
const LOKI_USER = { uid: '10001', gid: '10001' };

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
}

/**
 * Prometheus, Loki, and Grafana with the Helm chart's dashboards and alert
 * rules.
 *
 * - Prometheus runs in agent mode: it scrapes the API metrics endpoint
 *   through Cloud Map and remote-writes to Amazon Managed Service for
 *   Prometheus (AMP). Its WAL lives in the image's /prometheus volume.
 * - Loki stores chunks and indexes in S3 and its WAL on EFS.
 * - A Lambda copies each service's CloudWatch logs to Loki. CloudWatch stays
 *   the system of record.
 * - Grafana keeps its database on EFS and is provisioned from S3 at start:
 *   dashboards, alert rules, and the routing policy from the CSMS repo, plus
 *   generated datasources (AMP through the task role, Loki) and an SNS
 *   contact point.
 *
 * Every container runs as its image's non-root user with a read-only root
 * filesystem.
 */
export class Observability extends Construct {
  readonly grafanaHost: string;
  /** True when grafana.<zone> resolves and accepts the allowed CIDRs. */
  readonly grafanaHostPublic: boolean;
  private readonly props: ObservabilityProps;
  private readonly fileSystem: efs.FileSystem;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    this.props = props;
    const { config, alertTopic } = props;
    const o = config.observability;
    const prefix = namePrefix(config);
    const bucket = s3.Bucket.fromBucketName(this, 'GrafanaBucket', grafanaBucketName(config));
    const lokiBucket = s3.Bucket.fromBucketName(this, 'LokiBucket', lokiBucketName(config));
    const lokiUrl = `http://loki.${props.namespace}:${String(LOKI_PORT)}`;

    const workspace = new aps.CfnWorkspace(this, 'Amp', { alias: prefix });
    const ampEndpoint = workspace.attrPrometheusEndpoint;

    // --- EFS for Loki and Grafana state ---

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
    const lokiAp = accessPoint('loki', LOKI_USER);
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

    // --- Loki ---

    const lokiConfig = [
      'auth_enabled: false',
      'server:',
      `  http_listen_port: ${String(LOKI_PORT)}`,
      '  log_level: warn',
      'common:',
      '  path_prefix: /loki',
      '  replication_factor: 1',
      '  ring:',
      '    kvstore:',
      '      store: inmemory',
      '  storage:',
      '    s3:',
      `      bucketnames: ${lokiBucket.bucketName}`,
      `      region: ${Aws.REGION}`,
      'schema_config:',
      '  configs:',
      "    - from: '2024-01-01'",
      '      store: tsdb',
      '      object_store: s3',
      '      schema: v13',
      '      index:',
      '        prefix: loki_index_',
      '        period: 24h',
      'compactor:',
      '  working_directory: /loki/compactor',
      '  retention_enabled: true',
      '  delete_request_store: s3',
      'limits_config:',
      `  retention_period: ${String(o.loki.retentionDays * 24)}h`,
      '  reject_old_samples: true',
      '  reject_old_samples_max_age: 168h',
      '  ingestion_rate_mb: 4',
      '  ingestion_burst_size_mb: 6',
      'analytics:',
      '  reporting_enabled: false',
    ].join('\n');

    const loki = this.service('loki', {
      image: `grafana/loki:${o.loki.version}`,
      user: LOKI_USER,
      cpu: o.loki.cpu,
      memoryMiB: o.loki.memoryMiB,
      capacity: o.loki.capacity,
      port: LOKI_PORT,
      healthPath: '/ready',
      environment: { LOKI_CONFIG: lokiConfig },
      command: [
        'printf "%s" "$LOKI_CONFIG" > /loki/loki.yaml',
        'exec /usr/bin/loki -config.file=/loki/loki.yaml',
      ].join(' && '),
      mounts: [{ kind: 'efs', path: '/loki', accessPoint: lokiAp }],
      // One writer on the WAL and the in-memory ring.
      singleWriter: true,
    });
    // Chunks, indexes, and compactor state. Loki owns the whole bucket.
    loki.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [lokiBucket.arnForObjects('*')],
      }),
    );
    loki.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [lokiBucket.bucketArn] }),
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
      '  - name: Loki',
      '    type: loki',
      '    uid: loki',
      '    access: proxy',
      `    url: ${lokiUrl}`,
      '    isDefault: false',
      '    editable: false',
    ].join('\n');
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
      '          sigv4:',
      `            region: ${Aws.REGION}`,
    ].join('\n');

    const provisioning = new s3deploy.BucketDeployment(this, 'GrafanaProvisioning', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'grafana/',
      sources: [
        s3deploy.Source.asset(ASSET_DIR),
        s3deploy.Source.data('provisioning/datasources/datasources.yml', datasources),
        s3deploy.Source.data('provisioning/alerting/contactpoints.yml', contactPoints),
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

    this.grafanaHost = `${o.grafana.hostname}.${zoneApex(config)}`;
    this.grafanaHostPublic = o.grafana.allowedCidrs.length > 0;
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
        PROVISIONING_REVISION: hashDirectory(ASSET_DIR, datasources + contactPoints),
      },
      secrets: { GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminSecret) },
      mounts: [{ kind: 'efs', path: grafanaHome, accessPoint: grafanaAp }],
      // SQLite on EFS takes a single writer.
      singleWriter: true,
    });
    this.addGrafanaProvisioner(grafana.taskDefinition, grafana.logGroup, bucket, grafanaHome);
    grafana.service.node.addDependency(provisioning);
    grafana.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'],
        resources: [workspace.attrArn],
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

    // Public access only from the configured CIDRs. Without any, Grafana has
    // no listener rule or DNS record and is reached through ECS Exec.
    if (o.grafana.allowedCidrs.length > 0) {
      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'GrafanaTargets', {
        vpc: props.vpc,
        port: GRAFANA_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(15),
        healthCheck: {
          path: '/api/health',
          healthyHttpCodes: '200',
          interval: Duration.seconds(30),
        },
      });
      grafana.service.attachToApplicationTargetGroup(targetGroup);
      new elbv2.ApplicationListenerRule(this, 'GrafanaRule', {
        listener: props.httpsListener,
        priority: 60,
        conditions: [
          elbv2.ListenerCondition.hostHeaders([this.grafanaHost]),
          elbv2.ListenerCondition.sourceIps(o.grafana.allowedCidrs),
        ],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
      new route53.ARecord(this, 'GrafanaDns', {
        zone: props.hostedZone,
        recordName: this.grafanaHost,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb)),
      });
    }

    // --- CloudWatch Logs -> Loki ---

    const forwarderLogs = new logs.LogGroup(this, 'ForwarderLogs', {
      logGroupName: `/evtivity/${config.env}/loki-forwarder`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });
    const forwarder = new lambdaNodejs.NodejsFunction(this, 'LokiForwarder', {
      entry: join(import.meta.dirname, '../../lambda/loki-forwarder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      logGroup: forwarderLogs,
      environment: {
        LOKI_URL: lokiUrl,
        ENVIRONMENT: config.env,
        SERVICE_BY_LOG_GROUP: JSON.stringify(
          Object.fromEntries(
            Object.entries(props.logGroups).map(([label, g]) => [g.logGroupName, label]),
          ),
        ),
      },
      bundling: { minify: true, sourceMap: false, target: 'node24' },
    });
    const destination = new logDestinations.LambdaDestination(forwarder);
    for (const [label, group] of Object.entries(props.logGroups)) {
      new logs.SubscriptionFilter(this, `Forward-${label}`, {
        logGroup: group,
        destination,
        filterPattern: logs.FilterPattern.allEvents(),
        filterName: `${prefix}-loki`,
      });
    }
    forwarder.node.addDependency(loki.service);
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

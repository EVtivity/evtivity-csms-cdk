// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Aspects,
  Aws,
  Stack,
  type StackProps,
  CfnOutput,
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_servicediscovery as servicediscovery,
} from 'aws-cdk-lib';
import type { Construct, IConstruct } from 'constructs';
import { SERVICE_CATALOG, SERVICE_NAMES, discoveryName, type ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { AppService } from '../constructs/app-service.js';
import { Dashboards } from '../constructs/dashboards.js';
import { DbJob } from '../constructs/db-job.js';
import { EnvMetrics } from '../constructs/metrics.js';
import { Monitoring } from '../constructs/monitoring.js';
import { Observability } from '../constructs/observability.js';
import {
  namePrefix,
  removalPolicyOf,
  secretPrefix,
  serviceHost,
  serviceUrl,
  zoneApex,
} from '../util.js';

export interface AppStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  observabilitySg?: ec2.ISecurityGroup;
  nlbSg?: ec2.ISecurityGroup;
  /** NAT instance or gateway ids from the Network stack. */
  natIds: string[];
  alb: elbv2.ApplicationLoadBalancer;
  httpsListener: elbv2.IApplicationListener;
  httpListener: elbv2.IApplicationListener;
  hostedZone: route53.IHostedZone;
  /** App bucket name. A plain name keeps IAM statements readable and avoids an export. */
  appBucketName: string;
  data: {
    dbHost: string;
    dbPort: string;
    dbName: string;
    masterSecret: secretsmanager.ISecret;
    appDbSecret: secretsmanager.ISecret;
    cacheHost: string;
    cachePort: number;
    cacheSecret: secretsmanager.ISecret;
    jwtSecret: secretsmanager.ISecret;
    settingsKeySecret: secretsmanager.ISecret;
    initialAdminSecret: secretsmanager.ISecret;
    postgresLogs: logs.ILogGroup;
    valkeySlowLog: logs.ILogGroup;
  };
}

/**
 * ECS cluster, the database job, every enabled service, DNS records, the
 * optional OCPP TLS NLB, and the scheduled redeploys that roll rotated
 * credentials into running tasks.
 */
export class AppStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly services: Partial<Record<ServiceName, AppService>> = {};

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, vpc, ecsSg, data } = props;
    const prefix = namePrefix(config);
    const namespace = `${config.env}.evtivity.internal`;
    const internal = (name: ServiceName): string => `${discoveryName(name)}.${namespace}`;
    // Internal OCPP endpoints for the worker, API, and simulator. The TLS
    // port is the listener's when OCPP TLS is on, else the OCPP default.
    const ocppUrl = `ws://${internal('ocpp')}:8080`;
    const ocppTlsUrl = `wss://${internal('ocpp')}:${String(config.ocppTls.enabled ? config.ocppTls.port : 8443)}`;

    // With ECS Exec on, every session and its commands are logged for audit.
    const execLogs = config.ecs.executeCommand
      ? new logs.LogGroup(this, 'ExecSessionLogs', {
          logGroupName: `/evtivity/${config.env}/ecs-exec`,
          retention: config.logs.retentionDays,
          removalPolicy: removalPolicyOf(config.logs.removal),
        })
      : undefined;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: prefix,
      ...(execLogs != null && {
        executeCommandConfiguration: {
          logging: ecs.ExecuteCommandLogging.OVERRIDE,
          logConfiguration: { cloudWatchLogGroup: execLogs, cloudWatchEncryptionEnabled: false },
        },
      }),
      vpc,
      containerInsightsV2:
        config.ecs.containerInsights === 'enhanced'
          ? ecs.ContainerInsights.ENHANCED
          : ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
      defaultCloudMapNamespace: {
        name: namespace,
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
        vpc,
      },
    });

    // --- Database job: migrations, roles, admin seed, settings ---

    const settings: Record<string, string | number | boolean> = {
      's3.bucket': props.appBucketName,
      's3.region': config.region,
      ...config.appSettings,
    };
    const dbJob = new DbJob(this, 'DbJob', {
      config,
      cluster: this.cluster,
      vpc,
      securityGroup: ecsSg,
      image: ecs.ContainerImage.fromRegistry(
        `${config.image.registry}/migrate:${config.image.tag}`,
      ),
      dbHost: data.dbHost,
      dbPort: data.dbPort,
      dbName: data.dbName,
      masterSecret: data.masterSecret,
      appDbSecret: data.appDbSecret,
      settingsKeySecret: data.settingsKeySecret,
      initialAdminSecret: data.initialAdminSecret,
      settings,
      simulator: {
        ocppUrl,
        ocppTlsUrl,
      },
      ...(config.seedDemo.enabled && { demo: { tlsEnabled: config.ocppTls.enabled } }),
    });

    // --- Services ---

    const urls = {
      api: serviceUrl(config, 'api'),
      csms: serviceUrl(config, 'csms'),
      portal: serviceUrl(config, 'portal'),
      ocpp: serviceUrl(config, 'ocpp', 'wss'),
      ocpi: serviceUrl(config, 'ocpi'),
    };
    const ocppTlsPort = config.ocppTls.enabled ? config.ocppTls.port : undefined;

    for (const name of SERVICE_NAMES) {
      const sc = config.services[name];
      if (!sc.enabled) continue;
      const spec = SERVICE_CATALOG[name];

      const environment: Record<string, string> = {};
      const secrets: Record<string, ecs.Secret> = {};

      if (spec.kind === 'node') {
        Object.assign(environment, {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
          HOME: '/tmp',
          // Leave a quarter of the task memory for native allocations.
          NODE_OPTIONS: `--max-old-space-size=${String(Math.floor(sc.memoryMiB * 0.75))}`,
        });
      }
      if (spec.usesData) {
        Object.assign(environment, {
          DB_HOST: data.dbHost,
          DB_PORT: data.dbPort,
          DB_NAME: data.dbName,
          DB_SSLMODE: 'require',
          DB_POOL_MAX: String(config.aurora.poolMax),
          REDIS_HOST: data.cacheHost,
          REDIS_PORT: String(data.cachePort),
          REDIS_TLS: 'true',
        });
        secrets['DB_USER'] = ecs.Secret.fromSecretsManager(data.appDbSecret, 'username');
        secrets['DB_PASSWORD'] = ecs.Secret.fromSecretsManager(data.appDbSecret, 'password');
        secrets['REDIS_USER'] = ecs.Secret.fromSecretsManager(data.cacheSecret, 'username');
        secrets['REDIS_PASSWORD'] = ecs.Secret.fromSecretsManager(data.cacheSecret, 'password');
      }
      if (spec.usesSettingsKey) {
        secrets['SETTINGS_ENCRYPTION_KEY'] = ecs.Secret.fromSecretsManager(data.settingsKeySecret);
      }

      switch (name) {
        case 'api':
          Object.assign(environment, {
            API_PORT: '3001',
            API_HOST: '0.0.0.0',
            CORS_ORIGIN: [urls.csms, urls.portal].filter((u) => u !== '').join(','),
            CSMS_URL: urls.csms,
            PORTAL_URL: urls.portal,
            // The dashboard reads the CSRF cookie that the API sets, so the
            // cookie must be scoped to the parent domain of both hosts.
            COOKIE_DOMAIN: zoneApex(config),
            OCPP_PORT: '8080',
            OCPP_SERVER_URL: ocppUrl,
            SEED_DEMO: 'false',
          });
          secrets['JWT_SECRET'] = ecs.Secret.fromSecretsManager(data.jwtSecret);
          break;
        case 'ocpp':
          Object.assign(environment, {
            OCPP_PORT: '8080',
            OCPP_HEALTH_PORT: '8081',
            CSMS_URL: urls.csms,
            PORTAL_URL: urls.portal,
            // The ALB sits inside the VPC, so its X-Forwarded-For hop is trusted.
            OCPP_TRUSTED_PROXY_CIDRS: vpc.vpcCidrBlock,
          });
          if (ocppTlsPort != null && config.ocppTls.secretName != null) {
            const tls = secretsmanager.Secret.fromSecretNameV2(
              this,
              'OcppTlsSecret',
              config.ocppTls.secretName,
            );
            environment['OCPP_TLS_PORT'] = String(ocppTlsPort);
            secrets['OCPP_TLS_CERT_PEM'] = ecs.Secret.fromSecretsManager(tls, 'cert');
            secrets['OCPP_TLS_KEY_PEM'] = ecs.Secret.fromSecretsManager(tls, 'key');
            secrets['OCPP_TLS_CA_PEM'] = ecs.Secret.fromSecretsManager(tls, 'ca');
          }
          break;
        case 'ocpi':
          Object.assign(environment, {
            OCPI_PORT: '3002',
            OCPI_BASE_URL: urls.ocpi,
            OCPI_COUNTRY_CODE: config.ocpi.countryCode,
            OCPI_PARTY_ID: config.ocpi.partyId,
            OCPI_BUSINESS_NAME: config.ocpi.businessName,
          });
          break;
        case 'csms':
        case 'portal':
          Object.assign(environment, {
            RUNTIME_API_URL: urls.api,
            RUNTIME_PORTAL_URL: urls.portal,
            RUNTIME_CSMS_URL: urls.csms,
            RUNTIME_OCPP_URL: urls.ocpp,
          });
          break;
        case 'worker':
          Object.assign(environment, {
            API_PORT: '3001',
            OCPP_PORT: '8080',
            API_BASE_URL: `http://${internal('api')}:3001`,
            OCPP_SERVER_URL: ocppUrl,
            CSMS_URL: urls.csms,
            PORTAL_URL: urls.portal,
          });
          break;
        case 'css':
          Object.assign(environment, {
            OCPP_SERVER_URL: ocppUrl,
            OCPP_TLS_SERVER_URL: ocppTlsUrl,
            CSS_MODE: 'standby',
            CSS_HEALTH_PORT: '8082',
          });
          if (config.cssTls.enabled && config.cssTls.secretName != null) {
            const tls = secretsmanager.Secret.fromSecretNameV2(
              this,
              'CssTlsSecret',
              config.cssTls.secretName,
            );
            secrets['CSS_CLIENT_CERT_PEM'] = ecs.Secret.fromSecretsManager(tls, 'cert');
            secrets['CSS_CLIENT_KEY_PEM'] = ecs.Secret.fromSecretsManager(tls, 'key');
            secrets['CSS_CA_PEM'] = ecs.Secret.fromSecretsManager(tls, 'ca');
          }
          break;
        case 'ocpiSim':
          Object.assign(environment, {
            OCPI_SIM_PORT: '3003',
            OCPI_SIM_ROLE: 'emsp',
            OCPI_SIM_BASE_URL: `http://${internal('ocpiSim')}:3003`,
            OCPI_SIM_COUNTRY_CODE: 'NL',
            OCPI_SIM_PARTY_ID: 'SIM',
            OCPI_SIM_NAME: 'OCPI Simulator',
          });
          break;
        case 'ocpiCpoSim':
          Object.assign(environment, {
            OCPI_SIM_PORT: '3004',
            OCPI_SIM_ROLE: 'cpo',
            OCPI_SIM_BASE_URL: `http://${internal('ocpiCpoSim')}:3004`,
            OCPI_SIM_COUNTRY_CODE: 'DE',
            OCPI_SIM_PARTY_ID: 'CPO',
            OCPI_SIM_NAME: 'OCPI CPO Simulator',
            OCPI_SIM_AUTO_SESSION: 'true',
            OCPI_SIM_SESSION_INTERVAL: '60',
            OCPI_SIM_SESSION_DURATION: '30',
          });
          break;
      }

      // Config overrides win over derived values.
      Object.assign(environment, sc.env);
      for (const [envName, ref] of Object.entries(sc.secrets)) {
        const [secretName, field] = ref.split(':');
        const secret = secretsmanager.Secret.fromSecretNameV2(
          this,
          `Extra-${name}-${envName}`,
          secretName ?? ref,
        );
        secrets[envName] =
          field != null && field !== ''
            ? ecs.Secret.fromSecretsManager(secret, field)
            : ecs.Secret.fromSecretsManager(secret);
      }

      const svc = new AppService(this, `Svc-${name}`, {
        name,
        config,
        cluster: this.cluster,
        vpc,
        securityGroup: ecsSg,
        environment,
        secrets,
        httpsListener: props.httpsListener,
        httpListener: props.httpListener,
        ...(name === 'ocpp' && ocppTlsPort != null && { extraPort: ocppTlsPort }),
      });
      // Services start only after migrations and grants have succeeded.
      svc.service.node.addDependency(dbJob.resource);
      // The simulator picks up the demo stations on first start.
      if (name === 'css' && dbJob.demoResource != null) {
        svc.service.node.addDependency(dbJob.demoResource);
      }
      if (spec.usesBucket) {
        // Presigned uploads and downloads, attachment deletes, and listing.
        svc.taskDefinition.addToTaskRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
            resources: [`arn:${Aws.PARTITION}:s3:::${props.appBucketName}/*`],
          }),
        );
        svc.taskDefinition.addToTaskRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [`arn:${Aws.PARTITION}:s3:::${props.appBucketName}`],
          }),
        );
      }
      this.services[name] = svc;

      const host = serviceHost(config, name);
      if (host != null) {
        new route53.ARecord(this, `Dns-${name}`, {
          zone: props.hostedZone,
          recordName: host,
          target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb)),
        });
      }
    }

    const ocpp = this.services.ocpp;
    if (ocppTlsPort != null && ocpp != null && props.nlbSg != null) {
      this.addOcppTlsNlb(config, props, ocpp, ocppTlsPort);
    }

    if (config.ecs.redeployEveryDays > 0) this.addScheduledRedeploys(config);

    // One topic for CloudWatch alarms and Grafana alerts. Email
    // subscriptions need a confirmation click before they deliver.
    // CloudWatch alarms and EventBridge cannot publish to a topic encrypted
    // with the AWS-managed aws/sns key, so the topic gets its own key whose
    // policy lets those services use it.
    const alertsKey = new kms.Key(this, 'AlertsKey', {
      alias: `${prefix}-alerts`,
      description: 'Encrypts the EVtivity alerts SNS topic',
      enableKeyRotation: true,
      removalPolicy: removalPolicyOf(config.secrets.removal),
      pendingWindow: Duration.days(7),
    });
    for (const service of ['cloudwatch.amazonaws.com', 'events.amazonaws.com']) {
      alertsKey.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal(service)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
      );
    }
    const alertTopic = new sns.Topic(this, 'Alerts', {
      topicName: `${prefix}-alerts`,
      masterKey: alertsKey,
      enforceSSL: true,
    });

    // A failed or abandoned rotation leaves a credential half-rotated, which
    // is silent until the next task start fails. Alert on it.
    new events.Rule(this, 'RotationFailures', {
      ruleName: `${prefix}-rotation-failures`,
      description: 'Secrets Manager rotation failures for this environment',
      eventPattern: {
        source: ['aws.secretsmanager'],
        detailType: ['AWS Service Event via CloudTrail'],
        detail: {
          eventSource: ['secretsmanager.amazonaws.com'],
          eventName: ['RotationFailed', 'RotationAbandoned', 'TestRotationFailed'],
          additionalEventData: {
            SecretId: [
              {
                prefix: `arn:${Aws.PARTITION}:secretsmanager:${this.region}:${this.account}:secret:${secretPrefix(config)}/`,
              },
            ],
          },
        },
      },
      targets: [new eventTargets.SnsTopic(alertTopic)],
    });
    // The weekly redeploys run outside CloudFormation. When the circuit
    // breaker rolls one back, nothing else reports it.
    new events.Rule(this, 'DeploymentFailures', {
      ruleName: `${prefix}-deployment-failures`,
      description: 'ECS service deployments that failed in this cluster',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Deployment State Change'],
        resources: events.Match.prefix(
          `arn:${Aws.PARTITION}:ecs:${this.region}:${this.account}:service/${this.cluster.clusterName}/`,
        ),
        detail: { eventName: ['SERVICE_DEPLOYMENT_FAILED'] },
      },
      targets: [new eventTargets.SnsTopic(alertTopic)],
    });
    if (config.monitoring.alarmEmail != null) {
      alertTopic.addSubscription(new subs.EmailSubscription(config.monitoring.alarmEmail));
    }

    // Log groups by the `service` label the Grafana logs dashboard filters
    // on, matching the Helm and Compose names (the simulator is `simulator`,
    // Valkey `redis`). The Grafana and CloudWatch logs dashboards both use them.
    const serviceLabels: Partial<Record<ServiceName, string>> = {
      css: 'simulator',
      ocpiSim: 'ocpi-simulator',
      ocpiCpoSim: 'ocpi-cpo-simulator',
    };
    const logGroups: Record<string, logs.ILogGroup> = {
      migrate: dbJob.logGroup,
      postgres: data.postgresLogs,
      redis: data.valkeySlowLog,
    };
    for (const [name, svc] of Object.entries(this.services) as [ServiceName, AppService][]) {
      logGroups[serviceLabels[name] ?? name] = svc.logGroup;
    }

    const observability = config.observability.enabled
      ? new Observability(this, 'Observability', {
          config,
          cluster: this.cluster,
          vpc,
          securityGroup: props.observabilitySg ?? ecsSg,
          namespace,
          alb: props.alb,
          httpsListener: props.httpsListener,
          hostedZone: props.hostedZone,
          alertTopic,
          logGroups,
        })
      : undefined;
    const grafanaUrl = observability != null ? `https://${observability.grafanaHost}` : undefined;
    if (grafanaUrl != null) new CfnOutput(this, 'Url-grafana', { value: grafanaUrl });

    const metrics = new EnvMetrics(config, this.cluster.clusterName, props.alb, props.natIds);
    const alarms = config.monitoring.alarms
      ? new Monitoring(this, 'Monitoring', {
          config,
          metrics,
          services: this.services,
          alertTopic,
        }).alarms
      : [];
    if (config.monitoring.dashboard) {
      new Dashboards(this, 'Dashboards', {
        config,
        metrics,
        services: this.services,
        logGroups,
        alarms,
        ...(grafanaUrl != null && { grafanaUrl }),
      });
    }

    // Services must be deleted before the cluster's capacity provider
    // association. Without this dependency CloudFormation may delete the
    // association first, which fails while Fargate Spot tasks still run
    // ("The specified capacity provider is in use") and leaves the stack in
    // DELETE_FAILED on destroy. CDK creates the association in an aspect at
    // synth, so this one runs after it.
    const cluster = this.cluster;
    Aspects.of(this).add(
      {
        visit(node: IConstruct): void {
          if (!(node instanceof ecs.CfnService)) return;
          const association = cluster.node
            .findAll()
            .find((c) => c instanceof ecs.CfnClusterCapacityProviderAssociations);
          if (association != null) node.node.addDependency(association);
        },
      },
      { priority: 600 },
    );

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    for (const [name, url] of Object.entries(urls)) {
      if (url !== '') new CfnOutput(this, `Url-${name}`, { value: url });
    }
  }

  private addOcppTlsNlb(
    config: Config,
    props: AppStackProps,
    ocpp: AppService,
    port: number,
  ): void {
    const nlb = new elbv2.NetworkLoadBalancer(this, 'OcppTlsNlb', {
      loadBalancerName: `${namePrefix(config)}-ocpp-tls`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
      crossZoneEnabled: true,
      securityGroups: props.nlbSg != null ? [props.nlbSg] : [],
      deletionProtection: config.alb.deletionProtection,
    });
    const tg = new elbv2.NetworkTargetGroup(this, 'OcppTlsTargets', {
      vpc: props.vpc,
      port,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(config.services.ocpp.deregistrationDelaySeconds),
      // The OCPP server sees the station's address for per-IP limits.
      preserveClientIp: true,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: String(port),
        interval: Duration.seconds(30),
      },
    });
    ocpp.service
      .loadBalancerTarget({ containerName: 'app', containerPort: port })
      .attachToNetworkTargetGroup(tg);
    nlb.addListener('Tls', { port, protocol: elbv2.Protocol.TCP, defaultTargetGroups: [tg] });

    const host = `${config.ocppTls.hostname}.${zoneApex(config)}`;
    new route53.ARecord(this, 'Dns-ocpp-tls', {
      zone: props.hostedZone,
      recordName: host,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(nlb)),
    });
    new CfnOutput(this, 'Url-ocppTls', { value: `wss://${host}:${String(port)}` });
  }

  /**
   * Forces a new deployment of each service on a fixed schedule. Rotation
   * keeps the previous database and cache credential valid for one full
   * rotation interval, and ECS only reads secrets when a task starts, so
   * tasks must be replaced within that interval.
   */
  private addScheduledRedeploys(config: Config): void {
    const role = new iam.Role(this, 'RedeployRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Forces ECS redeploys so tasks pick up rotated credentials',
    });
    const services = Object.entries(this.services);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService'],
        resources: services.map(([, s]) => s.service.serviceArn),
      }),
    );
    // Stagger by service so the redeploys do not all hit at once.
    services.forEach(([name, svc], i) => {
      new scheduler.CfnSchedule(this, `Redeploy-${name}`, {
        name: `${namePrefix(config)}-redeploy-${name}`,
        description: `Credential refresh for ${name}`,
        scheduleExpression: `cron(${String((i * 5) % 60)} 9 ? * ${redeployDays(config.ecs.redeployEveryDays)} *)`,
        scheduleExpressionTimezone: 'UTC',
        flexibleTimeWindow: { mode: 'OFF' },
        state: 'ENABLED',
        target: {
          arn: 'arn:aws:scheduler:::aws-sdk:ecs:updateService',
          roleArn: role.roleArn,
          input: JSON.stringify({
            Cluster: this.cluster.clusterName,
            Service: svc.service.serviceName,
            ForceNewDeployment: true,
          }),
          retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
        },
      });
    });
  }
}

/** Day-of-week field for a cron that fires at least every `days` days. */
function redeployDays(days: number): string {
  // Cron has no "every N days" for N > 1 that survives month boundaries.
  // Use fixed weekdays instead: every day, or a weekly subset.
  if (days <= 1) return '*';
  if (days <= 3) return 'MON,WED,FRI';
  return 'TUE';
}

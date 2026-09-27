// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Aws,
  Stack,
  type StackProps,
  CfnOutput,
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_servicediscovery as servicediscovery,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SERVICE_CATALOG, SERVICE_NAMES, discoveryName, type ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { AppService } from '../constructs/app-service.js';
import { DbJob } from '../constructs/db-job.js';
import { Monitoring } from '../constructs/monitoring.js';
import { namePrefix, serviceHost, serviceUrl, zoneApex } from '../util.js';

export interface AppStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  nlbSg?: ec2.ISecurityGroup;
  alb: elbv2.IApplicationLoadBalancer;
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
  readonly ocppNlb?: elbv2.NetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, vpc, ecsSg, data } = props;
    const prefix = namePrefix(config);
    const namespace = `${config.env}.evtivity.internal`;
    const internal = (name: ServiceName): string => `${discoveryName(name)}.${namespace}`;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: prefix,
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
            OCPP_SERVER_URL: `ws://${internal('ocpp')}:8080`,
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
            OCPP_SERVER_URL: `ws://${internal('ocpp')}:8080`,
            CSMS_URL: urls.csms,
            PORTAL_URL: urls.portal,
          });
          break;
        case 'css':
          Object.assign(environment, {
            OCPP_SERVER_URL: `ws://${internal('ocpp')}:8080`,
            OCPP_TLS_SERVER_URL: `wss://${internal('ocpp')}:${String(ocppTlsPort ?? 8443)}`,
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
      this.ocppNlb = this.addOcppTlsNlb(config, props, ocpp, ocppTlsPort);
    }

    if (config.ecs.redeployEveryDays > 0) this.addScheduledRedeploys(config);

    if (config.monitoring.dashboard || config.monitoring.alarms) {
      new Monitoring(this, 'Monitoring', {
        config,
        clusterName: this.cluster.clusterName,
        alb: props.alb,
        services: this.services,
      });
    }

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
  ): elbv2.NetworkLoadBalancer {
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
    return nlb;
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

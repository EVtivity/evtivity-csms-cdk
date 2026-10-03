// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { App } from 'aws-cdk-lib';
import type { Config } from './config/index.js';
import { AlbStack } from './stacks/alb-stack.js';
import { AppStack } from './stacks/app-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { DomainStack } from './stacks/domain-stack.js';
import { NetworkStack } from './stacks/network-stack.js';
import { StorageStack } from './stacks/storage-stack.js';
import { manageLambdaLogGroups } from './lambda-logs.js';
import { tagStack } from './tagging.js';
import { appBucketName, stackPrefix } from './util.js';

export interface EvtivityStacks {
  network: NetworkStack;
  domain: DomainStack;
  storage: StorageStack;
  data: DataStack;
  alb: AlbStack;
  app: AppStack;
}

/**
 * Adds every stack for one environment to the app. `updatedDate` becomes
 * the UpdatedDate tag.
 */
export function buildApp(app: App, config: Config, updatedDate: string): EvtivityStacks {
  const env = { account: config.account, region: config.region };
  const prefix = stackPrefix(config);
  const d = stackDescriptions(config);

  const domain = new DomainStack(app, `${prefix}-Domain`, {
    env,
    config,
    description: d.domain,
  });

  const storage = new StorageStack(app, `${prefix}-Storage`, {
    env,
    config,
    description: d.storage,
  });

  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    config,
    logsBucket: storage.logsBucket,
    description: d.network,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    config,
    vpc: network.vpc,
    ecsSg: network.ecsSg,
    rotationSg: network.rotationSg,
    description: d.data,
  });

  const alb = new AlbStack(app, `${prefix}-Alb`, {
    env,
    config,
    vpc: network.vpc,
    albSg: network.albSg,
    hostedZone: domain.hostedZone,
    logsBucket: storage.logsBucket,
    description: d.alb,
  });

  const appStack = new AppStack(app, `${prefix}-App`, {
    env,
    config,
    vpc: network.vpc,
    ecsSg: network.ecsSg,
    ...(network.nlbSg != null && { nlbSg: network.nlbSg }),
    ...(network.observabilitySg != null && { observabilitySg: network.observabilitySg }),
    natIds: network.natIds,
    alb: alb.alb,
    httpsListener: alb.httpsListener,
    httpListener: alb.httpListener,
    hostedZone: domain.hostedZone,
    appBucketName: appBucketName(config),
    data: {
      dbHost: data.cluster.clusterEndpoint.hostname,
      dbPort: '5432',
      dbName: data.databaseName,
      masterSecret: data.masterSecret,
      appDbSecret: data.appDbSecret,
      cacheHost: data.cacheHost,
      cachePort: data.cachePort,
      cacheSecret: data.cacheSecret,
      jwtSecret: data.jwtSecret,
      settingsKeySecret: data.settingsKeySecret,
      initialAdminSecret: data.initialAdminSecret,
      postgresLogs: data.postgresLogs,
      valkeySlowLog: data.valkeySlowLog,
    },
    description: d.app,
  });

  // The app stack names the bucket directly instead of importing it.
  appStack.addStackDependency(storage);

  for (const stack of [network, domain, storage, data, alb, appStack]) {
    manageLambdaLogGroups(stack, config);
  }

  tagStack(network, config, 'network', updatedDate);
  tagStack(domain, config, 'domain', updatedDate);
  tagStack(storage, config, 'storage', updatedDate);
  tagStack(data, config, 'data', updatedDate);
  tagStack(alb, config, 'load-balancer', updatedDate);
  tagStack(appStack, config, 'app', updatedDate);

  return { network, domain, storage, data, alb, app: appStack };
}

/**
 * CloudFormation stack descriptions. Built from the config so each one lists
 * only what that environment deploys.
 */
function stackDescriptions(config: Config): Record<keyof EvtivityStacks, string> {
  const obs = config.observability.enabled;
  const list = (items: (string | false)[]): string =>
    `EVtivity ${config.env}: ${items.filter((i): i is string => i !== false).join(', ')}`;

  return {
    network: list([
      'VPC with public, private, and isolated subnets',
      config.vpc.nat.mode === 'fck-nat' ? 'fck-nat instance' : 'NAT gateways',
      'S3 gateway endpoint',
      config.vpc.interfaceEndpoints.length > 0 && 'interface endpoints',
      'flow logs',
      'security groups',
    ]),
    domain: list([
      'Route 53 hosted zone reference',
      'superseded wildcard ACM certificate, removed in the next release',
    ]),
    storage: list([
      'S3 buckets for load balancer access logs',
      'application files',
      obs && 'Grafana provisioning',
    ]),
    data: list([
      `Aurora PostgreSQL ${config.aurora.mode === 'serverless' ? 'Serverless v2 ' : ''}cluster`,
      'ElastiCache Valkey with RBAC users',
      'application secrets',
      config.rotation.enabled && 'credential rotation',
    ]),
    alb: list([
      'Application Load Balancer with HTTPS listener and HTTP redirect',
      'ACM certificate for the service hostnames, validated in Route 53',
      (config.waf.enabled || obs) && 'WAF web ACL',
      config.waf.enabled && 'managed rules and rate limiting',
      obs && 'Grafana IP allowlist',
    ]),
    app: list([
      'ECS Fargate cluster',
      'database job',
      config.seedDemo.enabled && 'demo data seed',
      'services',
      'Route 53 records',
      config.ocppTls.enabled && 'OCPP TLS network load balancer',
      'alerts topic',
      (config.monitoring.dashboard || config.monitoring.alarms) && 'CloudWatch monitoring',
      obs && 'observability (Prometheus, Grafana)',
      config.ecs.redeployEveryDays > 0 && 'scheduled redeploys',
    ]),
  };
}

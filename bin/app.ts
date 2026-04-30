#!/usr/bin/env node
// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { App, Tags } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { StorageStack } from '../lib/stacks/storage-stack.js';
import { DomainStack } from '../lib/stacks/domain-stack.js';
import { AlbStack } from '../lib/stacks/alb-stack.js';
import { EcsStack } from '../lib/stacks/ecs-stack.js';
import { MonitoringStack } from '../lib/stacks/monitoring-stack.js';
import { isValidEnv, loadConfig } from '../lib/config/index.js';

const app = new App();

const envContext = (app.node.tryGetContext('env') as string | undefined) ?? process.env['CDK_ENV'];
if (envContext == null || !isValidEnv(envContext)) {
  throw new Error(
    `--context env=<env> required (one of: dev, qa, prod). Got: ${String(envContext)}`,
  );
}

const config = loadConfig(envContext);
const cdkEnv = { account: config.account, region: config.region };
const prefix = `Evtivity-${config.env.charAt(0).toUpperCase() + config.env.slice(1)}`;

// Derive runtime URLs for the SPAs and the CORS allow-list for the API from
// the public services declared in the YAML. Same pattern as Helm derives from
// gatewayAPI.routes; operators do not have to set these manually.
const zoneApex =
  config.domain.subdomain === ''
    ? config.domain.apex
    : `${config.domain.subdomain}.${config.domain.apex}`;
const serviceUrls: Record<string, string> = {};
for (const [name, sc] of Object.entries(config.services)) {
  if (!sc.public || sc.hostnamePrefix == null) continue;
  const host = `${sc.hostnamePrefix}.${zoneApex}`;
  serviceUrls[name] = name === 'ocpp' ? `wss://${host}` : `https://${host}`;
}

const runtimeUrls = {
  RUNTIME_API_URL: serviceUrls['api'] ?? '',
  RUNTIME_PORTAL_URL: serviceUrls['portal'] ?? '',
  RUNTIME_CSMS_URL: serviceUrls['csms'] ?? '',
  RUNTIME_OCPP_URL: serviceUrls['ocpp'] ?? '',
};

if (config.services['csms']) {
  Object.assign(config.services['csms'].env, runtimeUrls);
}
if (config.services['portal']) {
  Object.assign(config.services['portal'].env, runtimeUrls);
}
if (config.services['api'] && config.services['api'].env['CORS_ORIGIN'] == null) {
  const corsOrigins = [serviceUrls['csms'], serviceUrls['portal']].filter(Boolean).join(',');
  if (corsOrigins.length > 0) {
    config.services['api'].env['CORS_ORIGIN'] = corsOrigins;
  }
}

const network = new NetworkStack(app, `${prefix}-Network`, {
  env: cdkEnv,
  config,
  description: `${config.env} VPC, security groups, VPC endpoints, flow logs`,
});

const domain = new DomainStack(app, `${prefix}-Domain`, {
  env: cdkEnv,
  config,
  description: `${config.env} Route 53 hosted zone reference and ACM certificate`,
});

const storage = new StorageStack(app, `${prefix}-Storage`, {
  env: cdkEnv,
  config,
  description: `${config.env} S3 buckets`,
});

const data = new DataStack(app, `${prefix}-Data`, {
  env: cdkEnv,
  config,
  vpc: network.vpc,
  auroraSg: network.auroraSg,
  redisSg: network.redisSg,
  description: `${config.env} Aurora PostgreSQL Serverless v2 and ElastiCache Redis`,
});
data.addDependency(network);

const alb = new AlbStack(app, `${prefix}-Alb`, {
  env: cdkEnv,
  config,
  vpc: network.vpc,
  albSg: network.albSg,
  certificate: domain.certificate,
  accessLogsBucket: storage.albAccessLogsBucket,
  description: `${config.env} ALB with WAF`,
});
alb.addDependency(network);
alb.addDependency(domain);
alb.addDependency(storage);

const ecs = new EcsStack(app, `${prefix}-Ecs`, {
  env: cdkEnv,
  config,
  vpc: network.vpc,
  ecsSg: network.ecsSg,
  albSg: network.albSg,
  httpsListener: alb.httpsListener,
  hostedZone: domain.hostedZone,
  alb: alb.alb,
  zoneApex: domain.zoneApex,
  description: `${config.env} ECS cluster and Fargate services`,
});
ecs.addDependency(network);
ecs.addDependency(alb);
ecs.addDependency(domain);
ecs.addDependency(data);

if (config.monitoring.enabled) {
  const monitoring = new MonitoringStack(app, `${prefix}-Monitoring`, {
    env: cdkEnv,
    config,
    cluster: ecs.cluster,
    alb: alb.alb,
    description: `${config.env} CloudWatch dashboard and AMP workspace`,
  });
  monitoring.addDependency(ecs);
  monitoring.addDependency(alb);
}

// Apply common tags to every stack
for (const [k, v] of Object.entries(config.tags)) {
  Tags.of(app).add(k, v);
}

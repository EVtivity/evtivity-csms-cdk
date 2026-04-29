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

// Apply common tags to every stack
for (const [k, v] of Object.entries(config.tags)) {
  Tags.of(app).add(k, v);
}

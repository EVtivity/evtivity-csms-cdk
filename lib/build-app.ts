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

  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    config,
    description: `EVtivity ${config.env}: VPC, NAT, flow logs, security groups`,
  });

  const domain = new DomainStack(app, `${prefix}-Domain`, {
    env,
    config,
    description: `EVtivity ${config.env}: ACM certificate`,
  });

  const storage = new StorageStack(app, `${prefix}-Storage`, {
    env,
    config,
    description: `EVtivity ${config.env}: S3 buckets`,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    config,
    vpc: network.vpc,
    ecsSg: network.ecsSg,
    rotationSg: network.rotationSg,
    description: `EVtivity ${config.env}: Aurora PostgreSQL, Valkey, secrets, rotation`,
  });

  const alb = new AlbStack(app, `${prefix}-Alb`, {
    env,
    config,
    vpc: network.vpc,
    albSg: network.albSg,
    certificate: domain.certificate,
    logsBucket: storage.logsBucket,
    description: `EVtivity ${config.env}: application load balancer and WAF`,
  });

  const appStack = new AppStack(app, `${prefix}-App`, {
    env,
    config,
    vpc: network.vpc,
    ecsSg: network.ecsSg,
    ...(network.nlbSg != null && { nlbSg: network.nlbSg }),
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
    },
    description: `EVtivity ${config.env}: ECS cluster, database job, services, DNS`,
  });

  // The app stack names the bucket directly instead of importing it.
  appStack.addStackDependency(storage);

  tagStack(network, config, 'network', updatedDate);
  tagStack(domain, config, 'domain', updatedDate);
  tagStack(storage, config, 'storage', updatedDate);
  tagStack(data, config, 'data', updatedDate);
  tagStack(alb, config, 'load-balancer', updatedDate);
  tagStack(appStack, config, 'app', updatedDate);

  return { network, domain, storage, data, alb, app: appStack };
}

// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The prod sizing preset gives a lower environment prod's sizing and topology
// and keeps the environment's identity and safety settings.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app.js';
import { loadConfig, type LoadConfigOptions } from '../lib/config/load.js';
import type { Config } from '../lib/config/schema.js';
import { sizingOf } from '../lib/config/sizing.js';

const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

/** Committed dev.yaml and prod.yaml plus the given dev.local.yaml. */
function loadDev(local: string, options: LoadConfigOptions = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'evt-sizing-'));
  copyFileSync('config/dev.yaml', join(dir, 'dev.yaml'));
  copyFileSync('config/prod.yaml', join(dir, 'prod.yaml'));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  return loadConfig('dev', dir, options);
}

const PROD = loadConfig('prod', 'config', { includeLocal: false });
const DEV = loadConfig('dev', 'config', { includeLocal: false });

/** Identity and safety values the preset must never change. */
function identityOf(c: Config): unknown {
  return {
    env: c.env,
    account: c.account,
    region: c.region,
    image: c.image,
    domain: c.domain,
    tags: c.tags,
    createdDate: c.createdDate,
    vpc: { cidr: c.vpc.cidr, availabilityZones: c.vpc.availabilityZones },
    logs: c.logs,
    ecs: { executeCommand: c.ecs.executeCommand, redeployEveryDays: c.ecs.redeployEveryDays },
    aurora: {
      engineVersion: c.aurora.engineVersion,
      backupRetentionDays: c.aurora.backupRetentionDays,
      deletionProtection: c.aurora.deletionProtection,
      removal: c.aurora.removal,
    },
    valkey: { snapshotRetentionDays: c.valkey.snapshotRetentionDays },
    secrets: c.secrets,
    storage: c.storage,
    alb: c.alb,
    waf: { allowCountries: c.waf.allowCountries, logRetentionDays: c.waf.logRetentionDays },
    monitoring: c.monitoring,
    initialAdmin: c.initialAdmin,
    appSettings: c.appSettings,
    seedDemo: c.seedDemo,
    payments: c.payments,
    css: c.services.css,
    enabled: Object.fromEntries(Object.entries(c.services).map(([n, s]) => [n, s.enabled])),
  };
}

void describe('sizing preset', () => {
  void it('gives dev the sizing of prod.yaml and keeps dev identity', () => {
    const sized = loadDev('sizing: prod\n');
    assert.equal(sized.sizing, 'prod');
    assert.deepEqual(sizingOf(sized), sizingOf(PROD));
    assert.deepEqual(identityOf(sized), identityOf(DEV));
    // Spot checks of values prod gets from schema defaults, not prod.yaml.
    assert.equal(sized.services.csms.capacity, 'FARGATE');
    assert.equal(sized.services.api.autoscaling?.max, PROD.services.api.autoscaling?.max);
    assert.equal(sized.aurora.minCapacity, 1);
    assert.equal(sized.aurora.deletionProtection, false);
    assert.equal(sized.vpc.nat.mode, 'gateway');
    assert.equal(sized.ecs.executeCommand, true);
    assert.equal(sized.monitoring.alarms, false);
  });

  void it('takes the preset from --context and lets local values win', () => {
    assert.deepEqual(sizingOf(loadDev('', { sizing: 'prod' })), sizingOf(PROD));
    const overridden = loadDev(
      'sizing: prod\nwaf:\n  rateLimitPer5Min: 20000\nservices:\n  api:\n    cpu: 2048\n',
    );
    assert.equal(overridden.waf.rateLimitPer5Min, 20000);
    assert.equal(overridden.services.api.cpu, 2048);
    assert.equal(overridden.services.api.memoryMiB, PROD.services.api.memoryMiB);
  });

  void it('rejects unknown presets', () => {
    assert.throws(() => loadDev('sizing: large\n'), /sizing preset "large"/);
    assert.throws(() => loadDev('', { sizing: 'huge' }), /sizing preset "huge"/);
  });

  void it('leaves dev unchanged without a preset', () => {
    assert.equal(loadDev('').sizing, undefined);
    assert.deepEqual(sizingOf(loadDev('')), sizingOf(DEV));
  });

  void it('synthesizes dev resources at prod size under dev names', () => {
    const config = loadDev('sizing: prod\n');
    const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
    const stacks = buildApp(app, config, '2026-01-01');
    assert.equal(stacks.app.stackName, 'Evtivity-Dev-App');

    const network = Template.fromStack(stacks.network);
    network.resourceCountIs('AWS::EC2::NatGateway', 2);

    const data = Template.fromStack(stacks.data);
    data.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      ReplicationGroupId: 'evtivity-dev',
      CacheNodeType: 'cache.t4g.medium',
      NumCacheClusters: 2,
      MultiAZEnabled: true,
      AutomaticFailoverEnabled: true,
    });
    data.resourceCountIs('AWS::RDS::DBInstance', 2);
    data.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: false,
      ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 16 },
    });

    const appTemplate = Template.fromStack(stacks.app);
    appTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'evtivity-dev-worker',
      Cpu: '1024',
      Memory: '2048',
    });
    appTemplate.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'evtivity-dev-ocpp',
      CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
    });
  });
});

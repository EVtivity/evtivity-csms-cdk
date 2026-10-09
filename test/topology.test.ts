// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Valkey replicas, interface endpoints, NAT ids, and worker scaling.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildApp, type EvtivityStacks } from '../lib/build-app.js';
import { loadConfig } from '../lib/config/load.js';
import { configSchema, type Config, type EnvName } from '../lib/config/schema.js';
import { applyNagSuppressions } from '../lib/nag-suppressions.js';

const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

/** Committed config of `env` with `edit` applied, validated again by the schema. */
function configOf(env: EnvName, edit: (c: Config) => void = () => undefined): Config {
  const config = structuredClone(loadConfig(env, 'config', { includeLocal: false }));
  edit(config);
  return configSchema.parse(config);
}

function build(config: Config): EvtivityStacks {
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  return buildApp(app, config, '2026-01-01');
}

/** Synthesizes with cdk-nag like `cdk synth`, which fails on any unacknowledged finding. */
function assertNagClean(config: Config): void {
  const outdir = mkdtempSync(join(tmpdir(), 'evt-topology-'));
  const app = new App({ outdir, context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  buildApp(app, config, '2026-01-01');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  applyNagSuppressions(app, config);
  try {
    assert.doesNotThrow(() => app.synth());
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

void describe('valkey replicas', () => {
  void it('turns Multi-AZ on with replicas by default', () => {
    Template.fromStack(build(configOf('prod')).data).hasResourceProperties(
      'AWS::ElastiCache::ReplicationGroup',
      { NumCacheClusters: 2, MultiAZEnabled: true, AutomaticFailoverEnabled: true },
    );
    Template.fromStack(build(configOf('dev')).data).hasResourceProperties(
      'AWS::ElastiCache::ReplicationGroup',
      { NumCacheClusters: 1, MultiAZEnabled: false, AutomaticFailoverEnabled: false },
    );
  });

  void it('adds replicas without Multi-AZ for the first step of an in-place change', () => {
    const config = configOf('dev', (c) => {
      c.valkey.replicas = 1;
      c.valkey.multiAz = false;
    });
    Template.fromStack(build(config).data).hasResourceProperties(
      'AWS::ElastiCache::ReplicationGroup',
      {
        NumCacheClusters: 2,
        MultiAZEnabled: false,
        AutomaticFailoverEnabled: false,
        // Setting AZs would replace the group, so they are never set.
        PreferredCacheClusterAZs: Match.absent(),
      },
    );
  });

  void it('rejects Multi-AZ without a replica', () => {
    assert.throws(
      () =>
        configOf('dev', (c) => {
          c.valkey.multiAz = true;
        }),
      /replicas of 1 or more/,
    );
  });
});

void describe('interface endpoints', () => {
  void it('allow HTTPS from the VPC CIDR only and pass cdk-nag', () => {
    const config = configOf('prod', (c) => {
      c.vpc.interfaceEndpoints = ['secretsmanager', 'logs', 'ecr', 'ecr.dkr'];
    });
    assertNagClean(config);
    const network = Template.fromStack(build(config).network);
    network.resourceCountIs('AWS::EC2::VPCEndpoint', 5);
    network.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'EVtivity VPC interface endpoints',
      SecurityGroupIngress: [
        { CidrIp: '10.30.0.0/16', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' },
      ],
    });
    const json = JSON.stringify(network.toJSON());
    assert.ok(!json.includes('"CidrIp":"0.0.0.0/0","Description":"HTTPS from the VPC"'));
  });
});

void describe('NAT ids', () => {
  for (const env of ['dev', 'prod'] as const) {
    void it(`${env}: the App stack reads NAT ids from SSM, not a stack export`, () => {
      const stacks = build(configOf(env));
      const network = Template.fromStack(stacks.network);
      network.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/evtivity/${env}/network/nat-ids`,
        Type: 'StringList',
      });
      const app = Template.fromStack(stacks.app).toJSON() as {
        Parameters?: Record<string, { Type: string; Default?: string }>;
      };
      const json = JSON.stringify(app);
      assert.ok(!/ImportValue[^}]*(NatGateway|NatInstance)/.test(json), 'NAT id imported');
      const param = Object.values(app.Parameters ?? {}).find(
        (p) => p.Default === `/evtivity/${env}/network/nat-ids`,
      );
      assert.equal(param?.Type, 'AWS::SSM::Parameter::Value<List<String>>');
    });
  }
});

void describe('worker scaling', () => {
  void it('prod runs the worker on 1 vCPU and scales it from 1 to 4 tasks', () => {
    const app = Template.fromStack(build(configOf('prod')).app);
    app.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'evtivity-prod-worker',
      Cpu: '1024',
      Memory: '2048',
    });
    const targets = app.findResources('AWS::ApplicationAutoScaling::ScalableTarget');
    const worker = Object.entries(targets).find(([id]) => id.startsWith('Svcworker'));
    assert.ok(worker != null, 'no worker scalable target');
    const props = (worker[1] as { Properties: { MinCapacity: number; MaxCapacity: number } })
      .Properties;
    assert.equal(props.MinCapacity, 1);
    assert.equal(props.MaxCapacity, 4);
  });
});

// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Synthesizes every environment and asserts the Security Hub (AWS
// Foundational Security Best Practices) controls that apply to resources in
// these stacks. Accepted gaps are asserted too, so an exception that gets
// fixed or widened shows up as a failing test. See
// docs/compliance-exceptions.md.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { App, type Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app.js';
import type { Config, EnvName } from '../lib/config/schema.js';
import { loadConfig } from '../lib/config/load.js';

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

const ENVS: EnvName[] = ['dev', 'qa', 'prod'];

// Same feature flags as `cdk synth`.
const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

function synth(env: EnvName): {
  config: Config;
  resources: Resources;
  templates: Record<string, Template>;
} {
  // Tests use only the committed base config, never a developer's local file.
  const config = loadConfig(env, 'config', { includeLocal: false });
  // Skip Lambda bundling: templates are what the tests inspect.
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  const stacks = buildApp(app, config, '2026-01-01');
  const templates: Record<string, Template> = {};
  const resources: Resources = {};
  const named: [string, Stack][] = [
    ['network', stacks.network],
    ['domain', stacks.domain],
    ['storage', stacks.storage],
    ['data', stacks.data],
    ['alb', stacks.alb],
    ['app', stacks.app],
  ];
  for (const [name, stack] of named) {
    const template = Template.fromStack(stack);
    templates[name] = template;
    Object.assign(resources, template.toJSON()['Resources'] as Resources);
  }
  return { config, resources, templates };
}

function ofType(resources: Resources, type: string): Record<string, unknown>[] {
  return Object.values(resources)
    .filter((r) => r.Type === type)
    .map((r) => r.Properties ?? {});
}

interface Container {
  Name: string;
  User?: string;
  ReadonlyRootFilesystem?: boolean;
  Privileged?: boolean;
  LogConfiguration?: unknown;
  Environment?: { Name: string }[];
}

for (const env of ENVS) {
  void describe(`${env} environment`, () => {
    const { config, resources } = synth(env);

    void it('S3: blocks public access, encrypts, requires TLS, and has lifecycle rules (S3.1/5/8/13)', () => {
      const buckets = ofType(resources, 'AWS::S3::Bucket');
      // logs and app, plus grafana and loki with observability.
      assert.equal(buckets.length, config.observability.enabled ? 4 : 2);
      for (const b of buckets) {
        assert.deepEqual(b['PublicAccessBlockConfiguration'], {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        assert.ok(b['BucketEncryption'], 'bucket encryption');
        assert.ok(b['LifecycleConfiguration'], 'lifecycle rules');
        assert.deepEqual(b['OwnershipControls'], {
          Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
        });
      }
      const policies = JSON.stringify(ofType(resources, 'AWS::S3::BucketPolicy'));
      assert.match(policies, /"aws:SecureTransport":"false"/);
      // S3.9: the app bucket logs access to the logs bucket.
      assert.ok(
        buckets.some((b) => b['LoggingConfiguration'] != null),
        'server access logging',
      );
    });

    void it('RDS: encrypted, private, logs exported, TLS forced, monitored (RDS.2/6/9/12/16/24/27/35)', () => {
      const [cluster] = ofType(resources, 'AWS::RDS::DBCluster');
      assert.ok(cluster);
      assert.equal(cluster['StorageEncrypted'], true);
      assert.equal(cluster['CopyTagsToSnapshot'], true);
      assert.equal(cluster['EnableIAMDatabaseAuthentication'], true);
      assert.deepEqual(cluster['EnableCloudwatchLogsExports'], ['postgresql']);
      assert.equal(cluster['DeletionProtection'], config.aurora.deletionProtection);
      const [params] = ofType(resources, 'AWS::RDS::DBClusterParameterGroup');
      assert.equal((params?.['Parameters'] as Record<string, string>)['rds.force_ssl'], '1');
      for (const instance of ofType(resources, 'AWS::RDS::DBInstance')) {
        assert.equal(instance['PubliclyAccessible'], false);
        assert.equal(instance['AutoMinorVersionUpgrade'], true);
        // RDS.6 is an instance-level control.
        assert.ok(Number(instance['MonitoringInterval']) > 0, 'RDS.6 enhanced monitoring');
      }
      const master = ofType(resources, 'AWS::SecretsManager::Secret').find((s) =>
        JSON.stringify(s['GenerateSecretString'] ?? {}).includes('evtivity_admin'),
      );
      assert.ok(master, 'master username is not the engine default (RDS.24)');
      if (env === 'prod') {
        assert.equal(cluster['DeletionProtection'], true, 'RDS.7 in prod');
        assert.ok(ofType(resources, 'AWS::RDS::DBInstance').length >= 2, 'RDS.15 multi-AZ in prod');
      }
    });

    void it('ElastiCache: encrypted in transit and at rest, RBAC, backups (ElastiCache.1/2/4/5/7)', () => {
      const [rg] = ofType(resources, 'AWS::ElastiCache::ReplicationGroup');
      assert.ok(rg);
      assert.equal(rg['Engine'], 'valkey');
      assert.equal(rg['AtRestEncryptionEnabled'], true);
      assert.equal(rg['TransitEncryptionEnabled'], true);
      assert.equal(rg['TransitEncryptionMode'], 'required');
      assert.equal(rg['AutoMinorVersionUpgrade'], true);
      assert.ok(Number(rg['SnapshotRetentionLimit']) >= 1);
      assert.ok(rg['UserGroupIds'], 'RBAC user group');
      assert.ok(rg['CacheSubnetGroupName'], 'custom subnet group');
      const [params] = ofType(resources, 'AWS::ElastiCache::ParameterGroup');
      assert.equal(
        (params?.['Properties'] as Record<string, string>)['maxmemory-policy'],
        'noeviction',
      );
      if (env === 'prod') {
        assert.equal(rg['AutomaticFailoverEnabled'], true, 'ElastiCache.3 in prod');
        assert.equal(rg['MultiAZEnabled'], true);
      }
    });

    void it('ECS: private tasks, read-only root, logging, no secrets in env, non-root Node (ECS.2/4/5/8/9/20)', () => {
      for (const svc of ofType(resources, 'AWS::ECS::Service')) {
        const net = svc['NetworkConfiguration'] as {
          AwsvpcConfiguration: { AssignPublicIp: string };
        };
        assert.equal(net.AwsvpcConfiguration.AssignPublicIp, 'DISABLED');
      }
      const [cluster] = ofType(resources, 'AWS::ECS::Cluster');
      assert.match(JSON.stringify(cluster?.['ClusterSettings']), /containerInsights/);
      for (const td of ofType(resources, 'AWS::ECS::TaskDefinition')) {
        for (const c of td['ContainerDefinitions'] as Container[]) {
          assert.equal(c.ReadonlyRootFilesystem, true, `${c.Name} read-only root`);
          assert.notEqual(c.Privileged, true);
          assert.ok(c.LogConfiguration, 'log configuration');
          for (const e of c.Environment ?? []) {
            assert.doesNotMatch(
              e.Name,
              /PASSWORD|SECRET|TOKEN|_KEY$/,
              `ECS.8: ${e.Name} must be a secret`,
            );
          }
        }
      }
      // EXC-002: only the nginx images run without a user. Every other
      // container, including init containers, runs as a non-root user.
      const expectedUser: Record<string, string> = {
        grafana: '472:0',
        provision: '472:0',
        prometheus: '65534:65534',
        loki: '10001:10001',
      };
      for (const td of ofType(resources, 'AWS::ECS::TaskDefinition')) {
        const family = String(td['Family']);
        for (const c of td['ContainerDefinitions'] as Container[]) {
          if (/-(csms|portal)$/.test(family)) {
            assert.equal(c.User, undefined, `${family} (EXC-002)`);
          } else {
            assert.equal(
              c.User,
              expectedUser[c.Name] ?? '1000',
              `${family}/${c.Name} runs as non-root`,
            );
          }
        }
      }
    });

    void it('Observability: AMP, encrypted EFS with backups, scoped Grafana access, log forwarding', () => {
      const o = config.observability;
      assert.equal(ofType(resources, 'AWS::APS::Workspace').length, o.enabled ? 1 : 0);
      const fileSystems = ofType(resources, 'AWS::EFS::FileSystem');
      assert.equal(fileSystems.length, o.enabled ? 1 : 0);
      for (const fs of fileSystems) {
        assert.equal(fs['Encrypted'], true, 'EFS.1');
        assert.deepEqual(fs['BackupPolicy'], { Status: 'ENABLED' }, 'EFS.2');
      }
      for (const ap of ofType(resources, 'AWS::EFS::AccessPoint')) {
        assert.ok(ap['PosixUser'], 'EFS.4 access point enforces a user');
        assert.notEqual(
          (ap['RootDirectory'] as { Path?: string } | undefined)?.Path ?? '/',
          '/',
          'EFS.3',
        );
      }
      if (!o.enabled) return;
      const grafanaRules = ofType(resources, 'AWS::ElasticLoadBalancingV2::ListenerRule').filter(
        (r) => JSON.stringify(r['Conditions']).includes(`${o.grafana.hostname}.`),
      );
      assert.equal(grafanaRules.length, o.grafana.allowedCidrs.length > 0 ? 1 : 0);
      for (const rule of grafanaRules) {
        assert.match(
          JSON.stringify(rule['Conditions']),
          /source-ip/,
          'Grafana is restricted by source IP',
        );
      }
      const enabledServices = Object.values(config.services).filter((s) => s.enabled).length;
      // Every service plus the database job, PostgreSQL, and Valkey.
      assert.equal(ofType(resources, 'AWS::Logs::SubscriptionFilter').length, enabledServices + 3);
    });

    void it('ELB: drops invalid headers, logs, redirects HTTP, TLS 1.2+ (ELB.1/4/5/6/13)', () => {
      const [alb] = ofType(resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer').filter(
        (lb) => lb['Type'] !== 'network',
      );
      const attrs = Object.fromEntries(
        (alb?.['LoadBalancerAttributes'] as { Key: string; Value: string }[]).map((a) => [
          a.Key,
          a.Value,
        ]),
      );
      assert.equal(attrs['routing.http.drop_invalid_header_fields.enabled'], 'true');
      assert.equal(attrs['access_logs.s3.enabled'], 'true');
      assert.equal(attrs['deletion_protection.enabled'], String(config.alb.deletionProtection));
      const listeners = ofType(resources, 'AWS::ElasticLoadBalancingV2::Listener');
      const http = listeners.find((l) => l['Port'] === 80);
      assert.match(JSON.stringify(http?.['DefaultActions']), /"Protocol":"HTTPS"/);
      const https = listeners.find((l) => l['Port'] === 443);
      assert.equal(https?.['SslPolicy'], 'ELBSecurityPolicy-TLS13-1-2-Res-2021-06');
      // EXC-001: targets use HTTP until images serve TLS.
      for (const tg of ofType(resources, 'AWS::ElasticLoadBalancingV2::TargetGroup')) {
        if (tg['Protocol'] !== 'TCP') assert.equal(tg['Protocol'], 'HTTP', 'EXC-001');
      }
      if (env === 'prod') assert.equal(attrs['deletion_protection.enabled'], 'true');
    });

    void it('WAF: enabled and logging where configured (WAF.11)', () => {
      const acls = ofType(resources, 'AWS::WAFv2::WebACL');
      assert.equal(acls.length, config.waf.enabled ? 1 : 0);
      assert.equal(
        ofType(resources, 'AWS::WAFv2::LoggingConfiguration').length,
        config.waf.enabled ? 1 : 0,
      );
      if (env !== 'dev') assert.equal(config.waf.enabled, true);
    });

    void it('NAT: private subnets have a working route to the internet', () => {
      if (config.vpc.nat.mode === 'gateway') {
        assert.equal(ofType(resources, 'AWS::EC2::NatGateway').length, config.vpc.nat.count);
        return;
      }
      const instances = ofType(resources, 'AWS::EC2::Instance');
      assert.equal(instances.length, config.vpc.nat.count);
      for (const instance of instances) {
        assert.equal(instance['SourceDestCheck'], false);
        const nics = instance['NetworkInterfaces'] as
          { AssociatePublicIpAddress?: boolean }[] | undefined;
        assert.equal(nics?.[0]?.AssociatePublicIpAddress, true, 'NAT instance needs a public IP');
      }
    });

    void it('VPC: flow logs on, default security group restricted (EC2.2/6)', () => {
      assert.equal(ofType(resources, 'AWS::EC2::FlowLog').length, 1);
      assert.equal(
        Object.values(resources).filter((r) => r.Type === 'Custom::VpcRestrictDefaultSG').length,
        1,
      );
      for (const subnet of ofType(resources, 'AWS::EC2::Subnet')) {
        assert.notEqual(subnet['MapPublicIpOnLaunch'], true, 'EC2.15');
      }
    });

    void it('Secrets: database and cache credentials rotate (SecretsManager.1)', () => {
      assert.equal(ofType(resources, 'AWS::SecretsManager::RotationSchedule').length, 3);
      const hosted = ofType(resources, 'AWS::SecretsManager::RotationSchedule').filter(
        (r) => r['HostedRotationLambda'] != null,
      );
      assert.equal(hosted.length, 2, 'Secrets Manager hosted rotation for the database secrets');
      assert.equal(ofType(resources, 'AWS::Serverless::Application').length, 0);
    });

    void it('Lambda: current runtime, none public (Lambda.1/2)', () => {
      for (const fn of ofType(resources, 'AWS::Lambda::Function')) {
        const runtime = fn['Runtime'];
        if (typeof runtime === 'string')
          // CDK's BucketDeployment runs on Python.
          assert.match(runtime, /^(nodejs(22|24)\.x|python3\.1[2-4])$/);
      }
      for (const perm of ofType(resources, 'AWS::Lambda::Permission')) {
        assert.notEqual(perm['Principal'], '*');
      }
    });

    void it('Tags: every taggable resource carries the standard tags', () => {
      const required = [
        'Environment',
        'Service',
        'Stack',
        'CreatedDate',
        'UpdatedDate',
        'Project',
        'ManagedBy',
      ];
      for (const [id, r] of Object.entries(resources)) {
        const tags = r.Properties?.['Tags'];
        if (!Array.isArray(tags)) continue;
        const keys = new Set((tags as { Key: string }[]).map((t) => t.Key));
        for (const key of required) {
          if (key === 'UpdatedDate' && r.Type === 'AWS::ECS::TaskDefinition') continue;
          assert.ok(keys.has(key), `${id} (${r.Type}) is missing ${key}`);
        }
        const envTag = (tags as { Key: string; Value: string }[]).find(
          (t) => t.Key === 'Environment',
        );
        assert.equal(envTag?.Value, env);
      }
    });
  });
}

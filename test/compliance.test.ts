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
import { serviceHost } from '../lib/util.js';

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

const ENVS: EnvName[] = ['dev', 'qa', 'prod'];

// Resource types that skip the UpdatedDate tag (see lib/tagging.ts).
const NO_UPDATED_DATE_TYPES = new Set([
  'AWS::ECS::TaskDefinition',
  'AWS::EC2::LaunchTemplate',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::ElastiCache::ReplicationGroup',
  'AWS::ElastiCache::User',
  'AWS::ElastiCache::UserGroup',
  'AWS::WAFv2::IPSet',
]);

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
    const { config, resources, templates } = synth(env);

    void it('Simulator: security profile 2 targets a listener that exists', () => {
      const css = ofType(resources, 'AWS::ECS::TaskDefinition')
        .flatMap((td) => (td['ContainerDefinitions'] as Container[] | undefined) ?? [])
        .find((c) => (c.Environment ?? []).some((e) => e.Name === 'CSS_MODE'));
      if (css == null) return;
      const env = (css.Environment ?? []) as { Name: string; Value?: unknown }[];
      const url = env.find((e) => e.Name === 'OCPP_TLS_SERVER_URL')?.Value;
      assert.equal(typeof url, 'string', 'OCPP_TLS_SERVER_URL is set');
      if (config.ocppTls.enabled) {
        assert.match(url as string, new RegExp(`:${String(config.ocppTls.port)}$`));
      } else {
        // No TLS listener on the OCPP task, so TLS goes through the load balancer.
        assert.match(url as string, /^wss:\/\/[^:]+$/);
      }
    });

    void it('Payments: api, ocpp and worker get the simulated provider gate, off by default', () => {
      const containers = ofType(resources, 'AWS::ECS::TaskDefinition')
        .flatMap((td) => (td['ContainerDefinitions'] as Container[] | undefined) ?? [])
        .filter((c) => (c.Environment ?? []).some((e) => e.Name === 'PAYMENTS_ALLOW_SIMULATED'));
      assert.ok(containers.length > 0, 'at least one service carries the gate');
      for (const c of containers) {
        const env = (c.Environment ?? []) as { Name: string; Value?: unknown }[];
        const value = env.find((e) => e.Name === 'PAYMENTS_ALLOW_SIMULATED')?.Value;
        assert.equal(value, String(config.payments.allowSimulatedProvider));
        if (config.env === 'prod') assert.equal(value, 'false');
      }
    });

    void it('ECS: services are deleted before the capacity provider association', () => {
      const entries = Object.entries(resources);
      const association = entries.find(
        ([, r]) => r.Type === 'AWS::ECS::ClusterCapacityProviderAssociations',
      )?.[0];
      assert.ok(association, 'the cluster has a capacity provider association');
      for (const [id, r] of entries) {
        if (r.Type !== 'AWS::ECS::Service') continue;
        const deps = (r as { DependsOn?: string[] }).DependsOn ?? [];
        assert.ok(deps.includes(association), `${id} depends on ${association}`);
      }
    });

    void it('Lambda: every function logs to a managed log group with retention', () => {
      // Otherwise Lambda creates /aws/lambda/<name> on first run with no
      // retention, and it survives stack deletion.
      for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue;
        const logging = r.Properties?.['LoggingConfig'] as { LogGroup?: unknown } | undefined;
        assert.ok(logging?.LogGroup != null, `${id} has a managed log group`);
      }
      for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::Logs::LogGroup') continue;
        assert.ok(r.Properties?.['RetentionInDays'] != null, `${id} has a retention period`);
      }
    });

    void it('Lambda: custom resource handlers cannot recreate their log group after deletion', () => {
      // They run once more while their stack is deleted, and Lambda delivers
      // those logs with the function's role. A recreated group makes the next
      // deploy of the environment fail with "already exists".
      let guarded = 0;
      for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue;
        const logging = r.Properties?.['LoggingConfig'] as
          { LogGroup?: { Ref?: string } } | undefined;
        const logGroup = logging?.LogGroup?.Ref;
        if (logGroup == null || !logGroup.includes('ManagedLogs')) continue;
        const deps = (r as { DependsOn?: string[] }).DependsOn ?? [];
        assert.ok(deps.includes(logGroup), `${id} depends on ${logGroup}`);
        // The role too, so the group is deleted last and nothing can recreate it.
        const role = (r.Properties?.['Role'] as { 'Fn::GetAtt'?: [string, string] } | undefined)?.[
          'Fn::GetAtt'
        ]?.[0];
        assert.ok(role != null, `${id} has a role in this stack`);
        const roleDeps = (resources[role] as { DependsOn?: string[] } | undefined)?.DependsOn ?? [];
        assert.ok(roleDeps.includes(logGroup), `${role} depends on ${logGroup}`);
        guarded++;
      }
      assert.ok(guarded > 0, 'at least one custom resource handler is guarded');
    });

    void it('IAM: task roles grant Resource "*" only for ECS Exec', () => {
      // cdk-nag acknowledges IAM5 Resource::* on task roles for ECS Exec.
      // This keeps that acknowledgement from hiding any other wildcard grant.
      const execActions = new Set([
        'logs:DescribeLogGroups',
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ]);
      for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::IAM::Policy') continue;
        const doc0 = r.Properties?.['PolicyDocument'] as {
          Statement: { Action: string | string[]; Resource: unknown }[];
        };
        // The database job runner may list tasks in its cluster, nothing else.
        if (id.startsWith('DbJobOnEvent')) {
          for (const st of doc0.Statement) {
            if (st.Resource === '*') assert.deepEqual([st.Action].flat(), ['ecs:ListTasks'], id);
          }
          continue;
        }
        // Grafana may list log groups, read or stop its own queries, and read
        // metrics, none of which take a resource. Running queries is scoped separately.
        if (id.includes('SvcgrafanaTaskTaskRole')) {
          const grafanaWildcards = new Set([
            'logs:DescribeLogGroups',
            'logs:GetQueryResults',
            'logs:StopQuery',
            'cloudwatch:ListMetrics',
            'cloudwatch:GetMetricData',
          ]);
          for (const st of doc0.Statement) {
            if (st.Resource !== '*') continue;
            for (const action of [st.Action].flat()) {
              assert.ok(
                grafanaWildcards.has(action) ||
                  (config.ecs.executeCommand && execActions.has(action)),
                `${id} grants ${action} on all resources`,
              );
            }
          }
          continue;
        }
        if (!id.includes('TaskRole')) continue;
        const doc = r.Properties?.['PolicyDocument'] as {
          Statement: { Action: string | string[]; Resource: unknown }[];
        };
        for (const st of doc.Statement) {
          if (st.Resource !== '*') continue;
          for (const action of [st.Action].flat()) {
            assert.ok(
              config.ecs.executeCommand && execActions.has(action),
              `${id} grants ${action} on all resources`,
            );
          }
        }
      }
    });

    void it('Network: observability tasks cannot reach the data stores', () => {
      if (!config.observability.enabled) return;
      const sgsOf = (name: string): string[] => {
        const svc = ofType(resources, 'AWS::ECS::Service').find((r) =>
          JSON.stringify(r['ServiceName']).includes(`-${name}"`),
        );
        const net = svc?.['NetworkConfiguration'] as
          { AwsvpcConfiguration: { SecurityGroups: unknown[] } } | undefined;
        return (net?.AwsvpcConfiguration.SecurityGroups ?? []).map((g) => JSON.stringify(g));
      };
      const appSgs = sgsOf('api');
      assert.ok(appSgs.length > 0, 'api security groups found');
      for (const name of ['grafana', 'prometheus']) {
        const obs = sgsOf(name);
        assert.ok(obs.length > 0, `${name} security groups found`);
        assert.ok(
          obs.every((g) => !appSgs.includes(g)),
          `${name} must not use the app security group`,
        );
        // The database and cache accept only the app and rotation groups.
        for (const [id, r] of Object.entries(resources)) {
          if (r.Type !== 'AWS::EC2::SecurityGroupIngress') continue;
          const port = Number(r.Properties?.['FromPort']);
          if (port !== 5432 && port !== 6379) continue;
          const source = JSON.stringify(r.Properties?.['SourceSecurityGroupId']);
          assert.ok(!obs.some((g) => source.includes(g.replace(/"/g, ''))), `${id} admits ${name}`);
        }
      }
    });

    void it('WAF: protection rules match the services and config', () => {
      const [acl] = ofType(resources, 'AWS::WAFv2::WebACL');
      type Rule = {
        Name: string;
        Priority: number;
        Action?: Record<string, unknown>;
        Statement: Record<string, unknown>;
      };
      const rules = (acl?.['Rules'] ?? []) as Rule[];
      const byName = (name: string): Rule | undefined => rules.find((r) => r.Name === name);
      const text = (r: Rule | undefined): string => JSON.stringify(r?.Statement ?? {});
      const w = config.waf;
      const priorities = rules.map((r) => r.Priority);
      assert.equal(new Set(priorities).size, priorities.length, 'unique rule priorities');
      if (!w.enabled) {
        assert.ok(
          rules.every((r) => r.Name === 'GrafanaAllowList'),
          'only Grafana without WAF',
        );
        return;
      }
      const ocpp = config.services.ocpp.enabled ? serviceHost(config, 'ocpp') : undefined;
      const api = config.services.api.enabled ? serviceHost(config, 'api') : undefined;

      for (const group of [
        'AmazonIpReputationList',
        'AnonymousIpList',
        'CommonRuleSet',
        'KnownBadInputsRuleSet',
        'SQLiRuleSet',
        'LinuxRuleSet',
      ]) {
        assert.ok(byName(`AWS-AWSManagedRules${group}`), `${group} is attached`);
      }
      // Hosting providers only count: Stripe, OCPI partners, and IoT SIM
      // gateways run there.
      assert.match(
        text(byName('AWS-AWSManagedRulesAnonymousIpList')),
        /\{"ActionToUse":\{"Count":\{\}\},"Name":"HostingProviderIPList"\}/,
      );

      // Stripe: allowed only on the webhook path and only from the IP set.
      const stripe = byName('StripeWebhookAllow');
      assert.equal(Boolean(stripe), api != null && w.stripeWebhookIps.length > 0);
      if (stripe) {
        assert.deepEqual(stripe.Action, { Allow: {} });
        assert.match(
          text(stripe),
          /"PositionalConstraint":"EXACTLY","SearchString":"\/v1\/webhooks\/payments\/stripe"/,
        );
        assert.match(text(stripe), /IPSetReferenceStatement/);
        const geoRule = byName('GeoAllow');
        if (geoRule) assert.ok(stripe.Priority < geoRule.Priority, 'Stripe before country rule');
        const set = ofType(resources, 'AWS::WAFv2::IPSet').find((s) =>
          String(s['Name']).endsWith('-stripe-webhooks'),
        );
        assert.deepEqual(set?.['Addresses'], w.stripeWebhookIps);
      }

      // Stations behind carrier NAT or roaming SIMs: the OCPP host skips every
      // address-based rule and has its own rate limit.
      const geo = byName('GeoAllow');
      assert.equal(Boolean(geo), w.allowCountries.length > 0);
      if (geo) assert.ok(text(geo).includes(`"CountryCodes":${JSON.stringify(w.allowCountries)}`));
      if (ocpp) {
        for (const name of [
          'GeoAllow',
          'AWS-AWSManagedRulesAmazonIpReputationList',
          'AWS-AWSManagedRulesAnonymousIpList',
          'RateLimitPerIp',
        ]) {
          const r = byName(name);
          if (!r) continue;
          assert.ok(
            text(r).includes(
              `{"NotStatement":{"Statement":{"ByteMatchStatement":{"FieldToMatch":{"SingleHeader":{"Name":"host"}},"PositionalConstraint":"STARTS_WITH","SearchString":"${ocpp}"`,
            ),
            `${name} exempts the OCPP host`,
          );
        }
        assert.match(text(byName('OcppWebSocketOnly')), /"Name":"upgrade"/);
        assert.match(
          text(byName('OcppRateLimitPerIp')),
          new RegExp(`"Limit":${String(w.ocppRateLimitPer5Min)}`),
        );
      }

      // Adyen publishes no IP ranges and sends from outside the allowed
      // countries: the exact webhook POST skips the country rule and has its
      // own rate limit. Every other API path stays behind the country rule.
      const adyenPath = '"SearchString":"/v1/webhooks/payments/adyen"';
      const adyen = byName('AdyenWebhookRateLimit');
      assert.equal(Boolean(adyen), api != null);
      if (api) {
        const limit = text(adyen);
        assert.match(limit, new RegExp(`"Limit":${String(w.adyenWebhookRateLimitPer5Min)}`));
        for (const s of ['"SearchString":"POST"', `"SearchString":"${api}"`]) {
          assert.ok(limit.includes(s), `Adyen limit matches ${s}`);
        }
        assert.ok(limit.includes(`"PositionalConstraint":"EXACTLY",${adyenPath}`), 'exact path');
        if (geo) {
          const geoText = text(geo);
          assert.ok(
            geoText.includes(`{"NotStatement":{"Statement":{"AndStatement":{"Statements":[`),
            'GeoAllow exempts the Adyen webhook',
          );
          assert.ok(geoText.includes(adyenPath), 'GeoAllow names the Adyen path');
          assert.ok(!geoText.includes('/v1/webhooks/payments/stripe'), 'Stripe is not geo exempt');
        }
      } else if (geo) {
        assert.ok(!text(geo).includes(adyenPath));
      }

      // Path limits count POSTs only, and never token refresh or logout.
      if (api) {
        const auth = text(byName('AuthRateLimitPerIp'));
        assert.match(auth, new RegExp(`"Limit":${String(w.authRateLimitPer5Min)}`));
        for (const s of ['/v1/auth/', '/v1/portal/auth/', '/refresh', '/logout', 'POST']) {
          assert.ok(auth.includes(`"SearchString":"${s}"`), `auth limit mentions ${s}`);
        }
        const guest = text(byName('GuestRateLimitPerIp'));
        assert.match(guest, new RegExp(`"Limit":${String(w.guestRateLimitPer5Min)}`));
        assert.ok(guest.includes('"SearchString":"/v1/portal/guest/"'));
        assert.ok(guest.includes('"SearchString":"POST"'));
      }
      const statics = byName('StaticSiteMethods');
      assert.equal(
        Boolean(statics),
        config.services.csms.enabled || config.services.portal.enabled,
      );
    });

    void it('Stack descriptions: list only what the environment deploys', () => {
      const has = (type: string): boolean => ofType(resources, type).length > 0;
      const desc = (name: string): string => String(templates[name]?.toJSON()['Description'] ?? '');
      assert.equal(desc('storage').includes('Grafana'), config.observability.enabled);
      assert.equal(desc('alb').includes('WAF web ACL'), has('AWS::WAFv2::WebACL'));
      assert.equal(desc('alb').includes('managed rules'), config.waf.enabled);
      assert.equal(
        desc('app').includes('network load balancer'),
        ofType(resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer').some(
          (lb) => lb['Type'] === 'network',
        ),
      );
      assert.equal(desc('app').includes('Grafana'), config.observability.enabled);
      assert.equal(desc('app').includes('demo data'), has('Custom::EvtivitySeedDemo'));
      assert.equal(
        desc('network').includes('fck-nat'),
        ofType(resources, 'AWS::EC2::NatGateway').length === 0,
      );
      for (const name of Object.keys(templates)) {
        assert.match(desc(name), new RegExp(`^EVtivity ${env}: `));
      }
    });

    void it('S3: blocks public access, encrypts, requires TLS, and has lifecycle rules (S3.1/5/8/13)', () => {
      const buckets = ofType(resources, 'AWS::S3::Bucket');
      // logs and app, plus grafana with observability.
      assert.equal(buckets.length, config.observability.enabled ? 3 : 2);
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
      // S3.5 per bucket: each one has its own policy denying plain HTTP.
      const entries = Object.entries(resources);
      const bucketIds = entries.filter(([, r]) => r.Type === 'AWS::S3::Bucket').map(([id]) => id);
      for (const id of bucketIds) {
        const policy = entries.find(
          ([, r]) =>
            r.Type === 'AWS::S3::BucketPolicy' &&
            JSON.stringify(r.Properties?.['Bucket']).includes(`"${id}"`),
        );
        assert.ok(policy, `${id} has a bucket policy`);
        assert.match(
          JSON.stringify(policy[1].Properties),
          /"aws:SecureTransport":"false"/,
          `${id} denies plain HTTP`,
        );
      }
      // S3.9: every bucket except the logs bucket itself logs access to it.
      const logTargets = buckets.filter((b) => b['LoggingConfiguration'] == null);
      assert.equal(logTargets.length, 1, 'only the logs bucket has no access logging');
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
      // Every container, including init containers, runs as a non-root user.
      const expectedUser: Record<string, string> = {
        grafana: '472:0',
        provision: '472:0',
        prometheus: '65534:65534',
      };
      for (const td of ofType(resources, 'AWS::ECS::TaskDefinition')) {
        const family = String(td['Family']);
        const nginx = /-(csms|portal)$/.test(family);
        for (const c of td['ContainerDefinitions'] as Container[]) {
          assert.equal(
            c.User,
            expectedUser[c.Name] ?? (nginx ? '101' : '1000'),
            `${family}/${c.Name} runs as non-root`,
          );
        }
      }
    });

    void it('Observability: AMP, encrypted EFS with backups, scoped Grafana access, CloudWatch logs', () => {
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
      // grafana.<zone> always routes to Grafana. The web ACL blocks every
      // source outside the allowlist IP set.
      const grafanaRules = ofType(resources, 'AWS::ElasticLoadBalancingV2::ListenerRule').filter(
        (r) => JSON.stringify(r['Conditions']).includes(`${o.grafana.hostname}.`),
      );
      assert.equal(grafanaRules.length, 1);
      const grafanaService = ofType(resources, 'AWS::ECS::Service').find((svc) =>
        String(svc['ServiceName']).endsWith('-grafana'),
      );
      assert.ok(
        Number(grafanaService?.['HealthCheckGracePeriodSeconds']) >= 300,
        'first-start migrations',
      );
      const [ipSet] = ofType(resources, 'AWS::WAFv2::IPSet');
      assert.deepEqual(ipSet?.['Addresses'], o.grafana.allowedCidrs);
      const [acl] = ofType(resources, 'AWS::WAFv2::WebACL');
      const aclRules = acl?.['Rules'] as { Name: string; Statement: unknown }[];
      const grafanaWaf = aclRules.find((r) => r.Name === 'GrafanaAllowList');
      assert.ok(grafanaWaf, 'web ACL has the Grafana allowlist rule');
      assert.match(JSON.stringify(grafanaWaf.Statement), /IPSetReferenceStatement/);
      // A port or trailing dot in the Host header must not skip the block.
      assert.match(JSON.stringify(grafanaWaf.Statement), /"PositionalConstraint":"STARTS_WITH"/);
      // Grafana reads logs from CloudWatch directly. No second log store.
      assert.equal(ofType(resources, 'AWS::Logs::SubscriptionFilter').length, 0);
      assert.ok(
        !ofType(resources, 'AWS::ECS::Service').some((svc) =>
          String(svc['ServiceName']).endsWith('-loki'),
        ),
        'no Loki service',
      );
      // Logs Insights access is scoped to this environment's log groups:
      // every service plus the database job, PostgreSQL, and Valkey.
      const enabledServices = Object.values(config.services).filter((s) => s.enabled).length;
      const grafanaPolicy = Object.entries(resources).find(
        ([id, r]) => r.Type === 'AWS::IAM::Policy' && id.includes('SvcgrafanaTaskTaskRole'),
      )?.[1];
      const statements = (
        grafanaPolicy?.Properties?.['PolicyDocument'] as {
          Statement: { Action: string | string[]; Resource: unknown }[];
        }
      ).Statement;
      const startQuery = statements.find((st) => [st.Action].flat().includes('logs:StartQuery'));
      assert.equal([startQuery?.Resource].flat().length, enabledServices + 3);
      assert.ok(!JSON.stringify(startQuery?.Resource).includes('"*"'), 'StartQuery is scoped');
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

    void it('ACM: the ALB certificate names every host exactly, with OCPP as the common name', () => {
      // Stations reject a wildcard CSMS certificate by default
      // (AllowCSMSTLSWildcards / AllowCentralSystemTLSWildcards = false).
      const alb = templates['alb']?.toJSON()['Resources'] as Resources;
      const https = ofType(alb, 'AWS::ElasticLoadBalancingV2::Listener').find(
        (l) => l['Port'] === 443,
      );
      const certs = https?.['Certificates'] as { CertificateArn: unknown }[];
      assert.equal(certs.length, 1);
      const ref = (certs[0]?.CertificateArn as { Ref?: string }).Ref;
      assert.ok(ref != null, 'the listener certificate is defined in the ALB stack');
      const cert = alb[ref];
      assert.ok(cert, `${ref} exists in the ALB stack`);
      assert.equal(cert.Type, 'AWS::CertificateManager::Certificate');
      const commonName = cert.Properties?.['DomainName'] as string;
      const names = [
        commonName,
        ...((cert.Properties?.['SubjectAlternativeNames'] as string[] | undefined) ?? []),
      ];
      for (const name of names) assert.ok(!name.includes('*'), `${name} is not a wildcard`);

      if (config.services.ocpp.enabled) assert.equal(commonName, serviceHost(config, 'ocpp'));
      // Every DNS record on the ALB is covered. The OCPP TLS record points at
      // the NLB, where the OCPP server presents its own certificate.
      const tlsHost = `${config.ocppTls.hostname}.`;
      const records = ofType(resources, 'AWS::Route53::RecordSet')
        .filter((r) => r['Type'] === 'A')
        .map((r) => String(r['Name']).replace(/\.$/, ''))
        .filter((name) => !name.startsWith(tlsHost));
      assert.ok(records.length > 0);
      assert.deepEqual([...records].sort(), [...names].sort());

      // The OCPP TLS NLB passes TCP through and never terminates TLS.
      for (const l of ofType(resources, 'AWS::ElasticLoadBalancingV2::Listener')) {
        if (l['Port'] !== 443 && l['Port'] !== 80) {
          assert.equal(l['Protocol'], 'TCP');
          assert.equal(l['Certificates'], undefined);
        }
      }
    });

    void it('WAF: enabled and logging where configured (WAF.11)', () => {
      const acls = ofType(resources, 'AWS::WAFv2::WebACL');
      const aclExpected = config.waf.enabled || config.observability.enabled ? 1 : 0;
      assert.equal(acls.length, aclExpected);
      assert.equal(ofType(resources, 'AWS::WAFv2::LoggingConfiguration').length, aclExpected);
      const managed = JSON.stringify(acls).includes('AWSManagedRulesCommonRuleSet');
      assert.equal(managed, config.waf.enabled, 'managed rule groups follow waf.enabled');
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

    void it('Alerts: topic on a rotating customer key, rotation failures alert', () => {
      const [topic] = ofType(resources, 'AWS::SNS::Topic');
      assert.match(
        JSON.stringify(topic?.['KmsMasterKeyId']),
        /AlertsKey/,
        'topic uses the customer key',
      );
      const keys = ofType(resources, 'AWS::KMS::Key');
      assert.ok(keys.length >= 1);
      for (const key of keys) assert.equal(key['EnableKeyRotation'], true, 'KMS.4');
      const policy = JSON.stringify(keys);
      assert.match(policy, /cloudwatch\.amazonaws\.com/);
      assert.match(policy, /events\.amazonaws\.com/);
      const rule = ofType(resources, 'AWS::Events::Rule').find((r) =>
        JSON.stringify(r['EventPattern']).includes('RotationFailed'),
      );
      assert.ok(rule, 'rotation failure rule exists');
      assert.match(JSON.stringify(rule['EventPattern']), new RegExp(`secret:evtivity/${env}/`));
    });

    void it('ECS Exec: works with read-only root filesystems and logs every session', () => {
      const services = ofType(resources, 'AWS::ECS::Service');
      const [cluster] = ofType(resources, 'AWS::ECS::Cluster');
      const clusterConfig = JSON.stringify(cluster?.['Configuration'] ?? {});
      for (const svc of services) {
        assert.equal(Boolean(svc['EnableExecuteCommand']), config.ecs.executeCommand);
      }
      for (const td of ofType(resources, 'AWS::ECS::TaskDefinition')) {
        const family = String(td['Family']);
        if (family.endsWith('-db-job') || family.endsWith('-seed-demo')) continue;
        const [main] = td['ContainerDefinitions'] as (Container & {
          MountPoints?: { ContainerPath: string; ReadOnly?: boolean }[];
        })[];
        assert.ok(main, `${family} has a container`);
        assert.equal(main.ReadonlyRootFilesystem, true, `${family} keeps a read-only root`);
        const paths = (main.MountPoints ?? [])
          .filter((m) => m.ReadOnly === false)
          .map((m) => m.ContainerPath);
        for (const path of ['/var/lib/amazon', '/var/log/amazon']) {
          assert.equal(paths.includes(path), config.ecs.executeCommand, `${family} ${path}`);
        }
      }
      if (config.ecs.executeCommand) {
        assert.match(clusterConfig, /"Logging":"OVERRIDE"/);
        assert.match(clusterConfig, /CloudWatchLogGroupName/);
      } else {
        assert.doesNotMatch(clusterConfig, /ExecuteCommandConfiguration/);
      }
    });

    void it('Demo seed: one-time, keyed on revision, generated password, never in prod', () => {
      const demo = ofType(resources, 'Custom::EvtivitySeedDemo');
      assert.equal(demo.length, config.seedDemo.enabled ? 1 : 0);
      if (env === 'prod') assert.equal(config.seedDemo.enabled, false);
      const [run] = demo;
      if (run == null) return;
      // A family name, not a revision ARN, so image and setting changes do not rerun it.
      assert.equal(run['TaskDefinitionArn'], `evtivity-${env}-seed-demo`);
      assert.equal(run['Revision'], String(config.seedDemo.revision));
      const td = ofType(resources, 'AWS::ECS::TaskDefinition').find(
        (t) => t['Family'] === `evtivity-${env}-seed-demo`,
      );
      const [main] = (td?.['ContainerDefinitions'] ?? []) as {
        ReadonlyRootFilesystem?: boolean;
        Secrets?: { Name: string }[];
        Environment?: { Name: string; Value: string }[];
      }[];
      assert.ok(main, 'demo task has a container');
      assert.equal(main.ReadonlyRootFilesystem, true);
      assert.ok(main.Secrets?.some((s) => s.Name === 'DEMO_PASSWORD'));
      const limit = main.Environment?.find((e) => e.Name === 'DEMO_STATION_LIMIT');
      assert.equal(limit?.Value, String(config.seedDemo.stationLimit));
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
      // Types that take a Tags list. A resource of these types without tags fails.
      const mustTag = new Set([
        'AWS::S3::Bucket',
        'AWS::EC2::VPC',
        'AWS::EC2::SecurityGroup',
        'AWS::ECS::Cluster',
        'AWS::ECS::Service',
        'AWS::ECS::TaskDefinition',
        'AWS::RDS::DBCluster',
        'AWS::ElastiCache::ReplicationGroup',
        'AWS::ElastiCache::User',
        'AWS::Lambda::Function',
        'AWS::IAM::Role',
        'AWS::SecretsManager::Secret',
        'AWS::Logs::LogGroup',
        'AWS::SNS::Topic',
        'AWS::KMS::Key',
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        'AWS::WAFv2::IPSet',
      ]);
      for (const [id, r] of Object.entries(resources)) {
        const tags = r.Properties?.['Tags'];
        if (!Array.isArray(tags)) {
          assert.ok(!mustTag.has(r.Type), `${id} (${r.Type}) has no tags`);
          continue;
        }
        const keys = new Set((tags as { Key: string }[]).map((t) => t.Key));
        for (const key of required) {
          if (key === 'UpdatedDate' && NO_UPDATED_DATE_TYPES.has(r.Type)) {
            assert.ok(!keys.has(key), `${id} (${r.Type}) must not carry UpdatedDate`);
            continue;
          }
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

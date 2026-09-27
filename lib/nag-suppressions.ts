// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Validations, type App } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { Config } from './config/index.js';
import { appBucketName, namePrefix } from './util.js';

interface Acknowledgement {
  /** Matched against the construct path, e.g. `Evtivity-Dev-App/Svc-api/Task/Resource`. */
  path: RegExp;
  ids: (config: Config) => string[];
  reason: string;
  /** Only applies when this returns true for the environment's config. */
  when?: (config: Config) => boolean;
}

const LAMBDA_BASIC =
  'arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const LAMBDA_VPC =
  'arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole';
const RDS_MONITORING =
  'arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole';

// Every finding cdk-nag raises is either fixed in code or acknowledged here
// with its reason. Findings tied to a Security Hub control reference the
// exception register in docs/compliance-exceptions.md.
const ACKNOWLEDGEMENTS: Acknowledgement[] = [
  {
    path: /\/AlbSg\/Resource$/,
    ids: () => ['AwsSolutions-EC23'],
    reason:
      'Public ALB: ports 443 and 80 (redirect only) accept any IPv4 source. WAF filters requests when enabled.',
  },
  {
    path: /\/Vpc\/NatSecurityGroup\/Resource$/,
    ids: () => ['AwsSolutions-EC23'],
    reason:
      'The NAT instance accepts forwarded traffic from the VPC CIDR only, on all ports, which NAT requires.',
  },
  {
    path: /\/Vpc\/publicSubnet\d+\/NatInstance\/Resource$/,
    ids: () => ['AwsSolutions-EC26'],
    reason:
      'The root volume is encrypted through a BlockDeviceMappings property override, which cdk-nag cannot see.',
  },
  {
    path: /\/Vpc\/publicSubnet\d+\/NatInstance\/Resource$/,
    ids: () => ['AwsSolutions-EC28', 'AwsSolutions-EC29', 'CloudFormation-Validate::W9010'],
    reason:
      'fck-nat instance in lower environments (EXC-005). Basic 5-minute metrics are enough, CDK must be able to ' +
      'replace the instance, and the AMI id is pinned per region in config so synth is deterministic.',
  },
  {
    path: /\/(Svc-[A-Za-z]+|DbJob)\/Task\/Resource$/,
    ids: () => ['AwsSolutions-ECS2'],
    reason:
      'Environment variables hold only non-secret values (ports, hostnames, URLs, flags). Every credential ' +
      'comes from Secrets Manager through the secrets field (ECS.8).',
  },
  {
    path: /\/Svc-[A-Za-z]+\/Task\/TaskRole\/DefaultPolicy\/Resource$/,
    ids: () => ['AwsSolutions-IAM5[Resource::*]'],
    reason:
      'ECS Exec uses ssmmessages channel actions, which do not support resource-level permissions.',
    when: (c) => c.ecs.executeCommand,
  },
  {
    path: /\/Svc-(api|worker)\/Task\/TaskRole\/DefaultPolicy\/Resource$/,
    ids: (c) => [`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${appBucketName(c)}/*]`],
    reason: 'Object actions on the app bucket only. Object keys are generated per upload.',
  },
  {
    path: /\/ServiceRole\/Resource$/,
    ids: () => [
      `AwsSolutions-IAM4[Policy::${LAMBDA_BASIC}]`,
      `AwsSolutions-IAM4[Policy::${LAMBDA_VPC}]`,
    ],
    reason:
      'AWS-published Lambda service role policies, limited to CloudWatch Logs and VPC network interfaces.',
  },
  {
    path: /\/Aurora\/MonitoringRole\/Resource$/,
    ids: () => [`AwsSolutions-IAM4[Policy::${RDS_MONITORING}]`],
    reason: 'AWS-published role policy that RDS Enhanced Monitoring requires (RDS.6).',
  },
  {
    path: /\/CacheRotationFn\/ServiceRole\/DefaultPolicy\/Resource$/,
    ids: () => ['AwsSolutions-IAM5[Resource::*]'],
    reason:
      'secretsmanager:GetRandomPassword and the VPC network interface actions do not support resource ARNs.',
  },
  {
    path: /\/DbJob\/IsComplete\/ServiceRole\/DefaultPolicy\/Resource$/,
    ids: (c) => [
      `AwsSolutions-IAM5[Resource::arn:aws:ecs:${c.region}:${c.account}:task/${namePrefix(c)}/*]`,
    ],
    reason:
      'DescribeTasks is limited to tasks in this cluster. Task ids are generated at run time.',
  },
  {
    path: /\/DbJob\/Provider\//,
    ids: () => [
      'AwsSolutions-IAM5[Resource::<DbJobIsComplete96F1B61D.Arn>:*]',
      'AwsSolutions-IAM5[Resource::<DbJobOnEventBAA78E0E.Arn>:*]',
      'AwsSolutions-IAM5[Resource::<DbJobProviderframeworkisComplete0F99488F.Arn>:*]',
      'AwsSolutions-IAM5[Resource::<DbJobProviderframeworkonTimeout71759A5B.Arn>:*]',
      'AwsSolutions-SF2',
      'AwsSolutions-IAM5[Resource::*]',
    ],
    reason:
      'CDK Provider framework internals: invoke permissions on function versions, CloudWatch Logs delivery ' +
      'actions (resource-level permissions unsupported) for the waiter state machine, which logs ALL events. ' +
      'X-Ray tracing adds nothing for a deploy-time poller.',
  },
  {
    path: /\/LogRetention[0-9a-f]+\/ServiceRole\/DefaultPolicy\/Resource$/,
    ids: () => ['AwsSolutions-IAM5[Resource::*]'],
    reason:
      'CDK LogRetention custom resource sets retention on log groups that RDS creates at run time.',
  },
  {
    path: /\/(JwtSecret|SettingsKeySecret|InitialAdminSecret)\/Resource$/,
    ids: () => ['AwsSolutions-SMG4'],
    reason:
      'Static application keys (EXC-003). Rotating them signs every user out or makes encrypted settings ' +
      'unreadable. The initial admin password must be changed at first sign-in.',
  },
  {
    path: /\/Aurora\/Resource$/,
    ids: () => ['AwsSolutions-RDS10'],
    reason: 'Deletion protection is off so the lower environment can be torn down (EXC-004).',
    when: (c) => !c.aurora.deletionProtection,
  },
  {
    path: /\/Valkey$/,
    ids: () => ['AwsSolutions-AEC6'],
    reason:
      'Valkey uses RBAC: a user group with a password user replaces the legacy AUTH token, and in-transit ' +
      'encryption is required. The rule only recognizes AUTH tokens.',
  },
  {
    path: /\/Valkey$/,
    ids: () => ['AwsSolutions-AEC4'],
    reason:
      'Single-node Valkey in a lower environment (EXC-004). Prod runs a replica with Multi-AZ failover.',
    when: (c) => c.valkey.replicas === 0,
  },
];

export function applyNagSuppressions(app: App, config: Config): void {
  const constructs: IConstruct[] = app.node.findAll();
  for (const ack of ACKNOWLEDGEMENTS) {
    if (ack.when != null && !ack.when(config)) continue;
    const ids = ack.ids(config);
    for (const c of constructs) {
      if (!ack.path.test(c.node.path)) continue;
      for (const id of ids) Validations.of(c).acknowledge({ id, reason: ack.reason });
    }
  }
}

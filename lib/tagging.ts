// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Aspects, CfnResource, TagManager, Tags, type IAspect, type Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { Config } from './config/index.js';

// A tag change on these resources is not a plain metadata update:
// - a task definition gets a new revision, restarting the service and
//   re-running the database job
// - a launch template gets a new version, replacing the NAT instance
// - an Aurora cluster or instance and a Valkey replication group go into a
//   modifying state that blocks other changes for minutes
// They carry every static tag, only not UpdatedDate.
const NO_UPDATED_DATE = [
  'AWS::ECS::TaskDefinition',
  'AWS::EC2::LaunchTemplate',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::ElastiCache::ReplicationGroup',
  // An update re-sends the full resource. For the Valkey user that resets its
  // passwords to the one in the template, dropping the previous password
  // that running tasks still use. For the Grafana IP set it replaces the
  // addresses added with scripts/grafana-access.sh.
  'AWS::ElastiCache::User',
  'AWS::ElastiCache::UserGroup',
  'AWS::WAFv2::IPSet',
];

/**
 * Tags every taggable resource in the app:
 * - Environment: dev, qa, or prod
 * - Stack: the stack name
 * - Service: the stack's role, or the EVtivity service for ECS resources
 * - CreatedDate: from config, fixed for the life of the environment
 * - UpdatedDate: the synth date (UTC day) of the deployment that last touched it
 * plus the extra tags from config (Project, ManagedBy, ...).
 */
export function tagStack(stack: Stack, config: Config, service: string, updatedDate: string): void {
  const tags = Tags.of(stack);
  for (const [key, value] of Object.entries(config.tags)) tags.add(key, value);
  tags.add('Environment', config.env);
  tags.add('Stack', stack.stackName);
  tags.add('Service', service);
  tags.add('CreatedDate', config.createdDate);
  tags.add('UpdatedDate', updatedDate, { excludeResourceTypes: NO_UPDATED_DATE });
  Aspects.of(stack).add(
    new RawResourceTags({
      ...config.tags,
      Environment: config.env,
      Stack: stack.stackName,
      Service: service,
      CreatedDate: config.createdDate,
      UpdatedDate: updatedDate,
    }),
  );
}

// CDK's internal custom resource providers (S3 auto-delete, default security
// group restriction) write their IAM role and Lambda function as raw
// CfnResource objects, which the Tags aspect skips. Tag them directly.
const RAW_TAGGABLE = new Set(['AWS::IAM::Role', 'AWS::Lambda::Function']);

class RawResourceTags implements IAspect {
  constructor(private readonly tags: Record<string, string>) {}

  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || TagManager.isTaggable(node)) return;
    if (!RAW_TAGGABLE.has(node.cfnResourceType)) return;
    node.addPropertyOverride(
      'Tags',
      Object.entries(this.tags).map(([Key, Value]) => ({ Key, Value })),
    );
  }
}

/** Overrides the Service tag for everything under one construct. */
export function tagService(scope: IConstruct, service: string): void {
  Tags.of(scope).add('Service', service);
}

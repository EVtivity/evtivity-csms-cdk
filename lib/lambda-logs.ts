// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CfnResource, type Stack, aws_lambda as lambda, aws_logs as logs } from 'aws-cdk-lib';
import type { Config } from './config/index.js';
import { removalPolicyOf } from './util.js';

/**
 * Gives every Lambda function in the stack a managed log group. A function
 * without one writes to /aws/lambda/<name>, which Lambda creates on first
 * run with no retention, and which stays behind when the stack is deleted.
 * That includes the handlers CDK generates for its own custom resources
 * (bucket auto-delete, default security group, bucket deployment), which
 * take no log group option. Run once per stack, after its constructs exist
 * and before tagging, so the new log groups are tagged too.
 */
export function manageLambdaLogGroups(stack: Stack, config: Config): void {
  for (const node of stack.node.findAll()) {
    if (!(node instanceof CfnResource) || node.cfnResourceType !== 'AWS::Lambda::Function') {
      continue;
    }
    if (node instanceof lambda.CfnFunction && node.loggingConfig != null) continue;

    const owner = node.node.scope;
    if (owner == null) continue;
    // Readable and unique per stack: the path of the construct that owns the function.
    const path = owner.node.path
      .split('/')
      .slice(1)
      .join('/')
      .replace(/[^A-Za-z0-9_./-]/g, '');
    const group = new logs.LogGroup(owner, 'ManagedLogs', {
      logGroupName: `/evtivity/${config.env}/lambda/${stack.stackName}/${path}`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });
    node.addPropertyOverride('LoggingConfig', { LogGroup: group.logGroupName });
  }
}

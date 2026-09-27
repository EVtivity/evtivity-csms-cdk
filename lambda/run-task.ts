// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom resource that runs a one-shot Fargate task (the database job) and
// waits for it to exit. CloudFormation fails the deployment when the task
// exits non-zero, so services never start against an unmigrated database.
// Uses the CDK Provider framework: onEvent starts the task, isComplete polls.

import { DescribeTasksCommand, ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

interface JobProperties {
  ClusterArn: string;
  TaskDefinitionArn: string;
  Subnets: string[];
  SecurityGroups: string[];
  ContainerName: string;
  LogGroupName: string;
}

interface ProviderEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: JobProperties & { ServiceToken: string };
  Data?: { TaskArn?: string };
}

const ecs = new ECSClient({});

export async function onEvent(
  event: ProviderEvent,
): Promise<{ PhysicalResourceId: string; Data?: object }> {
  const props = event.ResourceProperties;
  const physicalId =
    event.PhysicalResourceId ?? `db-job-${props.TaskDefinitionArn.split('/').pop() ?? 'task'}`;
  // Nothing to undo on delete: the job only changes data inside the database.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };

  const res = await ecs.send(
    new RunTaskCommand({
      cluster: props.ClusterArn,
      taskDefinition: props.TaskDefinitionArn,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'cloudformation',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: props.Subnets,
          securityGroups: props.SecurityGroups,
          assignPublicIp: 'DISABLED',
        },
      },
    }),
  );
  const taskArn = res.tasks?.[0]?.taskArn;
  if (taskArn == null) {
    const reasons = (res.failures ?? []).map((f) => `${f.arn ?? ''} ${f.reason ?? ''}`).join('; ');
    throw new Error(`RunTask started no task: ${reasons}`);
  }
  console.log(`started ${taskArn}`);
  return { PhysicalResourceId: physicalId, Data: { TaskArn: taskArn } };
}

export async function isComplete(
  event: ProviderEvent,
): Promise<{ IsComplete: boolean; Data?: object }> {
  if (event.RequestType === 'Delete') return { IsComplete: true };
  const props = event.ResourceProperties;
  const taskArn = event.Data?.TaskArn;
  if (taskArn == null) throw new Error('no TaskArn from onEvent');

  const res = await ecs.send(
    new DescribeTasksCommand({ cluster: props.ClusterArn, tasks: [taskArn] }),
  );
  const task = res.tasks?.[0];
  if (task == null) throw new Error(`task ${taskArn} not found`);
  if (task.lastStatus !== 'STOPPED') return { IsComplete: false };

  const container = task.containers?.find((c) => c.name === props.ContainerName);
  const exitCode = container?.exitCode;
  if (exitCode === 0) return { IsComplete: true, Data: { ExitCode: '0' } };

  const taskId = taskArn.split('/').pop() ?? taskArn;
  throw new Error(
    `database job ${taskId} failed: exit code ${String(exitCode)}, ` +
      `${task.stoppedReason ?? ''} ${container?.reason ?? ''}. ` +
      `Logs: ${props.LogGroupName}, stream db-job/app/${taskId}`,
  );
}

// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom resource that runs a one-shot Fargate task (the database job) and
// waits for it to exit. CloudFormation fails the deployment when the task
// exits non-zero, so services never start against an unmigrated database.
// Uses the CDK Provider framework: onEvent starts the task, isComplete polls.

import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type RunTaskCommandOutput,
} from '@aws-sdk/client-ecs';

interface JobProperties {
  ClusterArn: string;
  TaskDefinitionArn: string;
  Subnets: string[];
  SecurityGroups: string[];
  ContainerName: string;
  LogGroupName: string;
  /** Job name for the physical id, errors, and the log stream prefix. Default db-job. */
  JobName?: string;
  /** Task family, used to stop a run left over from an earlier deployment. */
  Family: string;
  /**
   * When set, an Update runs the task only if this value changed. Other
   * property changes (subnets, security groups) and rollbacks to the same
   * value are no-ops.
   */
  Revision?: string;
}

interface ProviderEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: JobProperties & { ServiceToken: string };
  OldResourceProperties?: Partial<JobProperties>;
  Data?: { TaskArn?: string; Skipped?: string };
}

const ecs = new ECSClient({});

export async function onEvent(
  event: ProviderEvent,
): Promise<{ PhysicalResourceId: string; Data?: object }> {
  const props = event.ResourceProperties;
  // TaskDefinitionArn may be a full revision ARN or a bare family name.
  const physicalId =
    event.PhysicalResourceId ??
    `${props.JobName ?? 'db-job'}-${props.TaskDefinitionArn.split('/').pop() ?? 'task'}`;
  // Nothing to undo on delete: the job only changes data inside the database.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };

  if (
    event.RequestType === 'Update' &&
    props.Revision != null &&
    event.OldResourceProperties?.Revision === props.Revision
  ) {
    console.log(`revision ${props.Revision} already ran, skipping`);
    return { PhysicalResourceId: physicalId, Data: { Skipped: 'true' } };
  }

  await stopLeftovers(props);
  const res = await runTask(props);
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
  if (event.RequestType === 'Delete' || event.Data?.Skipped === 'true') return { IsComplete: true };
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
  const job = props.JobName ?? 'db-job';
  throw new Error(
    `${job} ${taskId} failed: exit code ${String(exitCode)}, ` +
      `${task.stoppedReason ?? ''} ${container?.reason ?? ''}. ` +
      `Logs: ${props.LogGroupName}, stream ${job}/app/${taskId}`,
  );
}

// A run from a deployment that timed out keeps going after CloudFormation
// gives up. Stop it so two migrations never run at the same time.
async function stopLeftovers(props: JobProperties): Promise<void> {
  const running = await ecs.send(
    // ListTasks rejects startedBy combined with family. Only this custom
    // resource starts tasks in the job families, so the family is enough.
    new ListTasksCommand({
      cluster: props.ClusterArn,
      family: props.Family,
      desiredStatus: 'RUNNING',
    }),
  );
  for (const task of running.taskArns ?? []) {
    console.log(`stopping leftover ${task}`);
    await ecs.send(
      new StopTaskCommand({
        cluster: props.ClusterArn,
        task,
        reason: 'Superseded by a newer deployment',
      }),
    );
  }
}

// Fargate capacity errors are transient. Retry a few times before failing
// the deployment.
async function runTask(props: JobProperties): Promise<RunTaskCommandOutput> {
  const delays = [0, 5, 10, 20];
  let res: RunTaskCommandOutput | undefined;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
    res = await ecs.send(
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
    if (res.tasks?.[0]?.taskArn != null) return res;
    const reasons = (res.failures ?? []).map((f) => f.reason ?? '').join('; ');
    console.log(`RunTask started no task: ${reasons}`);
  }
  // Checked by the caller, which reports the last failure reasons.
  return res as RunTaskCommandOutput;
}

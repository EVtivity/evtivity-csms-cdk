// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { aws_ecs as ecs } from 'aws-cdk-lib';

// ECS Exec starts an SSM agent inside the container, and the agent writes its
// state and logs under these two directories. With a read-only root
// filesystem (ECS.5) the agent cannot start unless they are writable volumes.
// AWS documents read-only root as unsupported for ECS Exec. This layout is
// the approach AWS users report as working and was verified on Fargate in
// dev. If a future SSM agent needs another path, exec fails and the service
// keeps running.
const SSM_AGENT_PATHS = ['/var/lib/amazon', '/var/log/amazon'];

/**
 * Makes ECS Exec work on a container whose root filesystem stays read-only.
 * Call only when `ecs.executeCommand` is enabled.
 */
export function addExecVolumes(
  taskDefinition: ecs.TaskDefinition,
  container: ecs.ContainerDefinition,
): void {
  SSM_AGENT_PATHS.forEach((path, i) => {
    const volume = `ssm-agent${String(i)}`;
    taskDefinition.addVolume({ name: volume });
    container.addMountPoints({ containerPath: path, sourceVolume: volume, readOnly: false });
  });
}

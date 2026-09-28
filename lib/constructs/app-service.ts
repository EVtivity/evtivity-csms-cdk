// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SERVICE_CATALOG, discoveryName, type ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { tagService } from '../tagging.js';
import { addExecVolumes } from './exec-support.js';
import { namePrefix, removalPolicyOf, serviceHost } from '../util.js';

export interface AppServiceProps {
  name: ServiceName;
  config: Config;
  cluster: ecs.ICluster;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  environment: Record<string, string>;
  secrets: Record<string, ecs.Secret>;
  httpsListener: elbv2.IApplicationListener;
  httpListener: elbv2.IApplicationListener;
  /** Extra container port, e.g. the OCPP TLS listener behind the NLB. */
  extraPort?: number;
}

/** Scratch paths each image writes to. The root filesystem is read-only. */
const WRITABLE_PATHS: Record<'node' | 'nginx', string[]> = {
  node: ['/tmp'],
  nginx: ['/tmp', '/run', '/var/cache/nginx'],
};

/**
 * One EVtivity service on Fargate: task definition, service, autoscaling,
 * Cloud Map name, and (for public services) an ALB target group with a
 * host-header rule.
 */
export class AppService extends Construct {
  readonly service: ecs.FargateService;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly logGroup: logs.LogGroup;
  readonly targetGroup?: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);
    const { name, config } = props;
    tagService(this, name);
    const spec = SERVICE_CATALOG[name];
    const sc = config.services[name];

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/evtivity/${config.env}/${name}`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      family: `${namePrefix(config)}-${name}`,
      cpu: sc.cpu,
      memoryLimitMiB: sc.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const repository = sc.imageRepository ?? `${config.image.registry}/${spec.component}`;
    const tag = sc.imageTag ?? config.image.tag;

    const ports = new Set<number>();
    if (spec.port != null) ports.add(spec.port);
    if (spec.health != null) ports.add(spec.health.port);
    if (props.extraPort != null) ports.add(props.extraPort);

    const user = sc.user ?? (spec.kind === 'node' ? '1000' : undefined);
    const container = this.taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(`${repository}:${tag}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup: this.logGroup }),
      environment: props.environment,
      secrets: props.secrets,
      portMappings: [...ports].map((p) => ({
        containerPort: p,
        protocol: ecs.Protocol.TCP,
        name: `p${String(p)}`,
      })),
      readonlyRootFilesystem: true,
      privileged: false,
      essential: true,
      stopTimeout: Duration.seconds(sc.stopTimeoutSeconds),
      linuxParameters: new ecs.LinuxParameters(this, 'Linux', { initProcessEnabled: true }),
      ...(user != null && { user }),
      ...(spec.health != null && { healthCheck: containerHealthCheck(spec.kind, spec.health) }),
    });
    for (const [i, path] of WRITABLE_PATHS[spec.kind].entries()) {
      const volume = `scratch${String(i)}`;
      this.taskDefinition.addVolume({ name: volume });
      container.addMountPoints({ containerPath: path, sourceVolume: volume, readOnly: false });
    }
    if (config.ecs.executeCommand) addExecVolumes(this.taskDefinition, container);

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${namePrefix(config)}-${name}`,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: sc.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      capacityProviderStrategies: [{ capacityProvider: sc.capacity, weight: 1 }],
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: config.ecs.executeCommand,
      // Start the replacement before stopping the old task, so a
      // single-task service never drops to zero during a deployment.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      ...(spec.public && { healthCheckGracePeriod: Duration.seconds(90) }),
      cloudMapOptions: { name: discoveryName(name), dnsTtl: Duration.seconds(10) },
    });

    if (sc.autoscaling != null) {
      const a = sc.autoscaling;
      const scaling = this.service.autoScaleTaskCount({ minCapacity: a.min, maxCapacity: a.max });
      scaling.scaleOnCpuUtilization('Cpu', {
        targetUtilizationPercent: a.cpuTargetPercent,
        scaleInCooldown: Duration.seconds(a.scaleInCooldownSeconds),
        scaleOutCooldown: Duration.seconds(a.scaleOutCooldownSeconds),
      });
      scaling.scaleOnMemoryUtilization('Memory', {
        targetUtilizationPercent: a.memoryTargetPercent,
        scaleInCooldown: Duration.seconds(a.scaleInCooldownSeconds),
        scaleOutCooldown: Duration.seconds(a.scaleOutCooldownSeconds),
      });
    }

    if (spec.public && spec.port != null) {
      const host = serviceHost(config, name);
      if (host == null) throw new Error(`public service ${name} has no hostname`);
      const protocol =
        sc.targetProtocol === 'HTTPS'
          ? elbv2.ApplicationProtocol.HTTPS
          : elbv2.ApplicationProtocol.HTTP;
      this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
        vpc: props.vpc,
        port: spec.port,
        protocol,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(sc.deregistrationDelaySeconds),
        healthCheck: {
          protocol: sc.targetProtocol === 'HTTPS' ? elbv2.Protocol.HTTPS : elbv2.Protocol.HTTP,
          path: spec.health?.path ?? '/',
          port: String(spec.health?.port ?? spec.port),
          healthyHttpCodes: '200',
          interval: Duration.seconds(15),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        ...(sc.stickinessSeconds > 0 && {
          stickinessCookieDuration: Duration.seconds(sc.stickinessSeconds),
        }),
      });
      this.service.attachToApplicationTargetGroup(this.targetGroup);

      const priority = spec.priority ?? 1000;
      new elbv2.ApplicationListenerRule(this, 'HttpsRule', {
        listener: props.httpsListener,
        priority,
        conditions: [elbv2.ListenerCondition.hostHeaders([host])],
        action: elbv2.ListenerAction.forward([this.targetGroup]),
      });
      if (name === 'ocpp' && config.alb.ocppPlainWs) {
        // ws:// for security profiles 0 and 1 (EXC-007).
        new elbv2.ApplicationListenerRule(this, 'HttpRule', {
          listener: props.httpListener,
          priority,
          conditions: [elbv2.ListenerCondition.hostHeaders([host])],
          action: elbv2.ListenerAction.forward([this.targetGroup]),
        });
      }
    }
  }
}

function containerHealthCheck(
  kind: 'node' | 'nginx',
  health: { port: number; path: string },
): ecs.HealthCheck {
  const url = `http://127.0.0.1:${String(health.port)}${health.path}`;
  // node:24-slim has no curl or wget; nginx:alpine ships busybox wget.
  const command =
    kind === 'node'
      ? `node -e "fetch('${url}').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"`
      : `wget -q -O /dev/null ${url} || exit 1`;
  return {
    command: ['CMD-SHELL', command],
    interval: Duration.seconds(30),
    timeout: Duration.seconds(5),
    retries: 3,
    startPeriod: Duration.seconds(60),
  };
}

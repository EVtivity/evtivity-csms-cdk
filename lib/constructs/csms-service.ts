// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { Config, ServiceConfig } from '../config/index.js';

export interface CsmsServiceProps {
  serviceName: string;
  serviceConfig: ServiceConfig;
  config: Config;
  cluster: ecs.ICluster;
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  albSg: ec2.ISecurityGroup;
  httpsListener?: elbv2.IApplicationListener;
  zoneApex: string;
}

export class CsmsService extends Construct {
  readonly service: ecs.FargateService;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: CsmsServiceProps) {
    super(scope, id);

    const { serviceName, serviceConfig, config, cluster, vpc, ecsSg, albSg, httpsListener, zoneApex } =
      props;
    const isProd = config.env === 'prod';

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/evtivity/${config.env}/${serviceName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      family: `evtivity-${config.env}-${serviceName}`,
      cpu: serviceConfig.cpu,
      memoryLimitMiB: serviceConfig.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Resolve secrets and SSM params
    const ecsSecrets: Record<string, ecs.Secret> = {};
    for (const [envKey, secretRef] of Object.entries(serviceConfig.secretsFromSecretsManager)) {
      const [secretName, jsonField] = secretRef.split(':');
      const secret = secretsmanager.Secret.fromSecretNameV2(
        this,
        `Sec_${envKey}`,
        secretName ?? secretRef,
      );
      ecsSecrets[envKey] =
        jsonField != null && jsonField !== ''
          ? ecs.Secret.fromSecretsManager(secret, jsonField)
          : ecs.Secret.fromSecretsManager(secret);
    }
    for (const [envKey, paramName] of Object.entries(serviceConfig.envFromSsm)) {
      const param = ssm.StringParameter.fromStringParameterName(this, `Ssm_${envKey}`, paramName);
      ecsSecrets[envKey] = ecs.Secret.fromSsmParameter(param);
    }

    const portMappings: ecs.PortMapping[] =
      serviceConfig.containerPort != null
        ? [{ containerPort: serviceConfig.containerPort, protocol: ecs.Protocol.TCP }]
        : [];

    this.taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(`${serviceConfig.imageRepo}:${serviceConfig.imageTag}`),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: serviceName,
        logGroup: this.logGroup,
      }),
      environment: serviceConfig.env,
      secrets: ecsSecrets,
      portMappings,
      readonlyRootFilesystem: serviceConfig.readonlyRootFilesystem,
      essential: true,
      ...(serviceConfig.containerPort != null && {
        healthCheck: {
          command: [
            'CMD-SHELL',
            `wget -q --spider http://127.0.0.1:${String(serviceConfig.containerPort)}${serviceConfig.healthCheckPath} || exit 1`,
          ],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(30),
        },
      }),
    });

    // Service or one-shot task definition
    if (serviceConfig.isOneShot) {
      // Standalone task definition only; deployed via aws ecs run-task or a CI step.
      // Expose nothing to ALB.
      this.service = new ecs.FargateService(this, 'Service', {
        cluster,
        taskDefinition: this.taskDefinition,
        desiredCount: 0,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ecsSg],
        platformVersion: ecs.FargatePlatformVersion.LATEST,
        circuitBreaker: { rollback: true },
        enableExecuteCommand: !isProd,
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      });
      return;
    }

    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: serviceConfig.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [ecsSg],
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: !isProd,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    // Autoscaling
    if (serviceConfig.maxCount > serviceConfig.minCount) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: serviceConfig.minCount,
        maxCapacity: serviceConfig.maxCount,
      });
      scaling.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: 70,
        scaleInCooldown: Duration.seconds(120),
        scaleOutCooldown: Duration.seconds(60),
      });
      scaling.scaleOnMemoryUtilization('MemScaling', {
        targetUtilizationPercent: 75,
        scaleInCooldown: Duration.seconds(120),
        scaleOutCooldown: Duration.seconds(60),
      });
    }

    // Allow ALB SG to reach this service's container port
    if (serviceConfig.containerPort != null) {
      ecsSg.addIngressRule(
        albSg,
        ec2.Port.tcp(serviceConfig.containerPort),
        `ALB to ${serviceName}`,
      );
    }

    // Wire to ALB if public
    if (serviceConfig.public && httpsListener != null && serviceConfig.containerPort != null) {
      const hostname = `${serviceConfig.hostnamePrefix ?? serviceName}.${zoneApex}`;
      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
        vpc,
        port: serviceConfig.containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(30),
        healthCheck: {
          path: serviceConfig.healthCheckPath,
          healthyHttpCodes: serviceConfig.healthCheckHttpCode,
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
      this.service.attachToApplicationTargetGroup(targetGroup);

      new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
        listener: httpsListener,
        priority: serviceConfig.albPriority ?? 1000,
        conditions: [elbv2.ListenerCondition.hostHeaders([hostname])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    // Task role: minimal, services can extend via grant calls in app.ts wiring.
    if (this.taskDefinition.taskRole instanceof iam.Role) {
      // Placeholder so tagging/inspection knows it exists.
    }
  }
}

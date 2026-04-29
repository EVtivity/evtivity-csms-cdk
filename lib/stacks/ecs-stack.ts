// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  CfnOutput,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import { CsmsService } from '../constructs/csms-service.js';

export interface EcsStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  albSg: ec2.ISecurityGroup;
  httpsListener: elbv2.IApplicationListener;
  hostedZone: route53.IHostedZone;
  alb: elbv2.IApplicationLoadBalancer;
  zoneApex: string;
}

export class EcsStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly services: Record<string, CsmsService> = {};

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { config, vpc, ecsSg, albSg, httpsListener, hostedZone, alb, zoneApex } = props;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `evtivity-${config.env}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
    });

    // Build each enabled service
    for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
      if (!serviceConfig.enabled) continue;

      this.services[serviceName] = new CsmsService(this, serviceName, {
        serviceName,
        serviceConfig,
        config,
        cluster: this.cluster,
        vpc,
        ecsSg,
        albSg,
        httpsListener,
        zoneApex,
      });

      // DNS record for public services
      if (serviceConfig.public && serviceConfig.hostnamePrefix != null) {
        new route53.ARecord(this, `${serviceName}AliasRecord`, {
          zone: hostedZone,
          recordName: `${serviceConfig.hostnamePrefix}.${zoneApex}`,
          target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(alb)),
        });
      }
    }

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}

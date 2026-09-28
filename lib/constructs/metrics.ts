// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  aws_cloudwatch as cw,
  type aws_elasticloadbalancingv2 as elbv2,
} from 'aws-cdk-lib';
import type { Config } from '../config/index.js';
import { namePrefix } from '../util.js';
import type { AppService } from './app-service.js';

/** CloudWatch metrics for one environment, shared by the alarms and dashboards. */
export class EnvMetrics {
  readonly prefix: string;
  /** Every Valkey node. After a failover the primary is no longer -001. */
  readonly cacheNodes: string[];
  readonly period = Duration.minutes(1);
  readonly fckNat: boolean;

  constructor(
    config: Config,
    private readonly clusterName: string,
    private readonly loadBalancer: elbv2.ApplicationLoadBalancer,
    private readonly natIds: string[],
  ) {
    this.prefix = namePrefix(config);
    this.fckNat = config.vpc.nat.mode === 'fck-nat';
    this.cacheNodes = Array.from(
      { length: config.valkey.replicas + 1 },
      (_, i) => `${this.prefix}-${String(i + 1).padStart(3, '0')}`,
    );
  }

  private metric(
    namespace: string,
    metricName: string,
    dimensionsMap: Record<string, string>,
    statistic: string,
    label?: string,
  ): cw.Metric {
    return new cw.Metric({
      namespace,
      metricName,
      dimensionsMap,
      statistic,
      period: this.period,
      ...(label != null && { label }),
    });
  }

  alb(metricName: string, statistic: string, label?: string): cw.Metric {
    return this.metric(
      'AWS/ApplicationELB',
      metricName,
      { LoadBalancer: this.loadBalancer.loadBalancerFullName },
      statistic,
      label,
    );
  }

  /** `AWS/ECS` utilization, or `ECS/ContainerInsights` task counts. */
  service(metricName: string, svc: AppService, label?: string, namespace = 'AWS/ECS'): cw.Metric {
    return this.metric(
      namespace,
      metricName,
      { ClusterName: this.clusterName, ServiceName: svc.service.serviceName },
      'Average',
      label,
    );
  }

  rds(metricName: string, statistic = 'Average', label?: string): cw.Metric {
    return this.metric(
      'AWS/RDS',
      metricName,
      { DBClusterIdentifier: this.prefix },
      statistic,
      label,
    );
  }

  /** The cluster's worst reader lag, reported on the writer's series. */
  replicaLag(): cw.Metric {
    return this.metric(
      'AWS/RDS',
      'AuroraReplicaLagMaximum',
      { DBClusterIdentifier: this.prefix, Role: 'WRITER' },
      'Maximum',
    );
  }

  /** The node's short name, such as `001`. */
  nodeLabel(node: string): string {
    return node.slice(this.prefix.length + 1);
  }

  cache(metricName: string, node: string, statistic = 'Average'): cw.Metric {
    return this.metric(
      'AWS/ElastiCache',
      metricName,
      { CacheClusterId: node },
      statistic,
      `node ${this.nodeLabel(node)}`,
    );
  }

  /** One metric per NAT instance (fck-nat) or NAT gateway. */
  nat(metricName: string, statistic: string): cw.Metric[] {
    return this.natIds.map((id, i) =>
      this.metric(
        this.fckNat ? 'AWS/EC2' : 'AWS/NATGateway',
        metricName,
        this.fckNat ? { InstanceId: id } : { NatGatewayId: id },
        statistic,
        `NAT ${String(i + 1)}`,
      ),
    );
  }
}

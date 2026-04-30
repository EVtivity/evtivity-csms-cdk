// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  CfnOutput,
  Duration,
  aws_aps as aps,
  aws_cloudwatch as cw,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';

export interface MonitoringStackProps extends StackProps {
  config: Config;
  cluster: ecs.ICluster;
  alb: elbv2.IApplicationLoadBalancer;
}

export class MonitoringStack extends Stack {
  readonly dashboard: cw.Dashboard;
  readonly ampWorkspace?: aps.CfnWorkspace;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { config, cluster, alb } = props;

    // Optional Amazon Managed Prometheus workspace for Prometheus-style
    // scraping. Operators connect Amazon Managed Grafana to this workspace
    // separately (AMG is account-level and requires SSO setup).
    this.ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', {
      alias: `evtivity-${config.env}`,
    });

    this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `evtivity-${config.env}`,
      defaultInterval: Duration.hours(3),
    });

    const clusterName = cluster.clusterName;
    const albFullName = (alb as elbv2.ApplicationLoadBalancer).loadBalancerFullName;

    // Per-service CPU/memory using ECS Container Insights metrics.
    const serviceMetrics = (serviceName: string): cw.IMetric[] => [
      new cw.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: { ClusterName: clusterName, ServiceName: `${clusterName}-${serviceName}` },
        statistic: 'Average',
        period: Duration.minutes(1),
        label: `${serviceName} CPU`,
      }),
      new cw.Metric({
        namespace: 'AWS/ECS',
        metricName: 'MemoryUtilization',
        dimensionsMap: { ClusterName: clusterName, ServiceName: `${clusterName}-${serviceName}` },
        statistic: 'Average',
        period: Duration.minutes(1),
        label: `${serviceName} Mem`,
      }),
    ];

    const enabledServiceNames = Object.entries(config.services)
      .filter(([, sc]) => sc.enabled)
      .map(([name]) => name);

    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'ECS service CPU',
        width: 12,
        height: 6,
        left: enabledServiceNames.flatMap((s) => serviceMetrics(s).slice(0, 1)),
      }),
      new cw.GraphWidget({
        title: 'ECS service memory',
        width: 12,
        height: 6,
        left: enabledServiceNames.flatMap((s) => serviceMetrics(s).slice(1, 2)),
      }),
    );

    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'ALB requests / 5xx',
        width: 12,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: { LoadBalancer: albFullName },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        right: [
          new cw.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_ELB_5XX_Count',
            dimensionsMap: { LoadBalancer: albFullName },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
          new cw.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: { LoadBalancer: albFullName },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
      }),
      new cw.GraphWidget({
        title: 'ALB target latency p95',
        width: 12,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: { LoadBalancer: albFullName },
            statistic: 'p95',
            period: Duration.minutes(1),
          }),
        ],
      }),
    );

    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Aurora ACU / connections',
        width: 12,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ServerlessDatabaseCapacity',
            dimensionsMap: { DBClusterIdentifier: `evtivity-${config.env}` },
            statistic: 'Average',
            period: Duration.minutes(1),
          }),
        ],
        right: [
          new cw.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnections',
            dimensionsMap: { DBClusterIdentifier: `evtivity-${config.env}` },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Redis CPU / cache hits',
        width: 12,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/ElastiCache',
            metricName: 'EngineCPUUtilization',
            dimensionsMap: { CacheClusterId: `evtivity-${config.env}-001` },
            statistic: 'Average',
            period: Duration.minutes(1),
          }),
        ],
        right: [
          new cw.Metric({
            namespace: 'AWS/ElastiCache',
            metricName: 'CacheHitRate',
            dimensionsMap: { CacheClusterId: `evtivity-${config.env}-001` },
            statistic: 'Average',
            period: Duration.minutes(1),
          }),
        ],
      }),
    );

    new CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
    });
    new CfnOutput(this, 'AmpWorkspaceArn', { value: this.ampWorkspace.attrArn });
  }
}

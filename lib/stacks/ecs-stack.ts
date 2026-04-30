// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  CfnOutput,
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
  aws_servicediscovery as servicediscovery,
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
  readonly ocppNlb?: elbv2.NetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { config, vpc, ecsSg, albSg, httpsListener, hostedZone, alb, zoneApex } = props;

    // Cluster-managed Cloud Map namespace for Service Connect east-west
    // service discovery. Each enabled FargateService registers itself; the
    // sidecar resolves `<service>.<namespace>` for inter-service calls.
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `evtivity-${config.env}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
      ...(config.serviceConnect.enabled && {
        defaultCloudMapNamespace: {
          name: config.serviceConnect.namespace,
          type: servicediscovery.NamespaceType.DNS_PRIVATE,
          vpc,
          useForServiceConnect: true,
        },
      }),
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

    // OCPP TLS / SP3 mTLS: NLB on `ocppTls.port` (TCP passthrough). The OCPP
    // server terminates TLS itself so it can read the client cert for mTLS
    // stations. Optional and gated on `ocppTls.enabled`.
    const ocppService = this.services['ocpp'];
    if (config.ocppTls.enabled && ocppService != null) {
      const tlsPort = config.ocppTls.port;

      const nlbSg = new ec2.SecurityGroup(this, 'OcppTlsNlbSg', {
        vpc,
        description: 'EVtivity OCPP TLS (SP3) NLB',
        allowAllOutbound: true,
      });
      nlbSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(tlsPort),
        'OCPP TLS from internet (mTLS terminated by OCPP)',
      );
      // Standalone ingress resource avoids the cross-stack cycle that arises
      // from mutating the network-stack-owned ecsSg with a reference to the
      // NLB SG defined in this stack.
      new ec2.CfnSecurityGroupIngress(this, 'OcppTlsEcsIngress', {
        groupId: ecsSg.securityGroupId,
        sourceSecurityGroupId: nlbSg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: tlsPort,
        toPort: tlsPort,
        description: `NLB to OCPP TLS on ${String(tlsPort)}`,
      });

      this.ocppNlb = new elbv2.NetworkLoadBalancer(this, 'OcppTlsNlb', {
        vpc,
        internetFacing: true,
        crossZoneEnabled: true,
        securityGroups: [nlbSg],
        deletionProtection: config.env === 'prod',
      });

      const tg = new elbv2.NetworkTargetGroup(this, 'OcppTlsTg', {
        vpc,
        port: tlsPort,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(30),
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: String(tlsPort),
          interval: Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
      ocppService.service.attachToNetworkTargetGroup(tg);

      this.ocppNlb.addListener('OcppTlsListener', {
        port: tlsPort,
        protocol: elbv2.Protocol.TCP,
        defaultTargetGroups: [tg],
      });

      new route53.ARecord(this, 'OcppTlsAliasRecord', {
        zone: hostedZone,
        recordName: `ocpp-tls.${zoneApex}`,
        target: route53.RecordTarget.fromAlias(
          new route53_targets.LoadBalancerTarget(this.ocppNlb),
        ),
      });

      new CfnOutput(this, 'OcppTlsEndpoint', {
        value: `wss://ocpp-tls.${zoneApex}:${String(tlsPort)}`,
      });
    }

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}

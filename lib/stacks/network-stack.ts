// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  Stack,
  type StackProps,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  type aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  API_METRICS_PORT,
  GRAFANA_PORT,
  LOKI_PORT,
  SERVICE_CATALOG,
  SERVICE_NAMES,
  albPorts,
  internalPorts,
} from '../catalog.js';
import type { Config } from '../config/index.js';

export interface NetworkStackProps extends StackProps {
  config: Config;
  /** Receives VPC flow logs under vpc-flow-logs/. */
  logsBucket: s3.IBucket;
}

const ENDPOINT_SERVICES: Record<
  Config['vpc']['interfaceEndpoints'][number],
  ec2.InterfaceVpcEndpointAwsService
> = {
  secretsmanager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  ecr: ec2.InterfaceVpcEndpointAwsService.ECR,
  'ecr.dkr': ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
  ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
  ssmmessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
  sts: ec2.InterfaceVpcEndpointAwsService.STS,
  elasticache: ec2.InterfaceVpcEndpointAwsService.ELASTICACHE,
  rds: ec2.InterfaceVpcEndpointAwsService.RDS,
};

/**
 * VPC, NAT, flow logs, VPC endpoints, and the security groups for the load
 * balancers and tasks. The data stack owns the Aurora and Valkey groups and
 * their ingress rules, so every cross-stack reference points at this stack.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly ecsSg: ec2.SecurityGroup;
  /** Credential rotation functions: reach Aurora, Valkey, and AWS APIs. */
  readonly rotationSg: ec2.SecurityGroup;
  /**
   * Grafana, Loki, Prometheus, and the log forwarder. Separate from ecsSg so
   * that Grafana, which is reachable from the internet through the ALB, has
   * no network path to Aurora or Valkey.
   */
  readonly observabilitySg?: ec2.SecurityGroup;
  readonly nlbSg?: ec2.SecurityGroup;
  /** NAT instance ids (fck-nat) or NAT gateway ids, for alarms. */
  readonly natIds: string[];
  private readonly configuredAzs: string[];

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.configuredAzs = config.vpc.availabilityZones;

    const nat = config.vpc.nat;
    let natProvider: ec2.NatProvider;
    let fckNat: ec2.NatInstanceProviderV2 | undefined;
    if (nat.mode === 'fck-nat') {
      const ami = nat.amiIds[config.region];
      if (ami == null) throw new Error(`no fck-nat AMI configured for ${config.region}`);
      fckNat = ec2.NatProvider.instanceV2({
        instanceType: new ec2.InstanceType(nat.instanceType),
        machineImage: ec2.MachineImage.genericLinux({ [config.region]: ami }),
        defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
        // Public subnets do not auto-assign public IPs (EC2.15), so the NAT
        // instance must request one. Without it the private subnets have no
        // route to the internet or AWS APIs.
        associatePublicIpAddress: true,
      });
      natProvider = fckNat;
    } else {
      natProvider = ec2.NatProvider.gateway();
    }

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpc.cidr),
      availabilityZones: config.vpc.availabilityZones,
      natGateways: nat.count,
      natGatewayProvider: natProvider,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: false,
        },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    if (fckNat != null) {
      // The NAT instance forwards traffic from the private subnets only.
      fckNat.connections.allowFrom(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.allTraffic(),
        'NAT from VPC',
      );
      // The provider exposes no block device option. Encrypt the root volume
      // (EC2.7 at the resource level) with an override on each instance.
      for (const subnet of this.vpc.publicSubnets) {
        const instance = subnet.node.tryFindChild('NatInstance') as ec2.Instance | undefined;
        const cfn = instance?.node.defaultChild as ec2.CfnInstance | undefined;
        cfn?.addPropertyOverride('BlockDeviceMappings', [
          {
            DeviceName: '/dev/xvda',
            Ebs: { Encrypted: true, VolumeType: 'gp3', DeleteOnTermination: true },
          },
        ]);
        if (instance != null) this.addNatReboot(instance, subnet.availabilityZone);
      }
    }
    this.natIds = natProvider.configuredGateways.map((g) => g.gatewayId);

    // VPC flow logs (EC2.6). S3 costs about half of CloudWatch Logs ingestion
    // for this volume, and the logs bucket's expiration sets the retention.
    new ec2.FlowLog(this, 'VpcFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(props.logsBucket, 'vpc-flow-logs/', {
        fileFormat: ec2.FlowLogFileFormat.PARQUET,
        hiveCompatiblePartitions: true,
        perHourPartition: true,
      }),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Free gateway endpoint: S3 traffic (app bucket) skips the NAT.
    this.vpc.addGatewayEndpoint('S3Gateway', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    for (const name of config.vpc.interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(`Endpoint-${name}`, {
        service: ENDPOINT_SERVICES[name],
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // --- Security groups ---

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'EVtivity ALB',
      allowAllOutbound: false,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP (redirect, optional OCPP ws)',
    );

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: 'EVtivity ECS tasks',
      // Tasks call ghcr.io, Stripe, Twilio, SMTP, and partner OCPI endpoints.
      allowAllOutbound: true,
    });

    this.rotationSg = new ec2.SecurityGroup(this, 'RotationSg', {
      vpc: this.vpc,
      description: 'EVtivity credential rotation functions',
      allowAllOutbound: true,
    });

    const ocppTlsPort = config.ocppTls.enabled ? config.ocppTls.port : null;
    const albTargetPorts = new Set<number>();
    const internal = new Set<number>();
    for (const name of SERVICE_NAMES) {
      if (!config.services[name].enabled) continue;
      if (SERVICE_CATALOG[name].public) albPorts(name).forEach((p) => albTargetPorts.add(p));
      internalPorts(name, ocppTlsPort).forEach((p) => internal.add(p));
    }
    if (config.observability.enabled) {
      const obs = new ec2.SecurityGroup(this, 'ObservabilitySg', {
        vpc: this.vpc,
        description: 'EVtivity observability (Grafana, Loki, Prometheus, log forwarder)',
        // Amazon Managed Prometheus, S3, SNS, and image registries.
        allowAllOutbound: true,
      });
      this.observabilitySg = obs;
      this.albSg.addEgressRule(obs, ec2.Port.tcp(GRAFANA_PORT), 'ALB to Grafana');
      obs.addIngressRule(this.albSg, ec2.Port.tcp(GRAFANA_PORT), 'ALB to Grafana');
      // Log forwarder pushes and Grafana queries.
      obs.addIngressRule(obs, ec2.Port.tcp(LOKI_PORT), 'Loki from observability');
      // Prometheus scrapes the API metrics port.
      this.ecsSg.addIngressRule(obs, ec2.Port.tcp(API_METRICS_PORT), 'Prometheus scrape');
    }
    for (const port of [...albTargetPorts].sort((a, b) => a - b)) {
      this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(port), `ALB to tasks on ${String(port)}`);
      this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(port), `ALB to tasks on ${String(port)}`);
    }
    // Service-to-service calls through Cloud Map (css -> ocpp, worker -> api,
    // ocpi <-> OCPI simulators).
    for (const port of [...internal].sort((a, b) => a - b)) {
      this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(port), `Task to task on ${String(port)}`);
    }

    if (ocppTlsPort != null) {
      this.nlbSg = new ec2.SecurityGroup(this, 'OcppTlsNlbSg', {
        vpc: this.vpc,
        description: 'EVtivity OCPP TLS NLB',
        allowAllOutbound: false,
      });
      // SP3 stations connect from anywhere on the internet (EXC-006).
      this.nlbSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(ocppTlsPort),
        'OCPP TLS from stations',
      );
      this.nlbSg.addEgressRule(this.ecsSg, ec2.Port.tcp(ocppTlsPort), 'NLB to OCPP');
      this.ecsSg.addIngressRule(this.nlbSg, ec2.Port.tcp(ocppTlsPort), 'NLB to OCPP');
    }
  }

  /** AZs come from config, so synth performs no availability-zone lookup. */
  override get availabilityZones(): string[] {
    return this.configuredAzs;
  }

  // A single NAT instance carries all private egress in lower environments.
  // EC2 already moves it to healthy hardware after a host failure (simplified
  // automatic recovery, on by default for t4g). Reboot it when the instance
  // itself stops responding. The App stack alarms also notify.
  private addNatReboot(instance: ec2.Instance, az: string): void {
    new cw.Alarm(this, `NatReboot-${az}`, {
      alarmDescription: `Reboot the NAT instance in ${az} when it stops responding`,
      metric: new cw.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_Instance',
        dimensionsMap: { InstanceId: instance.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.MISSING,
    }).addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.REBOOT));
  }
}

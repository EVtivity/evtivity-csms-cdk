// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Stack, type StackProps, CfnOutput, aws_route53 as route53 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import { zoneApex } from '../util.js';

export interface DomainStackProps extends StackProps {
  config: Config;
}

export class DomainStack extends Stack {
  readonly hostedZone: route53.IHostedZone;
  readonly zoneApex: string;

  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    const { config } = props;
    this.zoneApex = zoneApex(config);

    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.domain.hostedZoneId,
      zoneName: config.domain.apex,
    });

    new CfnOutput(this, 'ZoneApex', { value: this.zoneApex });
  }
}

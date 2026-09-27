// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  CfnOutput,
  aws_route53 as route53,
  aws_certificatemanager as acm,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import { zoneApex } from '../util.js';

export interface DomainStackProps extends StackProps {
  config: Config;
}

export class DomainStack extends Stack {
  readonly hostedZone: route53.IHostedZone;
  readonly certificate: acm.ICertificate;
  readonly zoneApex: string;

  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    const { config } = props;
    this.zoneApex = zoneApex(config);

    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.domain.hostedZoneId,
      zoneName: config.domain.apex,
    });

    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: this.zoneApex,
      subjectAlternativeNames: [`*.${this.zoneApex}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    new CfnOutput(this, 'ZoneApex', { value: this.zoneApex });
    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}

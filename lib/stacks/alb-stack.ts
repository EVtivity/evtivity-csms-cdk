// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_certificatemanager as acm,
  aws_s3 as s3,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';

export interface AlbStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  certificate: acm.ICertificate;
  accessLogsBucket: s3.IBucket;
}

export class AlbStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);

    const { config, vpc, albSg, certificate, accessLogsBucket } = props;

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(config.alb.idleTimeoutSeconds),
      deletionProtection: config.alb.deletionProtection,
      dropInvalidHeaderFields: true,
    });
    this.alb.logAccessLogs(accessLogsBucket, 'alb');

    // HTTP -> HTTPS redirect
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // HTTPS listener (TLS 1.3 default policy)
    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // --- WAFv2 web ACL associated to the ALB ---

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'AWS-AWSManagedRulesCommonRuleSet',
        priority: 10,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'CommonRuleSet',
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
        priority: 20,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'KnownBadInputs',
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'AWS-AWSManagedRulesSQLiRuleSet',
        priority: 30,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesSQLiRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'SQLi',
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'RateLimit',
        priority: 100,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: config.waf.rateLimit5min,
            aggregateKeyType: 'IP',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'RateLimit',
          sampledRequestsEnabled: true,
        },
      },
    ];

    if (config.waf.blockGeoMatch.length > 0) {
      rules.push({
        name: 'GeoBlock',
        priority: 110,
        action: { block: {} },
        statement: {
          geoMatchStatement: { countryCodes: config.waf.blockGeoMatch },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'GeoBlock',
          sampledRequestsEnabled: true,
        },
      });
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `evtivity-${config.env}`,
        sampledRequestsEnabled: true,
      },
      rules,
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssoc', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    new CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
  }
}

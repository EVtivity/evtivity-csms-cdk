// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  ArnFormat,
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_certificatemanager as acm,
  aws_logs as logs,
  aws_s3 as s3,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import { grafanaHost, namePrefix, removalPolicyOf } from '../util.js';

export interface AlbStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  certificate: acm.ICertificate;
  logsBucket: s3.IBucket;
}

/**
 * Public ALB with an HTTP-to-HTTPS redirect, a TLS 1.2+ HTTPS listener, and a
 * WAF web ACL. The ACL carries the AWS managed rule groups when `waf.enabled`,
 * and the Grafana allowlist rule when observability is enabled. Services
 * attach host-header rules in the app stack.
 */
export class AlbStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;
  readonly httpListener: elbv2.ApplicationListener;
  /** WAF IP set that may reach Grafana. Edited at run time by scripts/grafana-access.sh. */
  readonly grafanaAllowList?: wafv2.CfnIPSet;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);
    const { config, vpc, albSg, certificate, logsBucket } = props;
    const prefix = namePrefix(config);

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: prefix,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(config.alb.idleTimeoutSeconds),
      deletionProtection: config.alb.deletionProtection,
      dropInvalidHeaderFields: true,
      desyncMitigationMode: elbv2.DesyncMitigationMode.DEFENSIVE,
      http2Enabled: true,
    });
    this.alb.logAccessLogs(logsBucket, 'alb');

    // ELB.1: every plain HTTP request is redirected. The optional OCPP ws://
    // rule in the app stack is the only exception (EXC-007).
    this.httpListener = this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    this.httpsListener = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      open: false,
      // ELBSecurityPolicy-TLS13-1-2-Res-2021-06: TLS 1.2 and 1.3, forward-secret ciphers.
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    if (config.waf.enabled || config.observability.enabled) {
      this.grafanaAllowList = this.addWebAcl(config, prefix);
    }

    new CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }

  /** Creates the web ACL and returns the Grafana allowlist when there is one. */
  private addWebAcl(config: Config, prefix: string): wafv2.CfnIPSet | undefined {
    const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: true,
    });
    const managed = (
      name: string,
      priority: number,
      countRules: string[] = [],
    ): wafv2.CfnWebACL.RuleProperty => ({
      name: `AWS-${name}`,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ...(countRules.length > 0 && {
            ruleActionOverrides: countRules.map((r) => ({ name: r, actionToUse: { count: {} } })),
          }),
        },
      },
      visibilityConfig: visibility(name),
    });

    const rules: wafv2.CfnWebACL.RuleProperty[] = [];
    let allowList: wafv2.CfnIPSet | undefined;

    if (config.observability.enabled) {
      // Grafana answers only to addresses in this IP set. The config list
      // seeds it on creation. After that, scripts/grafana-access.sh edits it
      // at run time without a deploy. Changing the seed in config replaces
      // the set's contents on the next deploy.
      allowList = new wafv2.CfnIPSet(this, 'GrafanaAllowList', {
        name: `${prefix}-grafana-allow`,
        description: `Source addresses allowed to reach Grafana in ${config.env}`,
        scope: 'REGIONAL',
        ipAddressVersion: 'IPV4',
        addresses: config.observability.grafana.allowedCidrs,
      });
      rules.push({
        name: 'GrafanaAllowList',
        priority: 1,
        action: { block: {} },
        statement: {
          andStatement: {
            statements: [
              {
                byteMatchStatement: {
                  fieldToMatch: { singleHeader: { Name: 'host' } },
                  positionalConstraint: 'EXACTLY',
                  searchString: grafanaHost(config),
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
              {
                notStatement: {
                  statement: { ipSetReferenceStatement: { arn: allowList.attrArn } },
                },
              },
            ],
          },
        },
        visibilityConfig: visibility('GrafanaAllowList'),
      });
      new CfnOutput(this, 'GrafanaAllowListName', { value: allowList.name ?? '' });
    }

    if (config.waf.enabled) {
      rules.push(
        managed('AWSManagedRulesAmazonIpReputationList', 10),
        managed('AWSManagedRulesCommonRuleSet', 20, config.waf.countRules),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 30),
        managed('AWSManagedRulesSQLiRuleSet', 40),
        {
          name: 'RateLimitPerIp',
          priority: 100,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: config.waf.rateLimitPer5Min, aggregateKeyType: 'IP' },
          },
          visibilityConfig: visibility('RateLimitPerIp'),
        },
      );
    }
    if (config.waf.enabled && config.waf.blockCountries.length > 0) {
      rules.push({
        name: 'GeoBlock',
        priority: 110,
        action: { block: {} },
        statement: { geoMatchStatement: { countryCodes: config.waf.blockCountries } },
        visibilityConfig: visibility('GeoBlock'),
      });
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: prefix,
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: visibility(prefix),
      rules,
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // WAF.11: log requests. WAF requires the aws-waf-logs- name prefix.
    const logGroup = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-${prefix}`,
      retention: config.waf.logRetentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroup.logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      // Keep credentials and session cookies out of the logs.
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
      ],
    });
    return allowList;
  }
}

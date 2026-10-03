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
  aws_route53 as route53,
  aws_s3 as s3,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import type { ServiceName } from '../catalog.js';
import { albHosts, grafanaHost, namePrefix, removalPolicyOf, serviceHost } from '../util.js';

export interface AlbStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  hostedZone: route53.IHostedZone;
  logsBucket: s3.IBucket;
}

type Statement = wafv2.CfnWebACL.StatementProperty;
type Rule = wafv2.CfnWebACL.RuleProperty;

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

const not = (statement: Statement): Statement => ({ notStatement: { statement } });

// WAF requires two or more statements in an AND or OR, so one passes through.
const all = (statements: Statement[]): Statement => {
  const [only] = statements;
  return statements.length === 1 && only ? only : { andStatement: { statements } };
};

const any = (statements: Statement[]): Statement => {
  const [only] = statements;
  return statements.length === 1 && only ? only : { orStatement: { statements } };
};

// STARTS_WITH, not EXACTLY: "<host>:443" and a trailing-dot host still route
// to the service, so they must match too. Extra hosts that begin the same way
// have no listener rule and get the 404 default.
const hostIs = (host: string): Statement => ({
  byteMatchStatement: {
    fieldToMatch: { singleHeader: { Name: 'host' } },
    positionalConstraint: 'STARTS_WITH',
    searchString: host,
    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
  },
});

const methodIs = (method: string): Statement => ({
  byteMatchStatement: {
    fieldToMatch: { method: {} },
    positionalConstraint: 'EXACTLY',
    searchString: method,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

// Decoded and normalized so "/v1//auth/login" or "%2F" cannot dodge a match.
const path = (
  positionalConstraint: 'EXACTLY' | 'STARTS_WITH' | 'ENDS_WITH',
  searchString: string,
): Statement => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint,
    searchString,
    textTransformations: [
      { priority: 0, type: 'URL_DECODE' },
      { priority: 1, type: 'NORMALIZE_PATH' },
    ],
  },
});

const managed = (
  name: string,
  priority: number,
  options: { countRules?: string[]; scopeDown?: Statement } = {},
): Rule => {
  const countRules = options.countRules ?? [];
  return {
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
        ...(options.scopeDown && { scopeDownStatement: options.scopeDown }),
      },
    },
    visibilityConfig: visibility(name),
  };
};

const rateLimit = (name: string, priority: number, limit: number, scopeDown?: Statement): Rule => ({
  name,
  priority,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit,
      aggregateKeyType: 'IP',
      ...(scopeDown && { scopeDownStatement: scopeDown }),
    },
  },
  visibilityConfig: visibility(name),
});

/**
 * Public ALB with an HTTP-to-HTTPS redirect, a TLS 1.2+ HTTPS listener, its
 * ACM certificate, and a WAF web ACL. The ACL carries the Grafana allowlist
 * rule when observability is enabled and the protection rules when
 * `waf.enabled`. Services attach host-header rules in the app stack.
 */
export class AlbStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;
  readonly httpListener: elbv2.ApplicationListener;
  readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);
    const { config, vpc, albSg, hostedZone, logsBucket } = props;
    const prefix = namePrefix(config);

    // Names every host exactly. Stations reject a wildcard CSMS certificate
    // unless AllowCSMSTLSWildcards (2.1) or AllowCentralSystemTLSWildcards
    // (1.6) is true, and both default to false. Lives in this stack so a
    // change to the host list replaces it in place: CloudFormation issues and
    // validates the new certificate, moves the listener to it, then deletes
    // the old one.
    const [commonName, ...otherNames] = albHosts(config);
    if (commonName == null) {
      throw new Error('The ALB needs at least one enabled public service or Grafana');
    }
    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: commonName,
      subjectAlternativeNames: otherNames,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

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
      certificates: [this.certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    if (config.waf.enabled || config.observability.enabled) {
      this.addWebAcl(config, prefix);
    }

    new CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }

  /** Creates the web ACL, its logging, and the Grafana allowlist when there is one. */
  private addWebAcl(config: Config, prefix: string): void {
    const rules: Rule[] = [];

    if (config.observability.enabled) {
      // Grafana answers only to addresses in this IP set. The config list
      // seeds it on creation. After that, scripts/grafana-access.sh edits it
      // at run time without a deploy. Changing the seed in config replaces
      // the set's contents on the next deploy.
      const allowList = new wafv2.CfnIPSet(this, 'GrafanaAllowList', {
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
        statement: all([
          hostIs(grafanaHost(config)),
          not({ ipSetReferenceStatement: { arn: allowList.attrArn } }),
        ]),
        visibilityConfig: visibility('GrafanaAllowList'),
      });
      new CfnOutput(this, 'GrafanaAllowListName', { value: allowList.name ?? '' });
    }

    if (config.waf.enabled) {
      this.addProtectionRules(config, prefix, rules);
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
  }

  /**
   * Rules added when `waf.enabled`. docs/security.md#waf-rules lists them in
   * priority order with the reasons.
   *
   * Charging stations on cellular networks often share one public address
   * through carrier NAT, and roaming IoT SIMs can exit in another country. So
   * the OCPP host skips the country, IP reputation, anonymous IP, and global
   * rate rules, and gets its own higher rate limit. Station authentication in
   * the OCPP service remains the gate.
   */
  private addProtectionRules(config: Config, prefix: string, rules: Rule[]): void {
    const enabledHost = (name: ServiceName): string | undefined =>
      config.services[name].enabled ? serviceHost(config, name) : undefined;
    const apiHost = enabledHost('api');
    const ocppHost = enabledHost('ocpp');
    const staticHosts = [enabledHost('csms'), enabledHost('portal')].filter(
      (h): h is string => h != null,
    );
    // Exempts the OCPP host from address-based rules. Undefined when OCPP is off.
    const notOcpp = ocppHost == null ? undefined : not(hostIs(ocppHost));

    const stripeIps = config.waf.stripeWebhookIps;
    if (apiHost != null && stripeIps.length > 0) {
      // Stripe's published webhook addresses include Germany and India, so the
      // country rule would block them. The config list seeds the set. After
      // that, scripts/stripe-webhook-ips.sh syncs it from Stripe without a
      // deploy. The API still verifies the Stripe-Signature header.
      const stripeSet = new wafv2.CfnIPSet(this, 'StripeWebhookIps', {
        name: `${prefix}-stripe-webhooks`,
        description: `Stripe webhook source addresses for ${config.env}`,
        scope: 'REGIONAL',
        ipAddressVersion: 'IPV4',
        addresses: stripeIps,
      });
      rules.push({
        name: 'StripeWebhookAllow',
        priority: 2,
        action: { allow: {} },
        statement: all([
          hostIs(apiHost),
          path('EXACTLY', '/v1/webhooks/stripe'),
          { ipSetReferenceStatement: { arn: stripeSet.attrArn } },
        ]),
        visibilityConfig: visibility('StripeWebhookAllow'),
      });
      new CfnOutput(this, 'StripeWebhookIpSetName', { value: stripeSet.name ?? '' });
    }

    if (ocppHost != null) {
      // The OCPP port serves only WebSocket upgrades. Health checks use a
      // separate port and do not pass through the WAF.
      rules.push({
        name: 'OcppWebSocketOnly',
        priority: 3,
        action: { block: {} },
        statement: all([
          hostIs(ocppHost),
          not({
            byteMatchStatement: {
              fieldToMatch: { singleHeader: { Name: 'upgrade' } },
              positionalConstraint: 'CONTAINS',
              searchString: 'websocket',
              textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
            },
          }),
        ]),
        visibilityConfig: visibility('OcppWebSocketOnly'),
      });
    }

    if (staticHosts.length > 0) {
      // Static nginx sites with no API proxy. Other methods are probes.
      rules.push({
        name: 'StaticSiteMethods',
        priority: 4,
        action: { block: {} },
        statement: all([
          any(staticHosts.map(hostIs)),
          not(any([methodIs('GET'), methodIs('HEAD')])),
        ]),
        visibilityConfig: visibility('StaticSiteMethods'),
      });
    }

    if (config.waf.allowCountries.length > 0) {
      const outside = not({ geoMatchStatement: { countryCodes: config.waf.allowCountries } });
      rules.push({
        name: 'GeoAllow',
        priority: 5,
        action: { block: {} },
        statement: notOcpp ? all([outside, notOcpp]) : outside,
        visibilityConfig: visibility('GeoAllow'),
      });
    }

    rules.push(
      managed('AWSManagedRulesAmazonIpReputationList', 10, { scopeDown: notOcpp }),
      // Cloud-hosted callers (Stripe, OCPI partners, IoT SIM gateways) come
      // from hosting providers, so that list only counts.
      managed('AWSManagedRulesAnonymousIpList', 15, {
        countRules: ['HostingProviderIPList'],
        scopeDown: notOcpp,
      }),
      managed('AWSManagedRulesCommonRuleSet', 20, { countRules: config.waf.countRules }),
      managed('AWSManagedRulesKnownBadInputsRuleSet', 30),
      managed('AWSManagedRulesSQLiRuleSet', 40),
      managed('AWSManagedRulesLinuxRuleSet', 50),
      rateLimit('RateLimitPerIp', 100, config.waf.rateLimitPer5Min, notOcpp),
    );
    if (ocppHost != null) {
      rules.push(
        rateLimit('OcppRateLimitPerIp', 101, config.waf.ocppRateLimitPer5Min, hostIs(ocppHost)),
      );
    }
    if (apiHost != null) {
      // POST only: token refresh and logout are excluded because every signed
      // in session calls them, and GET status polling is excluded for guests.
      rules.push(
        rateLimit(
          'AuthRateLimitPerIp',
          102,
          config.waf.authRateLimitPer5Min,
          all([
            hostIs(apiHost),
            methodIs('POST'),
            any([path('STARTS_WITH', '/v1/auth/'), path('STARTS_WITH', '/v1/portal/auth/')]),
            not(any([path('ENDS_WITH', '/refresh'), path('ENDS_WITH', '/logout')])),
          ]),
        ),
        rateLimit(
          'GuestRateLimitPerIp',
          103,
          config.waf.guestRateLimitPer5Min,
          all([hostIs(apiHost), methodIs('POST'), path('STARTS_WITH', '/v1/portal/guest/')]),
        ),
      );
    }
  }
}

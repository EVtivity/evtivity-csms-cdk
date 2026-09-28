// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RemovalPolicy } from 'aws-cdk-lib';
import { SERVICE_CATALOG, type ServiceName } from './catalog.js';
import type { Config } from './config/index.js';

export function removalPolicyOf(mode: 'destroy' | 'retain' | 'snapshot'): RemovalPolicy {
  switch (mode) {
    case 'retain':
      return RemovalPolicy.RETAIN;
    case 'snapshot':
      return RemovalPolicy.SNAPSHOT;
    case 'destroy':
      return RemovalPolicy.DESTROY;
  }
}

/** DNS zone the environment's hostnames live under, e.g. dev.evtivity.com. */
export function zoneApex(config: Config): string {
  return config.domain.subdomain === ''
    ? config.domain.apex
    : `${config.domain.subdomain}.${config.domain.apex}`;
}

/** Fully qualified public hostname of a service, or undefined if it is not public. */
export function serviceHost(config: Config, name: ServiceName): string | undefined {
  const spec = SERVICE_CATALOG[name];
  if (!spec.public) return undefined;
  const label = config.services[name].hostname ?? spec.hostname ?? name;
  return `${label}.${zoneApex(config)}`;
}

/** Public URL of an enabled service, or an empty string. */
export function serviceUrl(
  config: Config,
  name: ServiceName,
  scheme: 'https' | 'wss' = 'https',
): string {
  if (!config.services[name].enabled) return '';
  const host = serviceHost(config, name);
  return host == null ? '' : `${scheme}://${host}`;
}

/** Stack name prefix, e.g. Evtivity-Dev. */
export function stackPrefix(config: Config): string {
  return `Evtivity-${config.env.charAt(0).toUpperCase()}${config.env.slice(1)}`;
}

/** Resource name prefix, e.g. evtivity-dev. */
export function namePrefix(config: Config): string {
  return `evtivity-${config.env}`;
}

/** Secrets Manager name prefix, e.g. evtivity/dev. */
export function secretPrefix(config: Config): string {
  return `evtivity/${config.env}`;
}

/** Application bucket name. Deterministic so other stacks need no export. */
export function appBucketName(config: Config): string {
  return `${namePrefix(config)}-app-${config.account}`;
}

/** Log bucket name (ALB access logs and S3 server access logs). */
export function logsBucketName(config: Config): string {
  return `${namePrefix(config)}-logs-${config.account}`;
}

/** Grafana provisioning bucket name (dashboards, alert rules, datasources). */
export function grafanaBucketName(config: Config): string {
  return `${namePrefix(config)}-grafana-${config.account}`;
}

/** Loki storage bucket name (chunks and indexes). */
export function lokiBucketName(config: Config): string {
  return `${namePrefix(config)}-loki-${config.account}`;
}

/** Grafana's public hostname, e.g. grafana.dev.evtivity.com. */
export function grafanaHost(config: Config): string {
  return `${config.observability.grafana.hostname}.${zoneApex(config)}`;
}

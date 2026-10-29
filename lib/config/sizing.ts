// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ServiceName } from '../catalog.js';
import type { Config } from './schema.js';

/** Sizing presets. `prod` copies the sizing and topology of config/prod.yaml. */
export const SIZING_PRESETS = ['prod'] as const;
export type SizingPreset = (typeof SIZING_PRESETS)[number];

export function isSizingPreset(value: string): value is SizingPreset {
  return (SIZING_PRESETS as readonly string[]).includes(value);
}

/**
 * Services whose sizing a preset copies. css, ocpiSim, and ocpiCpoSim are test
 * tools that prod does not run, so they keep the environment's own settings.
 */
export const SIZED_SERVICES = [
  'api',
  'ocpp',
  'ocpi',
  'csms',
  'portal',
  'worker',
] as const satisfies readonly ServiceName[];

/**
 * The sizing and topology values of a loaded config, as a partial config to
 * deep-merge over another environment. Everything else (account, region,
 * domain, names, tags, removal policies, deletion protection, retention,
 * alarms, executeCommand, css, seedDemo, payments, appSettings) is identity or
 * safety and stays with the target environment.
 *
 * Keys whose value is undefined remove the target's value when merged, so the
 * target ends up with prod's schema default (for example no autoscaling).
 */
export function sizingOf(c: Config): Record<string, unknown> {
  return {
    vpc: {
      nat: { mode: c.vpc.nat.mode, count: c.vpc.nat.count, instanceType: c.vpc.nat.instanceType },
      interfaceEndpoints: [...c.vpc.interfaceEndpoints],
    },
    ecs: { containerInsights: c.ecs.containerInsights },
    aurora: {
      mode: c.aurora.mode,
      minCapacity: c.aurora.minCapacity,
      maxCapacity: c.aurora.maxCapacity,
      autoPauseSeconds: c.aurora.autoPauseSeconds,
      instanceClass: c.aurora.instanceClass,
      readers: c.aurora.readers,
      performanceInsights: c.aurora.performanceInsights,
      monitoringIntervalSeconds: c.aurora.monitoringIntervalSeconds,
      poolMax: c.aurora.poolMax,
    },
    valkey: {
      nodeType: c.valkey.nodeType,
      replicas: c.valkey.replicas,
      multiAz: c.valkey.multiAz,
    },
    waf: {
      enabled: c.waf.enabled,
      rateLimitPer5Min: c.waf.rateLimitPer5Min,
      ocppRateLimitPer5Min: c.waf.ocppRateLimitPer5Min,
      authRateLimitPer5Min: c.waf.authRateLimitPer5Min,
      guestRateLimitPer5Min: c.waf.guestRateLimitPer5Min,
      adyenWebhookRateLimitPer5Min: c.waf.adyenWebhookRateLimitPer5Min,
    },
    ocppConnectionAuth: { ...c.ocppConnectionAuth },
    // The OCSP responder needs a single worker task, so it follows the
    // worker topology.
    octt: { ocspResponder: c.octt.ocspResponder },
    observability: {
      grafana: {
        cpu: c.observability.grafana.cpu,
        memoryMiB: c.observability.grafana.memoryMiB,
        capacity: c.observability.grafana.capacity,
      },
      prometheus: {
        cpu: c.observability.prometheus.cpu,
        memoryMiB: c.observability.prometheus.memoryMiB,
        capacity: c.observability.prometheus.capacity,
      },
    },
    services: Object.fromEntries(
      SIZED_SERVICES.map((name) => {
        const s = c.services[name];
        return [
          name,
          {
            cpu: s.cpu,
            memoryMiB: s.memoryMiB,
            desiredCount: s.desiredCount,
            autoscaling: s.autoscaling == null ? undefined : { ...s.autoscaling },
            capacity: s.capacity,
            deregistrationDelaySeconds: s.deregistrationDelaySeconds,
            stopTimeoutSeconds: s.stopTimeoutSeconds,
          },
        ];
      }),
    ),
  };
}

// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { SERVICE_CATALOG, SERVICE_NAMES, type ServiceName } from '../catalog.js';

const envName = z.enum(['dev', 'qa', 'prod']);
export type EnvName = z.infer<typeof envName>;

const FARGATE_CPU = [256, 512, 1024, 2048, 4096, 8192, 16384];
const fargateCpu = z
  .number()
  .int()
  .refine((v) => FARGATE_CPU.includes(v), {
    message: `cpu must be one of ${FARGATE_CPU.join(', ')}`,
  });

// CloudWatch Logs only accepts these retention values.
const LOG_RETENTION = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
];
const logRetentionDays = z
  .number()
  .int()
  .refine((v) => LOG_RETENTION.includes(v), {
    message: `must be one of ${LOG_RETENTION.join(', ')}`,
  });

const envMap = z.record(z.string(), z.string()).default({});

const autoscaling = z
  .object({
    min: z.number().int().min(0),
    max: z.number().int().min(1),
    cpuTargetPercent: z.number().int().min(10).max(95).default(70),
    memoryTargetPercent: z.number().int().min(10).max(95).default(75),
    scaleInCooldownSeconds: z.number().int().min(0).default(120),
    scaleOutCooldownSeconds: z.number().int().min(0).default(60),
  })
  .refine((a) => a.max >= a.min, { message: 'autoscaling.max must be >= autoscaling.min' });

const serviceConfig = z.object({
  enabled: z.boolean().default(false),
  // Overrides for the global image settings, e.g. to pin one service.
  imageTag: z.string().min(1).optional(),
  imageRepository: z.string().min(1).optional(),
  cpu: fargateCpu.default(256),
  memoryMiB: z.number().int().min(512).default(512),
  desiredCount: z.number().int().min(0).default(1),
  autoscaling: autoscaling.optional(),
  // FARGATE_SPOT is about 70% cheaper. Spot tasks can be stopped with two
  // minutes notice, so keep it off for prod services that hold WebSockets.
  capacity: z.enum(['FARGATE', 'FARGATE_SPOT']).default('FARGATE'),
  // Public hostname label, e.g. `api` -> api.<zone>. Defaults to the catalog.
  hostname: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  // Seconds the load balancer keeps draining a stopping task. OCPP holds
  // long-lived WebSockets, so give it enough time for stations to move.
  deregistrationDelaySeconds: z.number().int().min(0).max(3600).default(30),
  // ECS waits this long after SIGTERM before SIGKILL. Fargate max is 120.
  stopTimeoutSeconds: z.number().int().min(2).max(120).default(30),
  // Load balancer cookie stickiness for HTTP requests. WebSockets do not need
  // it: an upgraded connection stays on the task that accepted it.
  stickinessSeconds: z.number().int().min(0).max(604800).default(0),
  // HTTPS to the target is the remediation path for EXC-001. The published
  // images serve HTTP only until an in-container TLS release ships.
  targetProtocol: z.enum(['HTTP', 'HTTPS']).default('HTTP'),
  // Linux user for the container. Node images run as `node` (1000) by
  // default. The nginx images still need root for the master process
  // (EXC-002).
  user: z.string().optional(),
  // Extra environment variables. They win over derived values.
  env: envMap,
  // Extra secrets: ENV_NAME -> "<secret name>" or "<secret name>:<json key>".
  secrets: envMap,
});
export type ServiceConfig = z.infer<typeof serviceConfig>;

const servicesSchema = z
  .object(
    Object.fromEntries(SERVICE_NAMES.map((n) => [n, serviceConfig.prefault({})])) as Record<
      ServiceName,
      z.ZodPrefault<typeof serviceConfig>
    >,
  )
  .strict();

export const configSchema = z
  .object({
    env: envName,
    account: z.string().regex(/^\d{12}$/, 'AWS account must be 12 digits'),
    region: z.string().default('us-east-1'),

    // Container images. Services resolve `<registry>/<component>:<tag>`.
    image: z.object({
      registry: z.string().default('ghcr.io/evtivity/evtivity-csms'),
      tag: z
        .string()
        .regex(/^[0-9][0-9A-Za-z._-]*$/, 'image.tag is a version such as 0.1.20 (no leading v)'),
    }),

    domain: z.object({
      apex: z.string().min(1),
      // Empty puts services on the apex (csms.evtivity.com). Non-empty adds a
      // per-env label (csms.dev.evtivity.com).
      subdomain: z.string().default(''),
      hostedZoneId: z.string().min(1),
    }),

    // Extra tags for every resource. Environment, Service, Stack, CreatedDate,
    // and UpdatedDate are added by the app and cannot be overridden here.
    tags: z.record(z.string(), z.string()).default({}),
    // Date the environment was first deployed. Stamped on every resource as
    // CreatedDate. Set it once and never change it.
    createdDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'createdDate is YYYY-MM-DD'),

    vpc: z.object({
      cidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/, 'CIDR notation required'),
      // Listed explicitly so synth needs no AWS credentials or context lookups.
      availabilityZones: z
        .array(z.string().regex(/^[a-z]{2}-[a-z]+-\d[a-z]$/))
        .min(2)
        .max(3),
      nat: z
        .object({
          // fck-nat runs NAT on a t4g.nano instance for about $3/month. A NAT
          // gateway is managed and highly available but costs about
          // $33/month per gateway plus $0.045 per GB.
          mode: z.enum(['fck-nat', 'gateway']).default('fck-nat'),
          count: z.number().int().min(1).max(3).default(1),
          instanceType: z.string().default('t4g.nano'),
          // fck-nat AL2023 arm64 AMI per region, pinned so synth is
          // deterministic. docs/deployment.md explains how to update it.
          amiIds: z
            .record(z.string(), z.string())
            .default({ 'us-east-1': 'ami-057efe8665d31018f' }),
        })
        .prefault({}),
      // Interface endpoints cost about $7.30/month per endpoint per AZ. The
      // S3 gateway endpoint is free and always created.
      interfaceEndpoints: z
        .array(
          z.enum([
            'secretsmanager',
            'logs',
            'ecr',
            'ecr.dkr',
            'ssm',
            'ssmmessages',
            'sts',
            'elasticache',
            'rds',
          ]),
        )
        .default([]),
      flowLogRetentionDays: logRetentionDays.default(30),
    }),

    logs: z
      .object({
        retentionDays: logRetentionDays.default(30),
        removal: z.enum(['destroy', 'retain']).default('destroy'),
      })
      .prefault({}),

    ecs: z
      .object({
        // Enhanced observability bills per metric. `enabled` keeps the
        // standard Container Insights metrics that ECS.12 requires.
        containerInsights: z.enum(['enabled', 'enhanced']).default('enabled'),
        executeCommand: z.boolean().default(false),
        // Force a new deployment of every service on this schedule so tasks
        // pick up rotated credentials. Must be shorter than the shortest
        // rotation interval. 0 disables.
        redeployEveryDays: z.number().int().min(0).default(7),
      })
      .prefault({}),

    aurora: z.object({
      engineVersion: z.string().default('17.9'),
      // serverless: Serverless v2 instances that scale in ACUs.
      // provisioned: fixed instance classes, cheaper at steady high load.
      mode: z.enum(['serverless', 'provisioned']).default('serverless'),
      minCapacity: z.number().min(0).max(256).default(0.5),
      maxCapacity: z.number().min(1).max(256).default(4),
      // Serverless v2 pauses after this many idle seconds when minCapacity
      // is 0. It only pauses when no client is connected.
      autoPauseSeconds: z.number().int().min(300).max(86400).default(300),
      instanceClass: z.string().default('r7g.large'),
      readers: z.number().int().min(0).max(15).default(0),
      backupRetentionDays: z.number().int().min(1).max(35).default(7),
      preferredBackupWindow: z.string().optional(),
      preferredMaintenanceWindow: z.string().optional(),
      deletionProtection: z.boolean().default(false),
      removal: z.enum(['destroy', 'retain', 'snapshot']).default('snapshot'),
      performanceInsights: z.boolean().default(false),
      monitoringIntervalSeconds: z
        .number()
        .int()
        .refine((v) => [0, 1, 5, 10, 15, 30, 60].includes(v), {
          message: 'must be 0, 1, 5, 10, 15, 30, or 60',
        })
        .default(60),
      iamAuthentication: z.boolean().default(true),
      // Connection pool size per task.
      poolMax: z.number().int().min(1).default(10),
    }),

    valkey: z.object({
      engineVersion: z.string().default('8.2'),
      nodeType: z.string().default('cache.t4g.micro'),
      replicas: z.number().int().min(0).max(5).default(0),
      snapshotRetentionDays: z.number().int().min(1).max(35).default(1),
      snapshotWindow: z.string().optional(),
      maintenanceWindow: z.string().optional(),
      // Extra parameter overrides. maxmemory-policy is fixed to noeviction
      // because BullMQ loses jobs when keys are evicted.
      parameters: z.record(z.string(), z.string()).default({}),
    }),

    rotation: z
      .object({
        enabled: z.boolean().default(true),
        databaseDays: z.number().int().min(1).max(365).default(30),
        cacheDays: z.number().int().min(1).max(365).default(30),
      })
      .prefault({}),

    secrets: z
      .object({
        // retain keeps JWT_SECRET, SETTINGS_ENCRYPTION_KEY, and the initial
        // admin secret when the stack is deleted, so data encrypted with the
        // settings key stays readable after a rebuild on a retained database.
        removal: z.enum(['destroy', 'retain']).default('destroy'),
      })
      .prefault({}),

    storage: z
      .object({
        versioned: z.boolean().default(true),
        noncurrentVersionExpirationDays: z.number().int().min(1).default(30),
        logsExpirationDays: z.number().int().min(1).default(30),
        removal: z.enum(['destroy', 'retain']).default('destroy'),
        extraCorsOrigins: z.array(z.url()).default([]),
      })
      .prefault({}),

    alb: z
      .object({
        // WebSockets stay open past this only while frames flow. OCPP
        // heartbeats and pings keep station connections alive.
        idleTimeoutSeconds: z.number().int().min(1).max(4000).default(120),
        deletionProtection: z.boolean().default(false),
        // Plain ws:// for OCPP security profiles 0 and 1 on port 80. Station
        // passwords then cross the internet unencrypted. See EXC-007.
        ocppPlainWs: z.boolean().default(false),
      })
      .prefault({}),

    waf: z
      .object({
        enabled: z.boolean().default(false),
        rateLimitPer5Min: z.number().int().min(100).default(2000),
        blockCountries: z.array(z.string().length(2)).default([]),
        // Managed rules switched to count mode. Charging stations often send
        // no User-Agent, and bulk imports exceed the 8 KB body limit.
        countRules: z.array(z.string()).default(['NoUserAgent_HEADER', 'SizeRestrictions_BODY']),
        logRetentionDays: logRetentionDays.default(30),
      })
      .prefault({}),

    // SP3 mutual TLS for OCPP on an NLB with TCP passthrough. The secret
    // holds JSON keys cert, key, ca (PEM strings).
    ocppTls: z
      .object({
        enabled: z.boolean().default(false),
        secretName: z.string().optional(),
        port: z.number().int().min(1).max(65535).default(8443),
        hostname: z.string().default('ocpp-tls'),
      })
      .prefault({}),
    // Client certificate for the charging station simulator (SP3 testing).
    cssTls: z
      .object({
        enabled: z.boolean().default(false),
        secretName: z.string().optional(),
      })
      .prefault({}),

    ocpi: z
      .object({
        countryCode: z.string().length(2).default('US'),
        partyId: z.string().min(1).max(3).default('EVT'),
        businessName: z.string().default('EVtivity'),
      })
      .prefault({}),

    initialAdmin: z.object({ email: z.email() }),

    // Values upserted into the settings table on every database job run.
    // Non-secret settings only. Enter credentials in the dashboard.
    appSettings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),

    // Demo dataset (sites, 2000 stations, operators, drivers, sessions,
    // simulator rows). Runs once after the database job, not on every
    // deploy. Bump revision to run it again (the seed skips when demo data is
    // already present). Demo operators and drivers get a generated password
    // from evtivity/<env>/demo-password, and operators must change it at
    // first sign-in. Not allowed in prod.
    seedDemo: z
      .object({
        enabled: z.boolean().default(false),
        revision: z.number().int().min(1).default(1),
        // Seeded simulator stations left enabled for the css service. The
        // rest are disabled so a small css task is not flooded. 0 disables all.
        stationLimit: z.number().int().min(0).max(2000).default(50),
      })
      .prefault({}),

    monitoring: z
      .object({
        dashboard: z.boolean().default(true),
        alarms: z.boolean().default(true),
        alarmEmail: z.email().optional(),
      })
      .prefault({}),

    // Prometheus, Grafana, and Loki with the same dashboards and alert rules
    // as the Helm chart. Prometheus runs in agent mode and writes to Amazon
    // Managed Service for Prometheus, Loki stores chunks in S3, and a Lambda
    // forwards the services' CloudWatch logs to Loki.
    observability: z
      .object({
        enabled: z.boolean().default(false),
        grafana: z
          .object({
            version: z.string().default('11.5.2'),
            hostname: z
              .string()
              .regex(/^[a-z0-9-]+$/)
              .default('grafana'),
            // Initial contents of the WAF IP set that may reach
            // grafana.<zone>. Edit the live set with
            // scripts/grafana-access.sh, no deploy needed. Changing this list
            // replaces the set's contents on the next deploy.
            allowedCidrs: z.array(z.cidrv4()).default([]),
            cpu: fargateCpu.default(256),
            memoryMiB: z.number().int().min(512).default(512),
            capacity: z.enum(['FARGATE', 'FARGATE_SPOT']).default('FARGATE'),
          })
          .prefault({}),
        prometheus: z
          .object({
            version: z.string().default('v3.2.1'),
            scrapeIntervalSeconds: z.number().int().min(10).default(60),
            cpu: fargateCpu.default(256),
            memoryMiB: z.number().int().min(512).default(512),
            capacity: z.enum(['FARGATE', 'FARGATE_SPOT']).default('FARGATE'),
          })
          .prefault({}),
        loki: z
          .object({
            version: z.string().default('3.4.2'),
            retentionDays: z.number().int().min(1).default(30),
            cpu: fargateCpu.default(256),
            memoryMiB: z.number().int().min(512).default(1024),
            capacity: z.enum(['FARGATE', 'FARGATE_SPOT']).default('FARGATE'),
          })
          .prefault({}),
      })
      .prefault({}),

    services: servicesSchema,
  })
  .superRefine((c, ctx) => {
    for (const name of SERVICE_NAMES) {
      const sc = c.services[name];
      if (!sc.enabled) continue;
      for (const dep of SERVICE_CATALOG[name].requires) {
        if (!c.services[dep].enabled) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', name, 'enabled'],
            message: `${name} requires ${dep} to be enabled`,
          });
        }
      }
      const singleton = name === 'css' || name === 'ocpiSim' || name === 'ocpiCpoSim';
      if (
        singleton &&
        (sc.desiredCount > 1 || (sc.autoscaling != null && sc.autoscaling.max > 1))
      ) {
        // The simulator owns a fixed station set and the OCPI simulators keep
        // state in memory. Scaling them out duplicates work.
        ctx.addIssue({
          code: 'custom',
          path: ['services', name],
          message: `${name} must run as a single task`,
        });
      }
    }
    if (c.ocppTls.enabled) {
      if (!c.services.ocpp.enabled) {
        ctx.addIssue({
          code: 'custom',
          path: ['ocppTls', 'enabled'],
          message: 'ocppTls requires the ocpp service',
        });
      }
      if (c.ocppTls.secretName == null || c.ocppTls.secretName === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['ocppTls', 'secretName'],
          message: 'required when ocppTls.enabled',
        });
      }
    }
    if (c.seedDemo.enabled && c.env === 'prod') {
      ctx.addIssue({
        code: 'custom',
        path: ['seedDemo', 'enabled'],
        message: 'demo data is not allowed in prod',
      });
    }
    if (c.cssTls.enabled && (c.cssTls.secretName == null || c.cssTls.secretName === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['cssTls', 'secretName'],
        message: 'required when cssTls.enabled',
      });
    }
    if (c.aurora.mode === 'serverless' && c.aurora.maxCapacity < c.aurora.minCapacity) {
      ctx.addIssue({
        code: 'custom',
        path: ['aurora', 'maxCapacity'],
        message: 'must be >= minCapacity',
      });
    }
    if (c.vpc.nat.mode === 'fck-nat' && c.vpc.nat.amiIds[c.region] == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['vpc', 'nat', 'amiIds'],
        message: `no fck-nat AMI for ${c.region}`,
      });
    }
    if (c.rotation.enabled) {
      const shortest = Math.min(c.rotation.databaseDays, c.rotation.cacheDays);
      if (c.ecs.redeployEveryDays < 1 || c.ecs.redeployEveryDays >= shortest) {
        // Alternating rotation keeps the previous credential valid for one
        // rotation interval. Tasks must restart within it.
        ctx.addIssue({
          code: 'custom',
          path: ['ecs', 'redeployEveryDays'],
          message: `must be between 1 and ${String(shortest - 1)} when rotation is enabled`,
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

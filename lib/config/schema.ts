// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

// The CSMS runs in one currency with two minor units; mirrors
// SUPPORTED_CURRENCIES in the CSMS repo (packages/lib/src/currency.ts).
const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'INR',
  'BRL',
  'MXN',
  'SEK',
  'NOK',
  'DKK',
  'NZD',
  'SGD',
  'HKD',
  'ZAR',
  'ILS',
  'AED',
  'SAR',
  'TWD',
  'THB',
  'PLN',
  'CZK',
  'HUF',
  'TRY',
  'COP',
  'ARS',
  'PHP',
  'MYR',
  'IDR',
];
import { SERVICE_CATALOG, SERVICE_NAMES, type ServiceName } from '../catalog.js';

// The operator's mobile app builds. The API accepts a 3D Secure return URL
// from the app only when it leads back to one of them. Mirrors the rules of
// isAppUrlScheme and isAndroidPackageName in the CSMS repo
// (packages/lib/src/mobile-app.ts), which the Helm chart repeats; the CDK
// cannot import that package.
const MOBILE_APP_URL_SCHEMES_KEY = 'mobile.app.urlSchemes';
const MOBILE_APP_ANDROID_PACKAGES_KEY = 'mobile.app.androidPackageNames';
// RFC 3986 scheme. Browser schemes would leave the app, and adyencheckout is
// the Adyen Android SDK scheme, accepted only with a listed application id.
const APP_URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
const RESERVED_URL_SCHEMES = new Set([
  'http',
  'https',
  'javascript',
  'data',
  'file',
  'about',
  'blob',
  'adyencheckout',
]);
// Android application id: at least two segments, each starting with a letter.
const ANDROID_PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const LIST_SETTING_KEYS = new Set([MOBILE_APP_URL_SCHEMES_KEY, MOBILE_APP_ANDROID_PACKAGES_KEY]);

/** A value in appSettings. Lists are allowed only for the mobile.app.* keys. */
export type AppSettingValue = string | number | boolean | string[];

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

/** Env vars of the CSMS notification test sink, refused in every environment. */
const NOTIFICATION_TEST_SINK_VARS = [
  'NOTIFICATIONS_ALLOW_TEST_SINK',
  'NOTIFICATIONS_TEST_SINK_URL',
] as const;

const autoscaling = z
  .strictObject({
    min: z.number().int().min(0),
    max: z.number().int().min(1),
    cpuTargetPercent: z.number().int().min(10).max(95).default(70),
    // Above the 75% Node heap limit, so a heap that has grown and stays
    // allocated does not block scale-in.
    memoryTargetPercent: z.number().int().min(10).max(95).default(85),
    scaleInCooldownSeconds: z.number().int().min(0).default(120),
    scaleOutCooldownSeconds: z.number().int().min(0).default(60),
  })
  .refine((a) => a.max >= a.min, { message: 'autoscaling.max must be >= autoscaling.min' });

const serviceConfig = z.strictObject({
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
  .strictObject(
    Object.fromEntries(SERVICE_NAMES.map((n) => [n, serviceConfig.prefault({})])) as Record<
      ServiceName,
      z.ZodPrefault<typeof serviceConfig>
    >,
  )
  .strict();

export const configSchema = z
  .strictObject({
    env: envName,
    account: z.string().regex(/^\d{12}$/, 'AWS account must be 12 digits'),
    region: z.string().default('us-east-1'),

    // Container images. Services resolve `<registry>/<component>:<tag>`.
    image: z.strictObject({
      registry: z.string().default('ghcr.io/evtivity/evtivity-csms'),
      tag: z
        .string()
        .regex(/^[0-9][0-9A-Za-z._-]*$/, 'image.tag is a version such as 0.1.20 (no leading v)'),
    }),

    domain: z.strictObject({
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

    vpc: z.strictObject({
      cidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/, 'CIDR notation required'),
      // Listed explicitly so synth needs no AWS credentials or context lookups.
      availabilityZones: z
        .array(z.string().regex(/^[a-z]{2}-[a-z]+-\d[a-z]$/))
        .min(2)
        .max(3),
      nat: z
        .strictObject({
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
    }),

    logs: z
      .strictObject({
        retentionDays: logRetentionDays.default(30),
        removal: z.enum(['destroy', 'retain']).default('destroy'),
      })
      .prefault({}),

    ecs: z
      .strictObject({
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

    aurora: z.strictObject({
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

    valkey: z.strictObject({
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
      .strictObject({
        enabled: z.boolean().default(true),
        databaseDays: z.number().int().min(1).max(365).default(30),
        cacheDays: z.number().int().min(1).max(365).default(30),
      })
      .prefault({}),

    secrets: z
      .strictObject({
        // retain keeps JWT_SECRET, SETTINGS_ENCRYPTION_KEY, and the initial
        // admin secret when the stack is deleted, so data encrypted with the
        // settings key stays readable after a rebuild on a retained database.
        removal: z.enum(['destroy', 'retain']).default('destroy'),
      })
      .prefault({}),

    storage: z
      .strictObject({
        versioned: z.boolean().default(true),
        noncurrentVersionExpirationDays: z.number().int().min(1).default(30),
        logsExpirationDays: z.number().int().min(1).default(30),
        removal: z.enum(['destroy', 'retain']).default('destroy'),
        extraCorsOrigins: z.array(z.url()).default([]),
      })
      .prefault({}),

    alb: z
      .strictObject({
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
      .strictObject({
        enabled: z.boolean().default(false),
        // Requests per IP per 5 minutes. rateLimitPer5Min covers every host
        // except OCPP. The auth and guest limits count POSTs only.
        rateLimitPer5Min: z.number().int().min(100).default(2000),
        ocppRateLimitPer5Min: z.number().int().min(100).default(20000),
        authRateLimitPer5Min: z.number().int().min(10).default(50),
        guestRateLimitPer5Min: z.number().int().min(10).default(100),
        // POSTs per IP per 5 minutes to the Adyen webhook, which the country
        // rule exempts. Adyen batches events and retries failed deliveries.
        adyenWebhookRateLimitPer5Min: z.number().int().min(100).default(1000),
        // Seeds the WAF IP set that lets Stripe webhooks through. Source:
        // https://stripe.com/files/ips/ips_webhooks.json. Edit the live set
        // with scripts/stripe-webhook-ips.sh. An empty list removes the rule.
        stripeWebhookIps: z
          .array(z.cidrv4())
          .default(
            [
              '3.18.12.63',
              '3.69.109.8',
              '3.120.168.93',
              '3.130.192.231',
              '13.235.14.237',
              '13.235.122.149',
              '18.211.135.69',
              '35.154.171.200',
              '35.157.207.129',
              '52.15.183.38',
              '54.88.130.119',
              '54.88.130.237',
              '54.187.174.169',
              '54.187.205.235',
              '54.187.216.72',
            ].map((ip) => `${ip}/32`),
          ),
        // Only requests from these countries (ISO 3166-1 alpha-2) pass. An
        // empty list turns the rule off. The OCPP host is exempt, and the OCPP
        // TLS NLB bypasses the ALB entirely.
        allowCountries: z
          .array(z.string().regex(/^[A-Z]{2}$/, 'two uppercase letters (ISO 3166-1 alpha-2)'))
          .default(['US']),
        // Managed rules switched to count mode. Charging stations often send
        // no User-Agent, and bulk imports exceed the 8 KB body limit.
        countRules: z.array(z.string()).default(['NoUserAgent_HEADER', 'SizeRestrictions_BODY']),
        logRetentionDays: logRetentionDays.default(30),
      })
      .prefault({}),

    // SP3 mutual TLS for OCPP on an NLB with TCP passthrough. The secret
    // holds JSON keys cert, key, ca (PEM strings).
    ocppTls: z
      .strictObject({
        enabled: z.boolean().default(false),
        secretName: z.string().optional(),
        port: z.number().int().min(1).max(65535).default(8443),
        hostname: z.string().default('ocpp-tls'),
      })
      .prefault({}),
    // Client certificate for the charging station simulator (SP3 testing).
    cssTls: z
      .strictObject({
        enabled: z.boolean().default(false),
        secretName: z.string().optional(),
      })
      .prefault({}),

    ocpi: z
      .strictObject({
        countryCode: z.string().length(2).default('US'),
        partyId: z.string().min(1).max(3).default('EVT'),
        businessName: z.string().default('EVtivity'),
      })
      .prefault({}),

    initialAdmin: z.strictObject({ email: z.email() }),

    // Values upserted into the settings table on every database job run.
    // Non-secret settings only. Enter credentials in the dashboard.
    // Lists only for mobile.app.urlSchemes and mobile.app.androidPackageNames,
    // stored as JSON arrays.
    appSettings: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .default({}),

    // Demo dataset (sites, 2000 stations, operators, drivers, sessions,
    // simulator rows). Runs once after the database job, not on every
    // deploy. Bump revision to run it again (the seed skips when demo data is
    // already present). Demo operators and drivers get a generated password
    // from evtivity/<env>/demo-password, and operators must change it at
    // first sign-in. Not allowed in prod.
    seedDemo: z
      .strictObject({
        enabled: z.boolean().default(false),
        revision: z.number().int().min(1).default(1),
        // Seeded simulator stations left enabled for the css service. The
        // rest are disabled so a small css task is not flooded. 0 disables all.
        stationLimit: z.number().int().min(0).max(2000).default(50),
      })
      .prefault({}),

    // Allows the simulated (test) payment provider in the api, ocpp and worker
    // services (PAYMENTS_ALLOW_SIMULATED). It moves no money. Not allowed in
    // prod; required with seedDemo, whose drivers have simulated cards.
    payments: z
      .strictObject({
        allowSimulatedProvider: z.boolean().default(false),
      })
      .prefault({}),

    // Conformance (OCTT) runs started from the dashboard run in the worker.
    // With ocspResponder on, the worker starts the Test System OCSP responder
    // on OCTT_OCSP_RESPONDER_PORT during a run and the ocpp service reaches it
    // through Cloud Map (OCTT_OCSP_RESPONDER_URL). Off: the OCSP tests
    // (TC_C_50, TC_C_51, TC_C_52, TC_M_24) are skipped.
    octt: z
      .strictObject({
        ocspResponder: z.boolean().default(false),
      })
      .prefault({}),

    // Station connection authentications in the ocpp service, so a reconnect
    // wave cannot fill the database pool (OCPP_AUTH_MAX_CONCURRENT,
    // OCPP_AUTH_MAX_QUEUED, OCPP_AUTH_MAX_WAIT_MS). Unset: half of
    // aurora.poolMax at once, 1000 queued, 10000 ms wait. Over the queue or
    // the wait a station gets 503 with Retry-After.
    ocppConnectionAuth: z
      .strictObject({
        maxConcurrent: z.number().int().min(1).optional(),
        maxQueued: z.number().int().min(0).optional(),
        maxWaitMs: z.number().int().min(1).optional(),
      })
      .prefault({}),

    monitoring: z
      .strictObject({
        dashboard: z.boolean().default(true),
        alarms: z.boolean().default(true),
        alarmEmail: z.email().optional(),
      })
      .prefault({}),

    // Prometheus and Grafana with the Helm chart's dashboards and alert
    // rules. Prometheus runs in agent mode and writes to Amazon Managed
    // Service for Prometheus. Grafana reads logs from CloudWatch Logs.
    observability: z
      .strictObject({
        enabled: z.boolean().default(false),
        grafana: z
          .strictObject({
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
          .strictObject({
            version: z.string().default('v3.2.1'),
            scrapeIntervalSeconds: z.number().int().min(10).default(60),
            cpu: fargateCpu.default(256),
            memoryMiB: z.number().int().min(512).default(512),
            capacity: z.enum(['FARGATE', 'FARGATE_SPOT']).default('FARGATE'),
          })
          .prefault({}),
      })
      .prefault({}),

    services: servicesSchema,
  })
  .superRefine((c, ctx) => {
    // The notification test sink sends driver SMS and push to a local dev
    // service instead of Twilio and Expo. It is for the local stack only, so no
    // environment (prod, qa or dev) may set it, enabled service or not.
    for (const name of SERVICE_NAMES) {
      for (const block of ['env', 'secrets'] as const) {
        for (const key of NOTIFICATION_TEST_SINK_VARS) {
          if (key in c.services[name][block]) {
            ctx.addIssue({
              code: 'custom',
              path: ['services', name, block, key],
              message: `${key} is not allowed: the notification test sink is for the local development stack only`,
            });
          }
        }
      }
    }
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
    for (const name of SERVICE_NAMES) {
      const sc = c.services[name];
      // With autoscaling the template carries no task count, so a different
      // desiredCount would silently do nothing.
      if (sc.autoscaling != null && sc.desiredCount !== sc.autoscaling.min) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', name, 'desiredCount'],
          message: 'with autoscaling, set desiredCount equal to autoscaling.min',
        });
      }
    }
    for (const key of Object.keys(c.appSettings)) {
      if (key.endsWith('Enc')) {
        // The value would sit in plaintext in the task definition and template.
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: 'credentials (keys ending in Enc) must be entered in the dashboard',
        });
      }
      if (key === 'stripe.currency' || key === 'pricing.currency') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: 'removed: the platform runs in one currency, set company.currency',
        });
      }
      if (key === 'stripe.preAuthAmountCents' || key === 'stripe.platformFeePercent') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `moved to ${key.replace('stripe.', 'payments.')}: it applies to every payment provider`,
        });
      }
    }
    for (const [key, value] of Object.entries(c.appSettings)) {
      if (LIST_SETTING_KEYS.has(key)) {
        if (!Array.isArray(value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['appSettings', key],
            message:
              key === MOBILE_APP_URL_SCHEMES_KEY
                ? 'use a list of the custom URL schemes of your app builds, for example [evtivity]'
                : 'use a list of the Android application ids of your app builds, for example [com.evtivity.driver]',
          });
          continue;
        }
        value.forEach((entry, index) => {
          const valid =
            key === MOBILE_APP_URL_SCHEMES_KEY
              ? APP_URL_SCHEME_PATTERN.test(entry) && !RESERVED_URL_SCHEMES.has(entry)
              : ANDROID_PACKAGE_PATTERN.test(entry);
          if (valid) return;
          ctx.addIssue({
            code: 'custom',
            path: ['appSettings', key, index],
            message:
              key === MOBILE_APP_URL_SCHEMES_KEY
                ? `${entry} is not an app URL scheme: use the lowercase scheme of the app brand, not http, https or adyencheckout`
                : `${entry} is not an Android application id, for example com.evtivity.driver`,
          });
        });
      } else if (Array.isArray(value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `use a string, number, or boolean: lists are allowed only for ${[...LIST_SETTING_KEYS].join(' and ')}`,
        });
      }
    }
    const currency = c.appSettings['company.currency'];
    if (currency != null && !SUPPORTED_CURRENCIES.includes(String(currency))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'company.currency'],
        message: `unsupported currency ${String(currency)}: use an uppercase two-decimal ISO 4217 code such as USD or EUR`,
      });
    }
    for (const az of c.vpc.availabilityZones) {
      if (!az.startsWith(c.region)) {
        ctx.addIssue({
          code: 'custom',
          path: ['vpc', 'availabilityZones'],
          message: `${az} is not in region ${c.region}`,
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
    if (c.octt.ocspResponder) {
      const worker = c.services.worker;
      // The ocpp service resolves the worker through Cloud Map: with more than
      // one task it can reach a worker that is not running the conformance run.
      if (
        !worker.enabled ||
        worker.desiredCount > 1 ||
        (worker.autoscaling != null && worker.autoscaling.max > 1)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['octt', 'ocspResponder'],
          message: 'needs exactly one worker task (services.worker enabled, desiredCount 1)',
        });
      }
    }
    const authConcurrency = c.ocppConnectionAuth.maxConcurrent;
    if (authConcurrency != null && authConcurrency > c.aurora.poolMax) {
      // Lookups above the pool size wait in the driver and leave no connection
      // for the messages of stations already connected.
      ctx.addIssue({
        code: 'custom',
        path: ['ocppConnectionAuth', 'maxConcurrent'],
        message: 'must not exceed aurora.poolMax',
      });
    }
    if (c.payments.allowSimulatedProvider && c.env === 'prod') {
      ctx.addIssue({
        code: 'custom',
        path: ['payments', 'allowSimulatedProvider'],
        message: 'the simulated payment provider is not allowed in prod',
      });
    }
    if (c.seedDemo.enabled && !c.payments.allowSimulatedProvider) {
      ctx.addIssue({
        code: 'custom',
        path: ['payments', 'allowSimulatedProvider'],
        message: 'required with seedDemo.enabled: demo drivers pay with simulated cards',
      });
    }
    const paymentProvider = c.appSettings['payments.provider'];
    const paymentProviders = c.payments.allowSimulatedProvider
      ? ['none', 'stripe', 'simulated']
      : ['none', 'stripe'];
    if (paymentProvider === 'adyen') {
      // The settings are seeded while tasks of the previous release can still
      // run; those treat Adyen as payments off. The dashboard select checks
      // that no older process is connected first.
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'payments.provider'],
        message:
          'payment provider adyen cannot be set in the config: select Adyen in Settings > Payment after the upgrade',
      });
    } else if (paymentProvider != null && !paymentProviders.includes(String(paymentProvider))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'payments.provider'],
        message: `unsupported payment provider ${String(paymentProvider)}: use ${paymentProviders.join(', ')}`,
      });
    }
    // Provider-neutral payment and test provider settings, validated like the Helm chart
    // and the dashboard (PUT /v1/settings/payments).
    const numberIssue = (key: string, min: number, max: number, integer: boolean): void => {
      const value = c.appSettings[key];
      if (value == null) return;
      if (
        typeof value !== 'number' ||
        (integer && !Number.isInteger(value)) ||
        value < min ||
        value > max
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `use ${integer ? 'a whole number' : 'a number'} from ${String(min)} to ${String(max)}`,
        });
      }
    };
    numberIssue('payments.preAuthAmountCents', 1, 1_000_000, true);
    numberIssue('payments.platformFeePercent', 0, 100, false);
    numberIssue('simulated.asyncDelaySeconds', 0, 3600, true);
    numberIssue('simulated.randomFailureRate', 0, 1, false);
    // The prepaid low credit notice threshold, validated like the Helm chart and the API.
    numberIssue('prepaid.lowCreditThresholdCents', 0, 100_000_000, true);
    // Days from issue to the due date of a new invoice, validated like the Helm chart and the API.
    numberIssue('invoice.paymentTermsDays', 0, 365, true);
    // Day of the month of the monthly fleet invoice run, validated like the Helm chart and the API.
    numberIssue('fleet.invoiceRunDay', 1, 28, true);
    // Fleet credit an account session reserves per slice, validated like the Helm chart and the API.
    numberIssue('fleet.creditReservationCents', 1, 100_000_000, true);
    const simulatedResultMode = c.appSettings['simulated.resultMode'];
    if (
      simulatedResultMode != null &&
      simulatedResultMode !== 'sync' &&
      simulatedResultMode !== 'async'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'simulated.resultMode'],
        message: 'use sync or async',
      });
    }
    // Non-secret Adyen settings, validated like the Helm chart. Credentials go in the dashboard.
    const adyenIssue = (key: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: ['appSettings', key], message });
    };
    const adyenEnvironment = c.appSettings['adyen.environment'];
    if (adyenEnvironment != null && !['test', 'live'].includes(String(adyenEnvironment))) {
      adyenIssue('adyen.environment', 'use test or live');
    }
    const adyenLiveUrlPrefix = c.appSettings['adyen.liveUrlPrefix'];
    if (adyenEnvironment === 'live' && (adyenLiveUrlPrefix == null || adyenLiveUrlPrefix === '')) {
      adyenIssue('adyen.liveUrlPrefix', 'required when adyen.environment is live');
    }
    if (
      adyenLiveUrlPrefix != null &&
      adyenLiveUrlPrefix !== '' &&
      !/^[a-z0-9]+-[A-Za-z0-9]+$/.test(String(adyenLiveUrlPrefix))
    ) {
      adyenIssue(
        'adyen.liveUrlPrefix',
        'not an Adyen live URL prefix, for example 1797a841fbb37ca7-AdyenDemo',
      );
    }
    const adyenLiveRegion = c.appSettings['adyen.liveRegion'];
    if (
      adyenLiveRegion != null &&
      !['eu', 'us', 'au', 'nea', 'in'].includes(String(adyenLiveRegion))
    ) {
      adyenIssue('adyen.liveRegion', 'use eu, us, au, nea, or in');
    }
    const adyenAdjustment = c.appSettings['adyen.authorisationAdjustment'];
    if (adyenAdjustment != null && typeof adyenAdjustment !== 'boolean') {
      adyenIssue('adyen.authorisationAdjustment', 'use true or false');
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

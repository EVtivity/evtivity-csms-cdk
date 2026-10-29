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
import { SIZING_PRESETS } from './sizing.js';

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
// Browser origins allowed to call the MCP endpoint: scheme://host[:port],
// http or https, no path. The Helm chart uses the same pattern.
const AI_MCP_ALLOWED_ORIGINS_KEY = 'ai.mcp.allowedOrigins';
const ORIGIN_PATTERN =
  /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?$/;

// Roles that must use MFA at operator sign-in when security.mfa.required is
// roles. The Helm chart applies the same checks.
const MFA_REQUIRED_KEY = 'security.mfa.required';
const MFA_REQUIRED_MODES = ['off', 'all', 'roles'];
const MFA_REQUIRED_ROLES_KEY = 'security.mfa.requiredRoles';
const MFA_EMAIL_ENABLED_KEY = 'security.mfa.emailEnabled';
const MFA_TOTP_ENABLED_KEY = 'security.mfa.totpEnabled';
const MFA_WEBAUTHN_ENABLED_KEY = 'security.mfa.webauthnEnabled';
const MFA_PASSKEY_LOGIN_ENABLED_KEY = 'security.mfa.passkeyLoginEnabled';
// Every driver must use MFA at portal sign-in; the Helm chart applies the same checks.
const MFA_REQUIRE_DRIVERS_KEY = 'security.mfa.requireDrivers';
// SIM providers and station signal (v0.1.48), the limits of the CSMS `@evtivity/lib/sim-settings`
// and the Hologram adapter, copied because the CDK cannot import them (change both together).
// The Helm chart applies the same checks.
const SIM_OCPP16_SIGNAL_KEYS_KEY = 'sim.ocpp16.signalKeys';
const SIM_HOLOGRAM_ORG_ID_KEY = 'sim.hologram.orgId';
const SIM_HOLOGRAM_ORG_ID_PATTERN = /^\d{1,15}$/;
// The 1NCE client id (v0.1.49): `isOneNceClientId` of `@evtivity/lib/sim-settings`, 1 to 128
// printable ASCII characters without a space or colon (change both together).
const SIM_ONENCE_CLIENT_ID_KEY = 'sim.1nce.clientId';
const SIM_ONENCE_CLIENT_ID_PATTERN = /^[!-9;-~]{1,128}$/;
// The ID TECH payment terminal settings (v0.1.49): `isIdtechEnvironment` and
// `isIdtechMerchantId` of `@evtivity/lib/payment-terminal-settings` (change both together).
const IDTECH_ENABLED_KEY = 'paymentTerminals.idtech.enabled';
const IDTECH_ENVIRONMENT_KEY = 'paymentTerminals.idtech.environment';
const IDTECH_ENVIRONMENTS = ['sandbox', 'production'];
const IDTECH_MERCHANT_ID_KEY = 'paymentTerminals.idtech.merchantId';
const IDTECH_MERCHANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDTECH_SECRET_KEYS = [
  'paymentTerminals.idtech.apiKey',
  'paymentTerminals.idtech.apiSecret',
  'paymentTerminals.idtech.webhookSecret',
];
const SIM_SIGNAL_GOOD_DBM_KEY = 'sim.signal.goodDbm';
const SIM_SIGNAL_FAIR_DBM_KEY = 'sim.signal.fairDbm';
// WebAuthn relying party ID (services.api.env.WEBAUTHN_RP_ID): a domain name with at least two
// labels (not an IP address), the CSMS host or a parent domain of it. Case does not matter: the
// API and the Helm chart lowercase it, and loadConfig deploys it lowercased. The API refuses to
// start otherwise; the Helm chart applies the same check.
const WEBAUTHN_RP_ID_ENV = 'WEBAUTHN_RP_ID';

/** WEBAUTHN_RP_ID as the API reads it: trimmed and lowercased, or null when unset or blank. */
export function webauthnRpIdOf(c: {
  services: { api: { env: Record<string, string> } };
}): string | null {
  const raw = c.services.api.env[WEBAUTHN_RP_ID_ENV];
  if (raw == null) return null;
  const rpId = raw.trim().toLowerCase();
  return rpId === '' ? null : rpId;
}
const DOMAIN_NAME_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

interface ListSettingRule {
  listMessage: string;
  maxEntries?: number;
  unique?: boolean;
  valid: (entry: string) => boolean;
  entryMessage: (entry: string) => string;
}

const LIST_SETTING_RULES: Record<string, ListSettingRule> = {
  [MOBILE_APP_URL_SCHEMES_KEY]: {
    listMessage: 'use a list of the custom URL schemes of your app builds, for example [evtivity]',
    valid: (entry) => APP_URL_SCHEME_PATTERN.test(entry) && !RESERVED_URL_SCHEMES.has(entry),
    entryMessage: (entry) =>
      `${entry} is not an app URL scheme: use the lowercase scheme of the app brand, not http, https or adyencheckout`,
  },
  [MOBILE_APP_ANDROID_PACKAGES_KEY]: {
    listMessage:
      'use a list of the Android application ids of your app builds, for example [com.evtivity.driver]',
    valid: (entry) => ANDROID_PACKAGE_PATTERN.test(entry),
    entryMessage: (entry) =>
      `${entry} is not an Android application id, for example com.evtivity.driver`,
  },
  [AI_MCP_ALLOWED_ORIGINS_KEY]: {
    listMessage: 'use a list of origins, for example [https://agent.example.com]',
    maxEntries: 50,
    valid: (entry) => ORIGIN_PATTERN.test(entry),
    entryMessage: (entry) =>
      `${entry} is not an origin: use scheme://host[:port] with http or https and no path`,
  },
  // The dashboard caps: at most 50 roles, each at most 100 characters (PUT /v1/security/mfa).
  [MFA_REQUIRED_ROLES_KEY]: {
    listMessage: 'use a list of role names, for example [Admin]',
    maxEntries: 50,
    unique: true,
    valid: (entry) => entry.trim() !== '' && entry.length <= 100,
    entryMessage: (entry) =>
      entry.trim() === ''
        ? `"${entry}" is not a role name: use a non-empty role name`
        : `"${entry}" is longer than 100 characters, the longest role name the dashboard accepts`,
  },
  // OCPP 1.6 configuration keys read for the station signal: at most 20, each at most 50
  // characters (CiString50), as PUT /v1/settings/sim-providers accepts.
  [SIM_OCPP16_SIGNAL_KEYS_KEY]: {
    listMessage: 'use a list of OCPP 1.6 configuration key names, for example [SignalStrength]',
    maxEntries: 20,
    unique: true,
    valid: (entry) => entry.trim() !== '' && entry.trim().length <= 50,
    entryMessage: (entry) =>
      entry.trim() === ''
        ? `"${entry}" is not a configuration key name: use a non-empty key name`
        : `"${entry}" is longer than 50 characters, the longest OCPP 1.6 configuration key`,
  },
};
const LIST_SETTING_KEYS = new Set(Object.keys(LIST_SETTING_RULES));

// AI assistant settings. Mirrors the provider registry and the effort levels
// in the CSMS repo (packages/api/src/services/ai/), which the Helm chart repeats.
const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek'];
const AI_EFFORTS = ['low', 'medium', 'high'];
const AI_SUPPORT_TONES = ['professional', 'friendly', 'formal'];
const AI_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];
// Boolean AI settings (operations AI, driver support AI, insights, workers, MCP).
const AI_BOOLEAN_KEYS = [
  'opsAi.enabled',
  'driverAi.enabled',
  'aiInsights.station.enabled',
  'aiInsights.session.enabled',
  'aiInsights.authorization.enabled',
  'aiInsights.reservation.enabled',
  'aiWorkers.networkSummary.enabled',
  'aiWorkers.stuckSessions.enabled',
  'aiWorkers.stuckSessions.useModel',
  'aiWorkers.tariffAnomalies.enabled',
  'ai.mcp.enabled',
  'ai.mcp.allowWrites',
];
// Replaced by <surface>.effort.
const REMOVED_AI_SAMPLING_KEYS = new Set(
  ['chatbotAi', 'supportAi'].flatMap((s) => [`${s}.temperature`, `${s}.topP`, `${s}.topK`]),
);

// Data retention is set in the CSMS under Settings > Data Retention (v0.1.48):
// a deploy no longer writes these keys, so an old value fails the config load.
const DATA_RETENTION_KEYS = new Set([
  'audit.retentionDays',
  'refreshTokens.retentionDays',
  'logs.access.retentionDays',
  'logs.ocppMessage.retentionDays',
  'logs.domainEvents.retentionDays',
  'logs.meterValues.retentionDays',
  'logs.connection.retentionDays',
  'logs.notifications.retentionDays',
  'logs.securityEvents.retentionDays',
  'logs.portStatus.retentionDays',
  'logs.workerJob.retentionDays',
  'logs.loadAllocation.retentionDays',
  'logs.loginAudit.retentionDays',
  'sim.sessions.retentionDays',
  'ai.conversationRetentionDays',
  'aiInsights.retentionDays',
]);

const IBAN_FORMAT = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const BIC_FORMAT = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** An IBAN without spaces in upper case that passes the ISO 13616 mod-97 check. */
function isValidIban(iban: string): boolean {
  if (!IBAN_FORMAT.test(iban)) return false;
  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const digits = /[0-9]/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * A value in appSettings. Lists are allowed only for the mobile.app.* keys, ai.mcp.allowedOrigins,
 * security.mfa.requiredRoles and sim.ocpp16.signalKeys.
 */
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

/** Env var that points the CSMS SIM provider adapters at a local mock, refused in every environment. */
const SIM_PROVIDER_TEST_BASE_URL = 'SIM_PROVIDER_TEST_BASE_URL';

/** Env var that points the CSMS ID TECH terminal adapter at a local mock, refused in every environment. */
const PAYMENT_TERMINAL_TEST_BASE_URL = 'PAYMENT_TERMINAL_TEST_BASE_URL';

/**
 * Env vars the stack derives itself (app-stack.ts), refused in every service
 * `env` and `secrets` in every environment: the service env is applied after
 * the derived values, so `PAYMENTS_ALLOW_SIMULATED: 'true'` or
 * `NODE_ENV: test` there undid the prod refusal of the simulated provider and
 * the weak secret checks (security review R2-L1). Set them through their
 * config fields (`payments.allowSimulatedProvider`,
 * `paymentTerminals.allowSimulatedProvider`, `seedDemo.enabled`, the domain).
 */
export const DERIVED_SERVICE_ENV_VARS = [
  'NODE_ENV',
  'PAYMENTS_ALLOW_SIMULATED',
  'PAYMENT_TERMINALS_ALLOW_SIMULATED',
  'SEED_DEMO',
  'TRUST_PROXY',
  'OCPP_TRUSTED_PROXY_CIDRS',
  'CORS_ORIGIN',
  'COOKIE_DOMAIN',
  'JWT_SECRET',
  'SETTINGS_ENCRYPTION_KEY',
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

/** A prod protection turned off on purpose, with the reason (SH-L44). */
const prodOverride = z.strictObject({
  reason: z.string().trim().min(10, 'name the reason in at least 10 characters'),
});

export const configSchema = z
  .strictObject({
    env: envName,
    account: z.string().regex(/^\d{12}$/, 'AWS account must be 12 digits'),
    region: z.string().default('us-east-1'),

    // Sizing preset. `prod` gives this environment the sizing and topology of
    // config/prod.yaml (services, Aurora, Valkey, NAT, interface endpoints,
    // WAF limits, Container Insights) and keeps its own identity and safety
    // settings. Values in <env>.local.yaml still win. Also set with
    // `--context sizing=prod`. See lib/config/sizing.ts and docs/deployment.md.
    sizing: z.enum(SIZING_PRESETS).optional(),

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
      // Automatic failover and Multi-AZ. Unset: on when replicas > 0. An
      // existing single node cannot get a replica and Multi-AZ in one update,
      // so add replicas with multiAz: false first, then remove the override
      // (docs/deployment.md#valkey-replicas).
      multiAz: z.boolean().optional(),
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
        // heartbeats and pings keep station connections alive. The default
        // is above the largest CSMS or station ping interval plus 30 seconds:
        // the station data plans ping after 120 s (Wi-Fi or wired) or 240 s
        // (Cellular) without a frame, and stations ping every 300 s or 240 s
        // with the plan templates.
        // The AI assistant streams over SSE with a 15-second heartbeat, so the
        // timeout must stay at 60 seconds or more.
        idleTimeoutSeconds: z
          .number()
          .int()
          .min(60, 'must be at least 60: AI assistant streams send a heartbeat every 15 seconds')
          .max(4000)
          .default(600),
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
        // POSTs per IP per 5 minutes to the payment provider webhooks the
        // country rule exempts: Adyen and the payment terminal providers
        // (PaymentWebhookRateLimit). Adyen batches events and retries failed deliveries.
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
    // Lists only for mobile.app.urlSchemes, mobile.app.androidPackageNames,
    // ai.mcp.allowedOrigins and security.mfa.requiredRoles, stored as JSON arrays.
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

    // Allows the simulated payment terminal provider in the api and worker
    // services (PAYMENT_TERMINALS_ALLOW_SIMULATED). It moves no money. Not
    // allowed in prod. The demo seed creates no terminals, so seedDemo does
    // not need it.
    paymentTerminals: z
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
        // Upgrade requests from one station IP (an IPv6 /64) whose
        // authentication is still running (OCPP_MAX_PENDING_AUTH_PER_IP).
        // Unset: the server default, 50. The ALB is a trusted proxy, so the
        // station address comes from its X-Forwarded-For.
        maxPendingPerIp: z.number().int().min(1).optional(),
      })
      .prefault({}),

    // A prod config may turn off a protection only with a reason on record:
    // overrides.<name>.reason, at least 10 characters (SH-L44).
    overrides: z
      .strictObject({
        waf: prodOverride,
        auroraDeletionProtection: prodOverride,
        albDeletionProtection: prodOverride,
        ecsExecuteCommand: prodOverride,
      })
      .partial()
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
            version: z.string().default('11.5.10'),
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
            version: z.string().default('v3.15.1'),
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
        for (const key of DERIVED_SERVICE_ENV_VARS) {
          if (key in c.services[name][block]) {
            ctx.addIssue({
              code: 'custom',
              path: ['services', name, block, key],
              message: `${key} is set by the stack and cannot be overridden in services.${name}.${block}`,
            });
          }
        }
        // The SIM provider mock would receive the SIM provider credentials: local stack only.
        if (SIM_PROVIDER_TEST_BASE_URL in c.services[name][block]) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', name, block, SIM_PROVIDER_TEST_BASE_URL],
            message: `${SIM_PROVIDER_TEST_BASE_URL} is not allowed: the SIM provider mock is for the local development stack only`,
          });
        }
        // The terminal mock would receive the ID TECH credentials: local stack only.
        if (PAYMENT_TERMINAL_TEST_BASE_URL in c.services[name][block]) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', name, block, PAYMENT_TERMINAL_TEST_BASE_URL],
            message: `${PAYMENT_TERMINAL_TEST_BASE_URL} is not allowed: the payment terminal mock is for the local development stack only`,
          });
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
      if (DATA_RETENTION_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'removed: data retention is set in the CSMS under Settings > Data Retention, not in appSettings',
        });
      }
      if (key === 'stripe.currency' || key === 'pricing.currency') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: 'removed: the platform runs in one currency, set company.currency',
        });
      }
      if (REMOVED_AI_SAMPLING_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `removed: set ${key.slice(0, key.indexOf('.'))}.effort (low, medium, or high) instead`,
        });
      }
      if (key === 'ai.mcp.proposalTtlMinutes') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'removed: MCP writes no longer become proposals, set ai.mcp.allowWrites (true or false) instead',
        });
      }
      if (key === 'chatbotAi.apiKey' || key === 'supportAi.apiKey') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'removed: API keys are stored once per provider as ai.<provider>.apiKeyEnc, entered in the dashboard',
        });
      }
      if (key === 'sim.hologram.apiKey') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'credentials must be entered in the dashboard: the Hologram API key is stored as sim.hologram.apiKeyEnc',
        });
      }
      if (key === 'sim.1nce.clientSecret') {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'credentials must be entered in the dashboard: the 1NCE client secret is stored as sim.1nce.clientSecretEnc',
        });
      }
      if (IDTECH_SECRET_KEYS.includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `credentials must be entered in the dashboard: the ID TECH secret is stored as ${key}Enc`,
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
        const rule = LIST_SETTING_RULES[key];
        if (rule == null) continue;
        if (!Array.isArray(value)) {
          ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: rule.listMessage });
          continue;
        }
        if (rule.maxEntries != null && value.length > rule.maxEntries) {
          ctx.addIssue({
            code: 'custom',
            path: ['appSettings', key],
            message: `use at most ${String(rule.maxEntries)} entries`,
          });
        }
        if (rule.unique === true && new Set(value).size !== value.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['appSettings', key],
            message: 'name each entry once',
          });
        }
        value.forEach((entry, index) => {
          if (rule.valid(entry)) return;
          ctx.addIssue({
            code: 'custom',
            path: ['appSettings', key, index],
            message: rule.entryMessage(entry),
          });
        });
      } else if (Array.isArray(value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `use a string, number, or boolean: lists are allowed only for ${[...LIST_SETTING_KEYS].join(', ')}`,
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
    if (c.env === 'prod') {
      // The protections prod relies on. Each can be turned off only with a
      // reason in overrides (SH-L44): WAF is the only cross-task rate limit
      // in front of the ALB, deletion protection keeps a stack deletion from
      // dropping the database or the load balancer, and ECS Exec opens a
      // shell into running tasks.
      const weakened: Array<[boolean, keyof typeof c.overrides, string[], string]> = [
        [!c.waf.enabled, 'waf', ['waf', 'enabled'], 'must be true in prod'],
        [
          !c.aurora.deletionProtection,
          'auroraDeletionProtection',
          ['aurora', 'deletionProtection'],
          'must be true in prod',
        ],
        [
          !c.alb.deletionProtection,
          'albDeletionProtection',
          ['alb', 'deletionProtection'],
          'must be true in prod',
        ],
        [
          c.ecs.executeCommand,
          'ecsExecuteCommand',
          ['ecs', 'executeCommand'],
          'must be false in prod',
        ],
      ];
      for (const [weak, name, path, message] of weakened) {
        if (weak && c.overrides[name] == null) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `${message} (or set overrides.${name}.reason)`,
          });
        }
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
    if (c.paymentTerminals.allowSimulatedProvider && c.env === 'prod') {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentTerminals', 'allowSimulatedProvider'],
        message: 'the simulated payment terminal provider is not allowed in prod',
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
    // AI assistant settings, validated like the Helm chart and the API.
    numberIssue('ai.rateLimit.userPerMinute', 1, 1000, true);
    numberIssue('ai.rateLimit.sitePerMinute', 1, 100_000, true);
    numberIssue('ai.budget.userDailyTokens', 0, 10_000_000_000, true);
    numberIssue('ai.maxToolCallsPerTurn', 1, 100, true);
    numberIssue('ai.attachments.maxBytes', 1, 33_554_432, true);
    numberIssue('ai.attachments.maxPerMessage', 1, 20, true);
    numberIssue('ai.budget.companyMonthlyTokens', 0, 1_000_000_000_000, true);
    numberIssue('ai.budget.siteMonthlyTokens', 0, 1_000_000_000_000, true);
    numberIssue('ai.budget.siteDailyTokens', 0, 10_000_000_000, true);
    numberIssue('ai.budget.warnPercent', 1, 100, true);
    numberIssue('ai.mcp.rateLimitPerMinute', 1, 10_000, true);
    numberIssue('ai.mcp.dailyCallsPerKey', 1, 10_000_000, true);
    numberIssue('aiInsights.debounceSeconds', 0, 3600, true);
    numberIssue('aiInsights.cooldownMinutes', 1, 10_080, true);
    numberIssue('aiInsights.siteIncidentThreshold', 2, 1000, true);
    numberIssue('aiInsights.maxPerSitePerDay', 1, 10_000, true);
    // Days before a one-off event insight still open is closed expired (v0.1.46).
    numberIssue('aiInsights.expireAfterDays', 1, 365, true);
    numberIssue('aiWorkers.stuckSessions.idleMinutes', 15, 1440, true);
    // Hours offline before a stuck session gets the CSMS end proposal (v0.1.46).
    numberIssue('aiWorkers.stuckSessions.offlineEndAfterHours', 1, 720, true);
    numberIssue('aiWorkers.proposalTtlHours', 1, 168, true);
    // Driver support AI (v0.1.45), validated like the Helm chart and the API.
    numberIssue('driverAi.maxCasesPerDriverPerDay', 1, 100, true);
    numberIssue('driverAi.feedbackTimeoutHours', 1, 168, true);
    numberIssue('ai.budget.driverDailyTokens', 0, 10_000_000_000, true);
    numberIssue('ai.rateLimit.driverPerMinute', 1, 1000, true);
    // Invoice payment information (v0.1.47), validated like the Helm chart and the API
    // (`@evtivity/lib/invoice-payment`, copied because the CDK cannot import it).
    const iban = c.appSettings['company.iban'];
    if (iban != null && iban !== '' && (typeof iban !== 'string' || !isValidIban(iban))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'company.iban'],
        message: 'use a valid IBAN without spaces in upper case (ISO 13616 checksum), or ""',
      });
    }
    const bic = c.appSettings['company.bic'];
    if (bic != null && bic !== '' && (typeof bic !== 'string' || !BIC_FORMAT.test(bic))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'company.bic'],
        message: 'use a BIC of 8 or 11 letters and digits in upper case, or ""',
      });
    }
    for (const [key, max] of [
      ['company.bankAccountHolder', 70],
      ['company.bankName', 100],
    ] as const) {
      const value = c.appSettings[key];
      if (
        value != null &&
        (typeof value !== 'string' || CONTROL_CHARACTERS.test(value) || value.trim().length > max)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message: `use one line of at most ${String(max)} characters`,
        });
      }
    }
    const epcQrEnabled = c.appSettings['invoice.epcQrEnabled'];
    if (epcQrEnabled != null && typeof epcQrEnabled !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'invoice.epcQrEnabled'],
        message: 'use true or false',
      });
    }
    // Password policy and session lifetimes (v0.1.48), validated like the Helm chart and the API
    // (`@evtivity/lib/password-policy` and `session-lifetimes`, copied because the CDK cannot
    // import them). Stored as JSON numbers and booleans: the API falls back to the default for a
    // row of another type.
    numberIssue('security.password.minLength', 8, 64, true);
    numberIssue('security.session.operatorAccessMinutes', 5, 1440, true);
    numberIssue('security.session.operatorRefreshDays', 1, 90, true);
    numberIssue('security.session.driverAccessMinutes', 5, 1440, true);
    numberIssue('security.session.driverRefreshDays', 1, 365, true);
    for (const key of [
      'security.password.requireUppercase',
      'security.password.requireLowercase',
      'security.password.requireNumber',
      'security.password.requireSymbol',
    ]) {
      const value = c.appSettings[key];
      if (value != null && typeof value !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: 'use true or false' });
      }
    }
    // SIM providers and station signal (v0.1.48), validated like the Helm chart and
    // PUT /v1/settings/sim-providers. Stored as JSON booleans, numbers and a string: the API takes
    // the default for a row of another type. The low signal alert is turned off in the dashboard.
    numberIssue('sim.sessions.fetchDays', 1, 31, true);
    numberIssue('sim.signal.alertBelowDbm', -140, -40, true);
    numberIssue(SIM_SIGNAL_GOOD_DBM_KEY, -140, -40, true);
    numberIssue(SIM_SIGNAL_FAIR_DBM_KEY, -140, -40, true);
    for (const key of ['sim.hologram.enabled', 'sim.1nce.enabled', 'sim.stationSignal.enabled']) {
      const value = c.appSettings[key];
      if (value != null && typeof value !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: 'use true or false' });
      }
    }
    const simOrgId = c.appSettings[SIM_HOLOGRAM_ORG_ID_KEY];
    if (
      simOrgId != null &&
      (typeof simOrgId !== 'string' || !SIM_HOLOGRAM_ORG_ID_PATTERN.test(simOrgId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', SIM_HOLOGRAM_ORG_ID_KEY],
        message: 'use the Hologram organization id as a quoted string of 1 to 15 digits',
      });
    }
    const oneNceClientId = c.appSettings[SIM_ONENCE_CLIENT_ID_KEY];
    if (
      oneNceClientId != null &&
      (typeof oneNceClientId !== 'string' || !SIM_ONENCE_CLIENT_ID_PATTERN.test(oneNceClientId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', SIM_ONENCE_CLIENT_ID_KEY],
        message:
          'use the 1NCE API client id: 1 to 128 printable characters without a space or colon',
      });
    }
    // Payment terminals (v0.1.49), validated like the Helm chart and
    // PUT /v1/settings/payment-terminals.
    const idtechEnabled = c.appSettings[IDTECH_ENABLED_KEY];
    if (idtechEnabled != null && typeof idtechEnabled !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', IDTECH_ENABLED_KEY],
        message: 'use true or false',
      });
    }
    const idtechEnvironment = c.appSettings[IDTECH_ENVIRONMENT_KEY];
    if (
      idtechEnvironment != null &&
      (typeof idtechEnvironment !== 'string' || !IDTECH_ENVIRONMENTS.includes(idtechEnvironment))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', IDTECH_ENVIRONMENT_KEY],
        message: 'use sandbox or production',
      });
    }
    const idtechMerchantId = c.appSettings[IDTECH_MERCHANT_ID_KEY];
    if (
      idtechMerchantId != null &&
      (typeof idtechMerchantId !== 'string' || !IDTECH_MERCHANT_ID_PATTERN.test(idtechMerchantId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', IDTECH_MERCHANT_ID_KEY],
        message:
          'use the ID TECH merchant id as a quoted string of 1 to 64 letters, numbers, _ or -',
      });
    }
    const goodDbm = c.appSettings[SIM_SIGNAL_GOOD_DBM_KEY];
    const fairDbm = c.appSettings[SIM_SIGNAL_FAIR_DBM_KEY];
    if (typeof goodDbm === 'number' && typeof fairDbm === 'number' && goodDbm <= fairDbm) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', SIM_SIGNAL_GOOD_DBM_KEY],
        message: `${SIM_SIGNAL_GOOD_DBM_KEY} must be above ${SIM_SIGNAL_FAIR_DBM_KEY}`,
      });
    }
    // Passkeys and security keys (v0.1.48): stored as JSON booleans; passkey sign-in uses
    // passkeys, so it cannot be on while they are set to false.
    for (const key of [
      MFA_WEBAUTHN_ENABLED_KEY,
      MFA_PASSKEY_LOGIN_ENABLED_KEY,
      MFA_REQUIRE_DRIVERS_KEY,
    ]) {
      const value = c.appSettings[key];
      if (value != null && typeof value !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: 'use true or false' });
      }
    }
    if (
      c.appSettings[MFA_PASSKEY_LOGIN_ENABLED_KEY] === true &&
      c.appSettings[MFA_WEBAUTHN_ENABLED_KEY] === false
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', MFA_PASSKEY_LOGIN_ENABLED_KEY],
        message: `${MFA_PASSKEY_LOGIN_ENABLED_KEY} true needs ${MFA_WEBAUTHN_ENABLED_KEY}: passkey sign-in uses passkeys`,
      });
    }
    const rpId = webauthnRpIdOf(c);
    if (rpId != null) {
      const zone =
        c.domain.subdomain === '' ? c.domain.apex : `${c.domain.subdomain}.${c.domain.apex}`;
      const csmsLabel = c.services.csms.hostname ?? SERVICE_CATALOG.csms.hostname ?? 'csms';
      const csmsHost = `${csmsLabel}.${zone}`.toLowerCase();
      if (!DOMAIN_NAME_PATTERN.test(rpId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'api', 'env', WEBAUTHN_RP_ID_ENV],
          message: 'use a lowercase domain name without a scheme, port or path',
        });
      } else if (/(^|\.)\d+$/.test(rpId)) {
        // Browsers refuse an IP address as a relying party ID.
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'api', 'env', WEBAUTHN_RP_ID_ENV],
          message: 'use a domain name, not an IP address',
        });
      } else if (!rpId.includes('.') && rpId !== 'localhost') {
        // A single label (com, intranet) is a public suffix or a bare host name.
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'api', 'env', WEBAUTHN_RP_ID_ENV],
          message: 'use a domain name with at least two labels (example.com), or localhost',
        });
      } else if (/^[\d.]+$/.test(csmsHost) || csmsHost.includes(':')) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'api', 'env', WEBAUTHN_RP_ID_ENV],
          message: `the CSMS host ${csmsHost} is an IP address: passkeys need a domain name`,
        });
      } else if (csmsHost !== rpId && !csmsHost.endsWith(`.${rpId}`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'api', 'env', WEBAUTHN_RP_ID_ENV],
          message: `use the CSMS host ${csmsHost} or a parent domain of it`,
        });
      }
    }
    // Required MFA at operator sign-in (v0.1.48): off, all, or roles with at least one role in
    // security.mfa.requiredRoles (list entries are checked with the other lists).
    const mfaRequired = c.appSettings[MFA_REQUIRED_KEY];
    if (
      mfaRequired != null &&
      (typeof mfaRequired !== 'string' || !MFA_REQUIRED_MODES.includes(mfaRequired))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', MFA_REQUIRED_KEY],
        message: `use ${MFA_REQUIRED_MODES.join(', ')}`,
      });
    }
    const mfaRequiredRoles = c.appSettings[MFA_REQUIRED_ROLES_KEY];
    if (
      mfaRequired === 'roles' &&
      !(Array.isArray(mfaRequiredRoles) && mfaRequiredRoles.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', MFA_REQUIRED_ROLES_KEY],
        message: `${MFA_REQUIRED_KEY} roles needs at least one role in ${MFA_REQUIRED_ROLES_KEY}`,
      });
    }
    // Required MFA needs a method an operator can set up without a phone. Only keys set to
    // false count: a key left out keeps the dashboard value, which may be on.
    if (
      (mfaRequired === 'all' || mfaRequired === 'roles') &&
      c.appSettings[MFA_EMAIL_ENABLED_KEY] === false &&
      c.appSettings[MFA_TOTP_ENABLED_KEY] === false
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', MFA_REQUIRED_KEY],
        message: `${MFA_REQUIRED_KEY} ${mfaRequired} needs ${MFA_EMAIL_ENABLED_KEY} or ${MFA_TOTP_ENABLED_KEY}: with both false no operator without a phone can set up MFA`,
      });
    }
    if (
      c.appSettings[MFA_REQUIRE_DRIVERS_KEY] === true &&
      c.appSettings[MFA_EMAIL_ENABLED_KEY] === false &&
      c.appSettings[MFA_TOTP_ENABLED_KEY] === false
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', MFA_REQUIRE_DRIVERS_KEY],
        message: `${MFA_REQUIRE_DRIVERS_KEY} true needs ${MFA_EMAIL_ENABLED_KEY} or ${MFA_TOTP_ENABLED_KEY}: with both false no driver without a phone can set up MFA`,
      });
    }
    for (const key of AI_BOOLEAN_KEYS) {
      const value = c.appSettings[key];
      if (value != null && typeof value !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: 'use true or false' });
      }
    }
    for (const key of [
      'opsAi.model',
      'opsAi.systemPrompt',
      'driverAi.model',
      'driverAi.systemPrompt',
    ]) {
      const value = c.appSettings[key];
      if (value != null && typeof value !== 'string') {
        ctx.addIssue({ code: 'custom', path: ['appSettings', key], message: 'use a string' });
      }
    }
    const insightLanguage = c.appSettings['aiInsights.primaryLanguage'];
    if (insightLanguage != null && !AI_LANGUAGES.includes(String(insightLanguage))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'aiInsights.primaryLanguage'],
        message: `use ${AI_LANGUAGES.join(', ')}`,
      });
    }
    const supportTone = c.appSettings['supportAi.tone'];
    if (supportTone != null && !AI_SUPPORT_TONES.includes(String(supportTone))) {
      ctx.addIssue({
        code: 'custom',
        path: ['appSettings', 'supportAi.tone'],
        message: `use ${AI_SUPPORT_TONES.join(', ')}`,
      });
    }
    for (const surface of ['chatbotAi', 'supportAi', 'opsAi', 'driverAi']) {
      const effort = c.appSettings[`${surface}.effort`];
      if (effort != null && !AI_EFFORTS.includes(String(effort))) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', `${surface}.effort`],
          message: `use ${AI_EFFORTS.join(', ')}`,
        });
      }
      const provider = c.appSettings[`${surface}.provider`];
      if (provider != null && provider !== '' && !AI_PROVIDERS.includes(String(provider))) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', `${surface}.provider`],
          message: `unsupported AI provider ${String(provider)}: use ${AI_PROVIDERS.join(', ')}, or leave it empty`,
        });
      }
    }
    for (const provider of AI_PROVIDERS) {
      const key = `ai.${provider}.baseUrl`;
      const baseUrl = c.appSettings[key];
      if (baseUrl == null || baseUrl === '') continue;
      // The API sends the provider key to this address.
      const url = typeof baseUrl === 'string' ? URL.parse(baseUrl) : null;
      if (
        url == null ||
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['appSettings', key],
          message:
            'use an https URL without credentials, query, or fragment, or leave it empty for the official endpoint',
        });
      }
    }
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
    if (c.valkey.multiAz === true && c.valkey.replicas === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['valkey', 'multiAz'],
        message: 'needs valkey.replicas of 1 or more',
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

/**
 * A note when WEBAUTHN_RP_ID is set and is not the portal host or a parent domain of it:
 * the API then uses the portal host as the driver relying party, so drivers and operators
 * keep separate passkeys. Null otherwise.
 */
export function webauthnPortalRpNote(c: Config): string | null {
  const rpId = webauthnRpIdOf(c);
  if (rpId == null) return null;
  const zone = c.domain.subdomain === '' ? c.domain.apex : `${c.domain.subdomain}.${c.domain.apex}`;
  const portalLabel = c.services.portal.hostname ?? SERVICE_CATALOG.portal.hostname ?? 'portal';
  const portalHost = `${portalLabel}.${zone}`.toLowerCase();
  if (portalHost === rpId || portalHost.endsWith(`.${rpId}`)) return null;
  return `WEBAUTHN_RP_ID ${rpId} is not the portal host ${portalHost} or a parent domain of it: the portal uses ${portalHost} as its passkey relying party, so drivers and operators keep separate passkeys`;
}

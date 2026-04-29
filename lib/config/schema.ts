// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const envName = z.enum(['dev', 'qa', 'prod']);
export type EnvName = z.infer<typeof envName>;

const cpu = z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]);

const tagMap = z.record(z.string(), z.string()).default({});

const serviceConfig = z
  .object({
    enabled: z.boolean().default(true),
    imageRepo: z.string().min(1),
    imageTag: z.string().min(1),
    cpu,
    memoryMiB: z.number().int().positive(),
    desiredCount: z.number().int().min(0).default(1),
    minCount: z.number().int().min(0).default(1),
    maxCount: z.number().int().min(1).default(2),
    containerPort: z.number().int().min(1).max(65535).optional(),
    healthCheckPath: z.string().default('/health'),
    healthCheckHttpCode: z.string().default('200'),
    public: z.boolean().default(false),
    hostnamePrefix: z.string().optional(),
    albPriority: z.number().int().min(1).max(50000).optional(),
    env: z.record(z.string(), z.string()).default({}),
    envFromSsm: z.record(z.string(), z.string()).default({}),
    secretsFromSecretsManager: z.record(z.string(), z.string()).default({}),
    isOneShot: z.boolean().default(false),
    readonlyRootFilesystem: z.boolean().default(true),
  })
  .refine(
    (s) => !s.public || (s.containerPort != null && s.hostnamePrefix != null && s.albPriority != null),
    { message: 'public services require containerPort, hostnamePrefix, albPriority' },
  );

export type ServiceConfig = z.infer<typeof serviceConfig>;

export const configSchema = z.object({
  env: envName,
  account: z.string().regex(/^\d{12}$/, 'AWS account must be 12 digits'),
  region: z.literal('us-east-1'),

  domain: z.object({
    apex: z.string().min(1),
    subdomain: z.string().min(1),
    hostedZoneId: z.string().optional(),
  }),

  tags: tagMap,

  vpc: z.object({
    cidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/, 'CIDR notation required'),
    maxAzs: z.number().int().min(2).max(3).default(3),
    natCount: z.number().int().min(1).max(3).default(1),
  }),

  aurora: z.object({
    minCapacity: z.number().min(0.5),
    maxCapacity: z.number().min(0.5),
    instanceCount: z.number().int().min(1).max(15).default(1),
    backupRetentionDays: z.number().int().min(1).max(35).default(7),
    deletionProtection: z.boolean().default(false),
    iamAuthentication: z.boolean().default(true),
    autoMinorVersionUpgrade: z.boolean().default(true),
    storageEncrypted: z.literal(true).default(true),
  }),

  redis: z.object({
    nodeType: z.string().default('cache.t4g.micro'),
    replicas: z.number().int().min(0).default(0),
    multiAz: z.boolean().default(false),
    automaticFailoverEnabled: z.boolean().default(false),
    snapshotRetentionLimit: z.number().int().min(0).max(35).default(1),
  }),

  s3: z.object({
    versioned: z.boolean().default(true),
    lifecycleDays: z.number().int().positive().optional(),
  }),

  waf: z.object({
    rateLimit5min: z.number().int().min(100).default(2000),
    blockGeoMatch: z.array(z.string()).default([]),
  }),

  alb: z.object({
    idleTimeoutSeconds: z.number().int().min(1).max(4000).default(60),
    accessLogsRetentionDays: z.number().int().min(1).default(30),
    deletionProtection: z.boolean().default(false),
  }),

  services: z.record(z.string(), serviceConfig),
});

export type Config = z.infer<typeof configSchema>;

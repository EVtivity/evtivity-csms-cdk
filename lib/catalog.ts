// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Fixed facts about each EVtivity container: which image it runs, which ports
// it listens on, how its health is checked, and what it depends on. These
// follow the application code, not the environment, so they live here and not
// in the YAML config. The YAML decides whether a service runs and how it is
// sized.

export type ServiceName =
  'api' | 'ocpp' | 'ocpi' | 'csms' | 'portal' | 'worker' | 'css' | 'ocpiSim' | 'ocpiCpoSim';

export type ServiceKind = 'node' | 'nginx';

export interface ServiceSpec {
  /** Image name under the registry, e.g. `api` -> `<registry>/api:<tag>`. */
  component: string;
  kind: ServiceKind;
  /** Port the container serves on. Omitted for services with no listener. */
  port?: number;
  /** Health endpoint probed by the load balancer and the container health check. */
  health?: { port: number; path: string };
  /** Reachable through the public ALB on `<hostname>.<zone>`. */
  public: boolean;
  /** Default hostname label for public services. */
  hostname?: string;
  /** Default ALB listener rule priority. */
  priority?: number;
  /** Other services that must be enabled for this one to work. */
  requires: ServiceName[];
  /** Needs the application database and Valkey credentials. */
  usesData: boolean;
  /** Needs the SETTINGS_ENCRYPTION_KEY secret. */
  usesSettingsKey: boolean;
  /** Needs read and write access to the application bucket. */
  usesBucket: boolean;
}

export const SERVICE_CATALOG: Record<ServiceName, ServiceSpec> = {
  api: {
    component: 'api',
    kind: 'node',
    port: 3001,
    health: { port: 3001, path: '/v1/health' },
    public: true,
    hostname: 'api',
    priority: 10,
    requires: [],
    usesData: true,
    usesSettingsKey: true,
    usesBucket: true,
  },
  ocpp: {
    component: 'ocpp',
    kind: 'node',
    port: 8080,
    health: { port: 8081, path: '/' },
    public: true,
    hostname: 'ocpp',
    priority: 20,
    requires: [],
    usesData: true,
    usesSettingsKey: true,
    usesBucket: false,
  },
  ocpi: {
    component: 'ocpi',
    kind: 'node',
    port: 3002,
    health: { port: 3002, path: '/health' },
    public: true,
    hostname: 'ocpi',
    priority: 30,
    requires: [],
    usesData: true,
    usesSettingsKey: true,
    usesBucket: false,
  },
  csms: {
    component: 'csms',
    kind: 'nginx',
    port: 8080,
    health: { port: 8080, path: '/health' },
    public: true,
    hostname: 'csms',
    priority: 40,
    requires: ['api'],
    usesData: false,
    usesSettingsKey: false,
    usesBucket: false,
  },
  portal: {
    component: 'portal',
    kind: 'nginx',
    port: 8080,
    health: { port: 8080, path: '/health' },
    public: true,
    hostname: 'portal',
    priority: 50,
    requires: ['api'],
    usesData: false,
    usesSettingsKey: false,
    usesBucket: false,
  },
  worker: {
    component: 'worker',
    kind: 'node',
    public: false,
    requires: [],
    usesData: true,
    usesSettingsKey: true,
    usesBucket: true,
  },
  css: {
    component: 'css',
    kind: 'node',
    health: { port: 8082, path: '/' },
    public: false,
    requires: ['ocpp'],
    usesData: true,
    usesSettingsKey: false,
    usesBucket: false,
  },
  ocpiSim: {
    component: 'ocpi-simulator',
    kind: 'node',
    port: 3003,
    public: false,
    requires: ['ocpi'],
    usesData: false,
    usesSettingsKey: false,
    usesBucket: false,
  },
  ocpiCpoSim: {
    component: 'ocpi-simulator',
    kind: 'node',
    port: 3004,
    public: false,
    requires: ['ocpi'],
    usesData: false,
    usesSettingsKey: false,
    usesBucket: false,
  },
};

export const SERVICE_NAMES = Object.keys(SERVICE_CATALOG) as ServiceName[];

/** Cloud Map name of a service inside the private namespace. */
export function discoveryName(name: ServiceName): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Ports a service accepts from other tasks in the cluster. */
export function internalPorts(name: ServiceName, ocppTlsPort: number | null): number[] {
  const spec = SERVICE_CATALOG[name];
  const ports = new Set<number>();
  if (spec.port != null) ports.add(spec.port);
  if (name === 'ocpp' && ocppTlsPort != null) ports.add(ocppTlsPort);
  return [...ports];
}

/** Ports the ALB must reach on a public service (traffic and health check). */
export function albPorts(name: ServiceName): number[] {
  const spec = SERVICE_CATALOG[name];
  const ports = new Set<number>();
  if (spec.port != null) ports.add(spec.port);
  if (spec.health != null) ports.add(spec.health.port);
  return [...ports];
}

/** Prometheus metrics endpoint of the API (`METRICS_PORT`). */
export const API_METRICS_PORT = 9091;
/** Grafana HTTP port. */
export const GRAFANA_PORT = 3000;
/** Loki HTTP port (push and query). */
export const LOKI_PORT = 3100;

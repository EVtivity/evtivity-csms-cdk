// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CloudWatch Logs subscription target that pushes log events to Loki.
// CloudWatch stays the system of record (ECS writes there through the
// awslogs driver). Loki gets a copy so the Grafana logs dashboard works the
// same way it does with the Helm chart, where Alloy ships container logs.
//
// Streams carry the labels the dashboard queries: `service` (api, ocpp,
// simulator, postgres, redis, ...) plus `environment` and `log_group`.

import { gunzipSync } from 'node:zlib';

interface SubscriptionEvent {
  awslogs: { data: string };
}

interface LogsPayload {
  messageType: 'DATA_MESSAGE' | 'CONTROL_MESSAGE';
  logGroup: string;
  logStream: string;
  logEvents: { id: string; timestamp: number; message: string }[];
}

function env(name: string): string {
  const value = process.env[name];
  if (value == null || value === '') throw new Error(`${name} is not set`);
  return value;
}

const lokiUrl = env('LOKI_URL');
const environment = env('ENVIRONMENT');
const services = JSON.parse(env('SERVICE_BY_LOG_GROUP')) as Record<string, string>;

export async function handler(event: SubscriptionEvent): Promise<void> {
  const payload = JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
  ) as LogsPayload;
  // CloudWatch sends a control message when the subscription is created.
  if (payload.messageType !== 'DATA_MESSAGE' || payload.logEvents.length === 0) return;

  const service = services[payload.logGroup] ?? payload.logGroup.split('/').pop() ?? 'unknown';
  const body = {
    streams: [
      {
        stream: { service, environment, log_group: payload.logGroup },
        // Loki wants [nanosecond timestamp as a string, line].
        values: payload.logEvents.map((e) => [`${String(e.timestamp)}000000`, e.message]),
      },
    ],
  };

  const res = await fetch(`${lokiUrl}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 400 (sample too old, line too long) and 413 (batch too large) fail the
    // same way on every retry. Log and drop the batch. Anything else, such as
    // 401, 403, or 404 from a misconfiguration, throws so the retries, the
    // failure queue, and the error alarm see it.
    if (res.status === 400 || res.status === 413) {
      console.error(
        `Loki rejected ${String(payload.logEvents.length)} events from ${payload.logGroup}: ` +
          `${String(res.status)} ${await res.text()}`,
      );
      return;
    }
    // Throwing makes Lambda retry the asynchronous invocation. The events
    // remain in CloudWatch Logs regardless.
    throw new Error(
      `Loki push failed for ${payload.logGroup}: ${String(res.status)} ${await res.text()}`,
    );
  }
}

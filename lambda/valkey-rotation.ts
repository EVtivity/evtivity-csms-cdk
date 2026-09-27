// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Secrets Manager rotation function for an ElastiCache Valkey RBAC user.
//
// An RBAC user may hold two passwords. setSecret gives the user both the
// current and the pending password, so tasks that started before this
// rotation keep authenticating until the next rotation replaces the older
// one. ECS redeploys services on a shorter schedule than the rotation
// interval, so every task picks up the new password in time.

import { connect } from 'node:tls';
import {
  DescribeUsersCommand,
  ElastiCacheClient,
  ModifyUserCommand,
} from '@aws-sdk/client-elasticache';
import {
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';

interface RotationEvent {
  SecretId: string;
  ClientRequestToken: string;
  Step: 'createSecret' | 'setSecret' | 'testSecret' | 'finishSecret';
}

interface CacheSecret {
  username: string;
  password: string;
  user_arn: string;
}

// Same exclusions as the CDK-generated initial password: survives URLs and
// shells, and avoids the characters ElastiCache rejects (, " / @).
const EXCLUDE = ' %+~`#$&*()|[]{}:;<>?!\'/@"\\,=^';

const sm = new SecretsManagerClient({});
const ec = new ElastiCacheClient({});

function env(name: string): string {
  const value = process.env[name];
  if (value == null || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function getSecret(
  secretId: string,
  stage: string,
  versionId?: string,
): Promise<CacheSecret> {
  const res = await sm.send(
    new GetSecretValueCommand({
      SecretId: secretId,
      VersionStage: stage,
      ...(versionId != null && { VersionId: versionId }),
    }),
  );
  if (res.SecretString == null) throw new Error(`secret ${secretId} ${stage} has no SecretString`);
  const parsed = JSON.parse(res.SecretString) as Partial<CacheSecret>;
  if (parsed.username == null || parsed.password == null || parsed.user_arn == null) {
    throw new Error(`secret ${secretId} ${stage} is missing username, password, or user_arn`);
  }
  return parsed as CacheSecret;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForUserActive(userId: string): Promise<void> {
  // ModifyUser is asynchronous. The user returns to `active` once every cache
  // node in its user groups has applied the change.
  for (let i = 0; i < 60; i++) {
    const res = await ec.send(new DescribeUsersCommand({ UserId: userId }));
    const status = res.Users?.[0]?.Status;
    if (status === 'active') return;
    await sleep(10_000);
  }
  throw new Error(`user ${userId} did not return to active within 10 minutes`);
}

function bulk(value: string): string {
  return `$${String(Buffer.byteLength(value))}\r\n${value}\r\n`;
}

/** Sends AUTH over TLS and resolves with the server's first reply line. */
function tryAuth(host: string, port: number, username: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, timeout: 10_000 });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => {
      socket.write(`*3\r\n${bulk('AUTH')}${bulk(username)}${bulk(password)}`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\r\n');
      if (end >= 0) {
        socket.end();
        resolve(buffer.slice(0, end));
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${String(port)}`));
    });
    socket.on('error', reject);
  });
}

async function createSecret(secretId: string, token: string): Promise<void> {
  const current = await getSecret(secretId, 'AWSCURRENT');
  try {
    await getSecret(secretId, 'AWSPENDING', token);
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  const pw = await sm.send(
    new GetRandomPasswordCommand({
      PasswordLength: 64,
      ExcludeCharacters: EXCLUDE,
      RequireEachIncludedType: true,
    }),
  );
  if (pw.RandomPassword == null) throw new Error('GetRandomPassword returned no password');
  await sm.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      ClientRequestToken: token,
      SecretString: JSON.stringify({ ...current, password: pw.RandomPassword }),
      VersionStages: ['AWSPENDING'],
    }),
  );
}

async function setSecret(secretId: string, token: string): Promise<void> {
  const userId = env('CACHE_USER_ID');
  const current = await getSecret(secretId, 'AWSCURRENT');
  const pending = await getSecret(secretId, 'AWSPENDING', token);
  const passwords = [...new Set([current.password, pending.password])];
  await waitForUserActive(userId);
  await ec.send(new ModifyUserCommand({ UserId: userId, Passwords: passwords }));
  await waitForUserActive(userId);
}

async function testSecret(secretId: string, token: string): Promise<void> {
  const pending = await getSecret(secretId, 'AWSPENDING', token);
  const host = env('CACHE_HOST');
  const port = Number(env('CACHE_PORT'));
  let reply = '';
  // The user can report active a few seconds before every node accepts the
  // new password. Retry briefly before failing the rotation.
  for (let i = 0; i < 6; i++) {
    reply = await tryAuth(host, port, pending.username, pending.password);
    if (reply === '+OK') return;
    await sleep(10_000);
  }
  throw new Error(`AUTH with the pending password failed: ${reply}`);
}

async function finishSecret(secretId: string, token: string): Promise<void> {
  const meta = await sm.send(new DescribeSecretCommand({ SecretId: secretId }));
  let currentVersion: string | undefined;
  for (const [version, stages] of Object.entries(meta.VersionIdsToStages ?? {})) {
    if (stages.includes('AWSCURRENT')) {
      if (version === token) return;
      currentVersion = version;
    }
  }
  await sm.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secretId,
      VersionStage: 'AWSCURRENT',
      MoveToVersionId: token,
      ...(currentVersion != null && { RemoveFromVersionId: currentVersion }),
    }),
  );
}

export async function handler(event: RotationEvent): Promise<void> {
  const { SecretId: secretId, ClientRequestToken: token, Step: step } = event;
  const meta = await sm.send(new DescribeSecretCommand({ SecretId: secretId }));
  if (meta.RotationEnabled !== true) throw new Error(`rotation is not enabled for ${secretId}`);
  const stages = meta.VersionIdsToStages?.[token];
  if (stages == null) throw new Error(`version ${token} has no stage for ${secretId}`);
  if (stages.includes('AWSCURRENT')) return;
  if (!stages.includes('AWSPENDING'))
    throw new Error(`version ${token} is not AWSPENDING for ${secretId}`);

  switch (step) {
    case 'createSecret':
      await createSecret(secretId, token);
      return;
    case 'setSecret':
      await setSecret(secretId, token);
      return;
    case 'testSecret':
      await testSecret(secretId, token);
      return;
    case 'finishSecret':
      await finishSecret(secretId, token);
      return;
  }
}

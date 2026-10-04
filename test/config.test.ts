// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Invalid configs must fail to load instead of deploying something unintended.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { loadConfig } from '../lib/config/load.js';

const BASE = load(readFileSync('config/dev.yaml', 'utf-8')) as Record<string, unknown>;

/** Writes dev.yaml plus the given dev.local.yaml into a temp dir and loads it. */
function loadWith(local: string, base: Record<string, unknown> = BASE): () => unknown {
  const dir = mkdtempSync(join(tmpdir(), 'evt-config-'));
  writeFileSync(join(dir, 'dev.yaml'), JSON.stringify(base));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  return () => loadConfig('dev', dir);
}

void describe('config validation', () => {
  void it('loads the committed dev config with an empty local file', () => {
    assert.doesNotThrow(loadWith(''));
    assert.doesNotThrow(loadWith('# nothing here\n'));
    assert.doesNotThrow(loadWith('# windows line endings\r\n# still nothing\r\n'));
    assert.doesNotThrow(loadWith('---\n'));
  });

  void it('rejects misspelled keys at any depth', () => {
    assert.throws(loadWith('waf:\n  enable: true\n'), /enable/);
    assert.throws(loadWith('aurora:\n  deletionProtecton: true\n'), /deletionProtecton/);
    assert.throws(loadWith('services:\n  api:\n    desiredcount: 3\n'), /desiredcount/);
  });

  void it('defaults the WAF country allowlist to US and validates codes', () => {
    const waf = (local: string): { allowCountries: string[] } =>
      (loadWith(local)() as { waf: { allowCountries: string[] } }).waf;
    assert.deepEqual(waf('').allowCountries, ['US']);
    assert.deepEqual(waf('waf:\n  allowCountries: [US, CA]\n').allowCountries, ['US', 'CA']);
    assert.deepEqual(waf('waf:\n  allowCountries: []\n').allowCountries, []);
    assert.throws(loadWith('waf:\n  allowCountries: [us]\n'), /ISO 3166/);
    assert.throws(loadWith('waf:\n  allowCountries: [USA]\n'), /ISO 3166/);
    assert.throws(loadWith('waf:\n  blockCountries: [CN]\n'), /blockCountries/);
  });

  void it('seeds the Stripe webhook set with /32 CIDRs and validates WAF rate limits', () => {
    const waf = (loadWith('')() as { waf: { stripeWebhookIps: string[] } }).waf;
    assert.ok(waf.stripeWebhookIps.length > 0);
    assert.ok(waf.stripeWebhookIps.every((c) => /^(\d{1,3}\.){3}\d{1,3}\/32$/.test(c)));
    assert.throws(loadWith('waf:\n  stripeWebhookIps: [3.18.12.63]\n'), /stripeWebhookIps/);
    // AWS WAF rejects rate limits below 10.
    assert.throws(loadWith('waf:\n  authRateLimitPer5Min: 5\n'), /authRateLimitPer5Min/);
    assert.throws(loadWith('waf:\n  guestRateLimitPer5Min: 5\n'), /guestRateLimitPer5Min/);
    assert.equal(
      (loadWith('')() as { waf: { adyenWebhookRateLimitPer5Min: number } }).waf
        .adyenWebhookRateLimitPer5Min,
      1000,
    );
    assert.throws(
      loadWith('waf:\n  adyenWebhookRateLimitPer5Min: 50\n'),
      /adyenWebhookRateLimitPer5Min/,
    );
  });

  void it('rejects the removed currency settings and unsupported company currencies', () => {
    assert.throws(loadWith('appSettings:\n  stripe.currency: EUR\n'), /one currency/);
    assert.throws(loadWith('appSettings:\n  pricing.currency: EUR\n'), /one currency/);
    assert.throws(loadWith('appSettings:\n  company.currency: JPY\n'), /unsupported currency/);
    assert.doesNotThrow(loadWith('appSettings:\n  company.currency: EUR\n'));
  });

  void it('rejects the moved stripe payment settings', () => {
    assert.throws(
      loadWith('appSettings:\n  stripe.preAuthAmountCents: 5000\n'),
      /moved to payments.preAuthAmountCents/,
    );
    assert.throws(
      loadWith('appSettings:\n  stripe.platformFeePercent: 0\n'),
      /moved to payments.platformFeePercent/,
    );
  });

  void it('validates the payment amount and test provider settings', () => {
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  payments.preAuthAmountCents: 7500\n  payments.platformFeePercent: 2.5\n' +
          '  simulated.resultMode: sync\n  simulated.asyncDelaySeconds: 0\n' +
          '  simulated.randomFailureRate: 0.1\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  payments.preAuthAmountCents: 1000000\n'));
    assert.throws(loadWith('appSettings:\n  payments.preAuthAmountCents: 0\n'), /1 to 1000000/);
    assert.throws(loadWith('appSettings:\n  payments.preAuthAmountCents: 12.5\n'), /whole number/);
    assert.throws(
      loadWith('appSettings:\n  payments.preAuthAmountCents: "5000"\n'),
      /whole number/,
    );
    assert.throws(loadWith('appSettings:\n  payments.platformFeePercent: 101\n'), /0 to 100/);
    assert.doesNotThrow(loadWith('appSettings:\n  simulated.resultMode: async\n'));
    assert.throws(loadWith('appSettings:\n  simulated.resultMode: later\n'), /use sync or async/);
    assert.throws(loadWith('appSettings:\n  simulated.asyncDelaySeconds: 3601\n'), /0 to 3600/);
    assert.throws(loadWith('appSettings:\n  simulated.randomFailureRate: 1.5\n'), /0 to 1/);
  });

  void it('rejects credentials in appSettings', () => {
    assert.throws(loadWith('appSettings:\n  smtp.passwordEnc: secret\n'), /dashboard/);
  });

  void it('rejects availability zones outside the region', () => {
    assert.throws(
      loadWith('vpc:\n  availabilityZones: [eu-west-1a, eu-west-1b]\n'),
      /not in region/,
    );
  });

  void it('rejects demo data in prod', () => {
    assert.throws(
      loadWith('seedDemo:\n  enabled: true\n', { ...BASE, env: 'prod' }),
      /demo data is not allowed in prod/,
    );
  });

  void it('gates the simulated payment provider', () => {
    const payments = (local: string, base = BASE): { allowSimulatedProvider: boolean } =>
      (loadWith(local, base)() as { payments: { allowSimulatedProvider: boolean } }).payments;
    assert.equal(payments('').allowSimulatedProvider, false);
    assert.equal(
      payments('payments:\n  allowSimulatedProvider: true\n').allowSimulatedProvider,
      true,
    );
    assert.throws(
      loadWith('payments:\n  allowSimulatedProvider: true\n', { ...BASE, env: 'prod' }),
      /not allowed in prod/,
    );
    assert.throws(loadWith('seedDemo:\n  enabled: true\n'), /simulated cards/);
    assert.doesNotThrow(
      loadWith('seedDemo:\n  enabled: true\npayments:\n  allowSimulatedProvider: true\n'),
    );
  });

  void it('validates the payment provider setting', () => {
    assert.doesNotThrow(loadWith('appSettings:\n  payments.provider: stripe\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  payments.provider: none\n'));
    assert.throws(
      loadWith('appSettings:\n  payments.provider: adyen\n'),
      /select Adyen in Settings > Payment after the upgrade/,
    );
    assert.throws(loadWith('appSettings:\n  payments.provider: braintree\n'), /payment provider/);
    assert.throws(loadWith('appSettings:\n  payments.provider: simulated\n'), /payment provider/);
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  payments.provider: simulated\npayments:\n  allowSimulatedProvider: true\n',
      ),
    );
  });

  void it('validates the non-secret Adyen settings like the Helm chart', () => {
    assert.doesNotThrow(loadWith('appSettings:\n  adyen.environment: test\n'));
    assert.throws(loadWith('appSettings:\n  adyen.environment: staging\n'), /test or live/);
    assert.throws(loadWith('appSettings:\n  adyen.environment: live\n'), /required when/);
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  adyen.environment: live\n  adyen.liveUrlPrefix: 1797a841fbb37ca7-AdyenDemo\n',
      ),
    );
    assert.throws(
      loadWith('appSettings:\n  adyen.environment: live\n  adyen.liveUrlPrefix: not a prefix\n'),
      /live URL prefix/,
    );
    assert.doesNotThrow(loadWith('appSettings:\n  adyen.liveRegion: eu\n'));
    assert.throws(loadWith('appSettings:\n  adyen.liveRegion: apse\n'), /eu, us, au, nea, or in/);
    assert.doesNotThrow(loadWith('appSettings:\n  adyen.authorisationAdjustment: true\n'));
    assert.throws(
      loadWith('appSettings:\n  adyen.authorisationAdjustment: maybe\n'),
      /true or false/,
    );
  });

  void it('rejects redeploys less often than credentials rotate', () => {
    assert.throws(
      loadWith('ecs:\n  redeployEveryDays: 30\nrotation:\n  databaseDays: 7\n'),
      /redeployEveryDays/,
    );
  });

  void it('rejects a desiredCount that autoscaling would ignore', () => {
    assert.throws(
      loadWith(
        'services:\n  api:\n    desiredCount: 3\n    autoscaling:\n      min: 1\n      max: 4\n',
      ),
      /autoscaling.min/,
    );
  });

  void it('rejects OCPP TLS without its secret', () => {
    assert.throws(loadWith('ocppTls:\n  enabled: true\n'), /secretName/);
  });
});

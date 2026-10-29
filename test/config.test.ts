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
import {
  DERIVED_SERVICE_ENV_VARS,
  webauthnPortalRpNote,
  type Config,
} from '../lib/config/schema.js';

const BASE = load(readFileSync('config/dev.yaml', 'utf-8')) as Record<string, unknown>;

/** Writes dev.yaml plus the given dev.local.yaml into a temp dir and loads it. */
function loadWith(local: string, base: Record<string, unknown> = BASE): () => unknown {
  const dir = mkdtempSync(join(tmpdir(), 'evt-config-'));
  writeFileSync(join(dir, 'dev.yaml'), JSON.stringify(base));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  return () => loadConfig('dev', dir);
}

void describe('config validation', () => {
  void it('checks the passkey settings and the WebAuthn relying party ID', () => {
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.mfa.webauthnEnabled: true\n' +
          '  security.mfa.passkeyLoginEnabled: true\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  security.mfa.webauthnEnabled: false\n'));
    assert.throws(
      loadWith('appSettings:\n  security.mfa.webauthnEnabled: "yes"\n'),
      /use true or false/,
    );
    assert.throws(
      loadWith(
        'appSettings:\n  security.mfa.webauthnEnabled: false\n' +
          '  security.mfa.passkeyLoginEnabled: true\n',
      ),
      /passkey sign-in uses passkeys/,
    );
    for (const rpId of ['dev.evtivity.com', 'evtivity.com', 'csms.dev.evtivity.com']) {
      assert.doesNotThrow(loadWith(`services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: ${rpId}\n`));
    }
    // Case does not matter, as for the API and the Helm chart: it is deployed lowercased.
    const upper = loadWith(
      'services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: " Dev.EVtivity.com "\n',
    )() as Config;
    assert.equal(upper.services.api.env['WEBAUTHN_RP_ID'], 'dev.evtivity.com');
    assert.equal(webauthnPortalRpNote(upper), null);
    const blank = loadWith('services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: "  "\n')() as Config;
    assert.equal('WEBAUTHN_RP_ID' in blank.services.api.env, false);
    assert.throws(
      loadWith('services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: Other.COM\n'),
      /use the CSMS host csms.dev.evtivity.com or a parent domain/,
    );
    for (const [rpId, message] of [
      ['other.com', /use the CSMS host csms.dev.evtivity.com or a parent domain/],
      ['vtivity.com', /use the CSMS host/],
      ['https://evtivity.com', /domain name without a scheme/],
      ['evtivity.com:443', /domain name without a scheme/],
      ['com', /at least two labels/],
      ['10.0.0.5', /not an IP address/],
    ] as const) {
      assert.throws(
        loadWith(`services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: "${rpId}"\n`),
        message,
      );
    }
  });

  void it('checks required MFA for drivers', () => {
    assert.doesNotThrow(loadWith('appSettings:\n  security.mfa.requireDrivers: true\n'));
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.mfa.requireDrivers: true\n  security.mfa.emailEnabled: false\n',
      ),
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.requireDrivers: "true"\n'),
      /use true or false/,
    );
    assert.throws(
      loadWith(
        'appSettings:\n  security.mfa.requireDrivers: true\n' +
          '  security.mfa.emailEnabled: false\n  security.mfa.totpEnabled: false\n',
      ),
      /no driver without a phone can set up MFA/,
    );
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.mfa.requireDrivers: false\n' +
          '  security.mfa.emailEnabled: false\n  security.mfa.totpEnabled: false\n',
      ),
    );
  });

  void it('notes when the WebAuthn relying party ID does not serve the portal', () => {
    const shared = loadWith(
      'services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: dev.evtivity.com\n',
    )();
    assert.equal(webauthnPortalRpNote(shared as Config), null);
    const csmsOnly = loadWith(
      'services:\n  api:\n    env:\n      WEBAUTHN_RP_ID: csms.dev.evtivity.com\n',
    )();
    assert.match(
      webauthnPortalRpNote(csmsOnly as Config) ?? '',
      /portal uses portal\.dev\.evtivity\.com as its passkey relying party/,
    );
    assert.equal(webauthnPortalRpNote(loadWith('')() as Config), null);
  });

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
    assert.doesNotThrow(loadWith('appSettings:\n  prepaid.lowCreditThresholdCents: 0\n'));
    assert.throws(
      loadWith('appSettings:\n  prepaid.lowCreditThresholdCents: -1\n'),
      /0 to 100000000/,
    );
    assert.throws(
      loadWith('appSettings:\n  prepaid.lowCreditThresholdCents: 2.5\n'),
      /whole number/,
    );
    assert.doesNotThrow(loadWith('appSettings:\n  invoice.paymentTermsDays: 0\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  invoice.paymentTermsDays: 365\n'));
    assert.throws(loadWith('appSettings:\n  invoice.paymentTermsDays: 366\n'), /0 to 365/);
    assert.throws(loadWith('appSettings:\n  invoice.paymentTermsDays: 7.5\n'), /whole number/);
    assert.doesNotThrow(loadWith('appSettings:\n  fleet.invoiceRunDay: 1\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  fleet.invoiceRunDay: 28\n'));
    assert.throws(loadWith('appSettings:\n  fleet.invoiceRunDay: 0\n'), /1 to 28/);
    assert.throws(loadWith('appSettings:\n  fleet.invoiceRunDay: 29\n'), /1 to 28/);
    assert.throws(loadWith('appSettings:\n  fleet.invoiceRunDay: 2.5\n'), /whole number/);
    assert.throws(loadWith('appSettings:\n  invoice.paymentTermsDays: "30"\n'), /whole number/);
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  company.iban: DE89370400440532013000\n  company.bic: COBADEFFXXX\n' +
          '  company.bankAccountHolder: Acme GmbH\n  company.bankName: Commerzbank\n' +
          '  invoice.epcQrEnabled: false\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  company.iban: ""\n  company.bic: ""\n'));
    assert.throws(loadWith('appSettings:\n  company.iban: DE89370400440532013001\n'), /valid IBAN/);
    assert.throws(loadWith('appSettings:\n  company.iban: DE89 3704 0044 0532 0130 00\n'), /IBAN/);
    assert.throws(loadWith('appSettings:\n  company.bic: COBADEF\n'), /BIC/);
    assert.throws(loadWith('appSettings:\n  company.bic: cobadeff\n'), /BIC/);
    assert.throws(
      loadWith(`appSettings:\n  company.bankAccountHolder: ${'x'.repeat(71)}\n`),
      /at most 70/,
    );
    assert.throws(loadWith('appSettings:\n  invoice.epcQrEnabled: "yes"\n'), /true or false/);
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.password.minLength: 8\n' +
          '  security.password.requireUppercase: false\n  security.password.requireLowercase: true\n' +
          '  security.password.requireNumber: true\n  security.password.requireSymbol: true\n' +
          '  security.session.operatorAccessMinutes: 5\n  security.session.operatorRefreshDays: 90\n' +
          '  security.session.driverAccessMinutes: 1440\n  security.session.driverRefreshDays: 365\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  security.password.minLength: 64\n'));
    assert.throws(loadWith('appSettings:\n  security.password.minLength: 7\n'), /8 to 64/);
    assert.throws(loadWith('appSettings:\n  security.password.minLength: 65\n'), /8 to 64/);
    assert.throws(loadWith('appSettings:\n  security.password.minLength: 12.5\n'), /whole number/);
    assert.throws(loadWith('appSettings:\n  security.password.minLength: "12"\n'), /whole number/);
    assert.throws(
      loadWith('appSettings:\n  security.password.requireSymbol: "true"\n'),
      /true or false/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.password.requireNumber: 1\n'),
      /true or false/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.session.operatorAccessMinutes: 4\n'),
      /5 to 1440/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.session.operatorRefreshDays: 91\n'),
      /1 to 90/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.session.driverAccessMinutes: 1441\n'),
      /5 to 1440/,
    );
    assert.throws(loadWith('appSettings:\n  security.session.driverRefreshDays: 0\n'), /1 to 365/);
    assert.doesNotThrow(loadWith('appSettings:\n  security.mfa.required: "off"\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  security.mfa.required: all\n'));
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.mfa.required: roles\n' +
          '  security.mfa.requiredRoles: [Admin, Site Manager]\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  security.mfa.requiredRoles: []\n'));
    assert.throws(
      loadWith(
        'appSettings:\n  security.mfa.required: all\n' +
          '  security.mfa.emailEnabled: false\n  security.mfa.totpEnabled: false\n',
      ),
      /needs security.mfa.emailEnabled or security.mfa.totpEnabled/,
    );
    assert.throws(
      loadWith(
        'appSettings:\n  security.mfa.required: roles\n  security.mfa.requiredRoles: [Admin]\n' +
          '  security.mfa.emailEnabled: false\n  security.mfa.totpEnabled: false\n',
      ),
      /needs security.mfa.emailEnabled or security.mfa.totpEnabled/,
    );
    assert.doesNotThrow(
      loadWith('appSettings:\n  security.mfa.required: all\n  security.mfa.emailEnabled: false\n'),
    );
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  security.mfa.required: "off"\n' +
          '  security.mfa.emailEnabled: false\n  security.mfa.totpEnabled: false\n',
      ),
    );
    assert.throws(loadWith('appSettings:\n  security.mfa.required: some\n'), /off, all, roles/);
    assert.throws(loadWith('appSettings:\n  security.mfa.required: true\n'), /off, all, roles/);
    assert.throws(
      loadWith('appSettings:\n  security.mfa.required: roles\n'),
      /needs at least one role/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.required: roles\n  security.mfa.requiredRoles: []\n'),
      /needs at least one role/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.requiredRoles: Admin\n'),
      /list of role names/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.requiredRoles: [Admin, " "]\n'),
      /not a role name/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.requiredRoles: [Admin, 7]\n'),
      /requiredRoles/,
    );
    // The dashboard caps: at most 50 roles, each at most 100 characters.
    const roles = (n: number) => Array.from({ length: n }, (_, k) => `Role${String(k + 1)}`);
    assert.doesNotThrow(
      loadWith(`appSettings:\n  security.mfa.requiredRoles: [${roles(50).join(', ')}]\n`),
    );
    assert.throws(
      loadWith(`appSettings:\n  security.mfa.requiredRoles: [${roles(51).join(', ')}]\n`),
      /use at most 50 entries/,
    );
    assert.doesNotThrow(
      loadWith(`appSettings:\n  security.mfa.requiredRoles: [${'r'.repeat(100)}]\n`),
    );
    assert.throws(
      loadWith(`appSettings:\n  security.mfa.requiredRoles: [Admin, ${'r'.repeat(101)}]\n`),
      /longer than 100 characters/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.mfa.requiredRoles: [Admin, Admin]\n'),
      /name each entry once/,
    );
    assert.throws(
      loadWith('appSettings:\n  security.session.driverRefreshDays: true\n'),
      /whole number/,
    );
    assert.doesNotThrow(loadWith('appSettings:\n  fleet.creditReservationCents: 1\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  fleet.creditReservationCents: 100000000\n'));
    assert.throws(loadWith('appSettings:\n  fleet.creditReservationCents: 0\n'), /1 to 100000000/);
    assert.throws(loadWith('appSettings:\n  fleet.creditReservationCents: 50.5\n'), /whole number/);
    assert.throws(
      loadWith('appSettings:\n  fleet.creditReservationCents: "5000"\n'),
      /whole number/,
    );
  });

  void it('rejects credentials in appSettings', () => {
    assert.throws(loadWith('appSettings:\n  smtp.passwordEnc: secret\n'), /dashboard/);
  });

  void it('validates the mobile app lists like the CSMS lib', () => {
    const settings = (local: string): Record<string, unknown> =>
      (loadWith(local)() as { appSettings: Record<string, unknown> }).appSettings;
    assert.deepEqual(
      settings(
        'appSettings:\n  mobile.app.urlSchemes: [evtivity, acme.charge]\n' +
          '  mobile.app.androidPackageNames: [com.evtivity.driver, com.acme.app_2]\n',
      ),
      {
        'mobile.app.urlSchemes': ['evtivity', 'acme.charge'],
        'mobile.app.androidPackageNames': ['com.evtivity.driver', 'com.acme.app_2'],
      },
    );
    assert.doesNotThrow(loadWith('appSettings:\n  mobile.app.urlSchemes: []\n'));
    assert.throws(loadWith('appSettings:\n  mobile.app.urlSchemes: evtivity\n'), /list/);
    assert.throws(loadWith('appSettings:\n  mobile.app.urlSchemes: [1]\n'), /urlSchemes/);
    for (const scheme of ['https', 'http', 'adyencheckout', 'javascript', 'Evtivity', '1app']) {
      assert.throws(
        loadWith(`appSettings:\n  mobile.app.urlSchemes: [evtivity, ${scheme}]\n`),
        /not an app URL scheme/,
        scheme,
      );
    }
    assert.throws(
      loadWith('appSettings:\n  mobile.app.androidPackageNames: com.evtivity.driver\n'),
      /list/,
    );
    for (const id of ['evtivity', 'com.1acme', 'com..acme', '_com.acme', 'com.acme-app']) {
      assert.throws(
        loadWith(`appSettings:\n  mobile.app.androidPackageNames: ["${id}"]\n`),
        /not an Android application id/,
        id,
      );
    }
    assert.throws(
      loadWith('appSettings:\n  company.currency: [EUR]\n'),
      /lists are allowed only for/,
    );
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

  void it('refuses a weakened prod config unless an override names the reason', () => {
    const prod = load(readFileSync('config/prod.yaml', 'utf-8')) as Record<string, unknown>;
    assert.doesNotThrow(loadWith('', prod));
    const cases: Array<[string, string, RegExp]> = [
      ['waf:\n  enabled: false\n', 'waf', /waf\.enabled: must be true in prod/],
      [
        'aurora:\n  deletionProtection: false\n',
        'auroraDeletionProtection',
        /aurora\.deletionProtection: must be true in prod/,
      ],
      [
        'alb:\n  deletionProtection: false\n',
        'albDeletionProtection',
        /alb\.deletionProtection: must be true in prod/,
      ],
      [
        'ecs:\n  executeCommand: true\n',
        'ecsExecuteCommand',
        /ecs\.executeCommand: must be false in prod/,
      ],
    ];
    for (const [weak, name, refusal] of cases) {
      assert.throws(loadWith(weak, prod), refusal);
      assert.doesNotThrow(
        loadWith(
          `${weak}overrides:\n  ${name}:\n    reason: incident 42, until the fix ships\n`,
          prod,
        ),
      );
      assert.throws(
        loadWith(`${weak}overrides:\n  ${name}:\n    reason: x\n`, prod),
        /at least 10 characters/,
      );
    }
    // dev and qa keep their choice without a reason.
    assert.doesNotThrow(loadWith('waf:\n  enabled: false\necs:\n  executeCommand: true\n'));
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

  void it('runs the conformance OCSP responder only with one worker task', () => {
    const octt = (local: string): { ocspResponder: boolean } =>
      (loadWith(local)() as { octt: { ocspResponder: boolean } }).octt;
    assert.equal(octt('').ocspResponder, true);
    assert.equal(octt('octt:\n  ocspResponder: false\n').ocspResponder, false);
    assert.throws(loadWith('services:\n  worker:\n    desiredCount: 2\n'), /one worker task/);
    assert.throws(loadWith('services:\n  worker:\n    enabled: false\n'), /one worker task/);
    assert.doesNotThrow(
      loadWith('octt:\n  ocspResponder: false\nservices:\n  worker:\n    desiredCount: 2\n'),
    );
  });

  void it('rejects OCPP TLS without its secret', () => {
    assert.throws(loadWith('ocppTls:\n  enabled: true\n  secretName: ""\n'), /secretName/);
    const noTls = { ...BASE };
    delete noTls['ocppTls'];
    assert.throws(loadWith('ocppTls:\n  enabled: true\n', noTls), /secretName/);
  });

  void it('dev turns on every OCPP station entry point', () => {
    const c = loadWith('')() as Config;
    assert.equal(c.alb.ocppPlainWs, true, 'security profiles 0 and 1 on ws://');
    assert.equal(c.services.ocpp.enabled, true, 'security profile 2 on wss:// through the ALB');
    assert.equal(c.ocppTls.enabled, true, 'security profile 3 on the NLB');
    assert.equal(c.ocppTls.secretName, 'evtivity/dev/ocpp-tls');
  });

  void it('bounds OCPP connection authentications within the database pool', () => {
    type Auth = { maxConcurrent?: number; maxQueued?: number; maxWaitMs?: number };
    const auth = (local: string): Auth =>
      (loadWith(local)() as { ocppConnectionAuth: Auth }).ocppConnectionAuth;
    assert.deepEqual(auth(''), {});
    assert.deepEqual(
      auth('ocppConnectionAuth:\n  maxConcurrent: 4\n  maxQueued: 0\n  maxWaitMs: 5000\n'),
      { maxConcurrent: 4, maxQueued: 0, maxWaitMs: 5000 },
    );
    // dev.yaml has aurora.poolMax 5.
    assert.throws(loadWith('ocppConnectionAuth:\n  maxConcurrent: 6\n'), /aurora.poolMax/);
    assert.throws(loadWith('ocppConnectionAuth:\n  maxConcurrent: 0\n'), /maxConcurrent/);
    assert.throws(loadWith('ocppConnectionAuth:\n  maxWait: 10\n'), /maxWait/);
  });

  void it('refuses the notification test sink in every service and environment', () => {
    for (const service of ['api', 'ocpp', 'worker', 'ocpi']) {
      assert.throws(
        loadWith(
          `services:\n  ${service}:\n    env:\n      NOTIFICATIONS_ALLOW_TEST_SINK: 'true'\n`,
        ),
        /NOTIFICATIONS_ALLOW_TEST_SINK is not allowed/,
      );
      assert.throws(
        loadWith(
          `services:\n  ${service}:\n    env:\n      NOTIFICATIONS_TEST_SINK_URL: http://sink:8080\n`,
        ),
        /NOTIFICATIONS_TEST_SINK_URL is not allowed/,
      );
    }
    assert.throws(
      loadWith('services:\n  api:\n    secrets:\n      NOTIFICATIONS_TEST_SINK_URL: sink-url\n'),
      /NOTIFICATIONS_TEST_SINK_URL is not allowed/,
    );
    // A disabled service is refused too, so enabling it later cannot slip the sink in.
    assert.throws(
      loadWith(
        "services:\n  ocpiSim:\n    enabled: false\n    env:\n      NOTIFICATIONS_ALLOW_TEST_SINK: 'false'\n",
      ),
      /NOTIFICATIONS_ALLOW_TEST_SINK is not allowed/,
    );
  });

  void it('refuses service env overrides of derived security values in every environment (R2-L1)', () => {
    for (const env of ['dev', 'qa', 'prod'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'evt-config-'));
      writeFileSync(join(dir, `${env}.yaml`), readFileSync(`config/${env}.yaml`, 'utf-8'));
      const loadEnv = (local: string) => () => {
        writeFileSync(join(dir, `${env}.local.yaml`), local);
        return loadConfig(env, dir);
      };
      for (const key of DERIVED_SERVICE_ENV_VARS) {
        for (const service of ['api', 'ocpp', 'worker', 'ocpi']) {
          for (const block of ['env', 'secrets']) {
            assert.throws(
              loadEnv(`services:\n  ${service}:\n    ${block}:\n      ${key}: 'true'\n`),
              new RegExp(`${key} is set by the stack`),
              `${env} ${service} ${block} ${key}`,
            );
          }
        }
      }
    }
    // The example from the review: prod with the simulated provider through the env.
    assert.throws(
      loadWith("services:\n  api:\n    env:\n      PAYMENTS_ALLOW_SIMULATED: 'true'\n"),
      /PAYMENTS_ALLOW_SIMULATED is set by the stack/,
    );
  });

  void it('refuses the SIM provider mock in every service and environment', () => {
    for (const env of ['dev', 'qa', 'prod'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'evt-config-'));
      writeFileSync(join(dir, `${env}.yaml`), readFileSync(`config/${env}.yaml`, 'utf-8'));
      const loadEnv = (local: string) => () => {
        writeFileSync(join(dir, `${env}.local.yaml`), local);
        return loadConfig(env, dir);
      };
      assert.doesNotThrow(loadEnv(''));
      for (const service of ['api', 'ocpp', 'worker', 'ocpi']) {
        for (const block of ['env', 'secrets']) {
          assert.throws(
            loadEnv(
              `services:\n  ${service}:\n    ${block}:\n      SIM_PROVIDER_TEST_BASE_URL: http://sim-mock:8080\n`,
            ),
            /SIM_PROVIDER_TEST_BASE_URL is not allowed/,
            `${env} ${service} ${block}`,
          );
        }
      }
      // An empty value is refused too: the name alone is not allowed.
      assert.throws(
        loadEnv("services:\n  api:\n    env:\n      SIM_PROVIDER_TEST_BASE_URL: ''\n"),
        /SIM_PROVIDER_TEST_BASE_URL is not allowed/,
      );
    }
    // A disabled service is refused too, so enabling it later cannot slip the mock in.
    assert.throws(
      loadWith(
        'services:\n  ocpiSim:\n    enabled: false\n    env:\n      SIM_PROVIDER_TEST_BASE_URL: http://sim-mock:8080\n',
      ),
      /SIM_PROVIDER_TEST_BASE_URL is not allowed/,
    );
  });

  void it('refuses the data retention keys: they are set in Settings > Data Retention', () => {
    for (const key of [
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
    ]) {
      assert.throws(
        loadWith(`appSettings:\n  ${key}: 90\n`),
        /data retention is set in the CSMS under Settings > Data Retention/,
        key,
      );
    }
  });

  void it('checks the SIM provider settings', () => {
    assert.doesNotThrow(
      loadWith(
        'appSettings:\n  sim.hologram.enabled: true\n  sim.hologram.orgId: "012345"\n' +
          '  sim.sessions.fetchDays: 1\n' +
          '  sim.stationSignal.enabled: false\n  sim.signal.alertBelowDbm: -110\n' +
          '  sim.ocpp16.signalKeys: [SignalStrength, Vendor.Rssi]\n' +
          '  sim.signal.goodDbm: -40\n  sim.signal.fairDbm: -140\n',
      ),
    );
    assert.doesNotThrow(loadWith('appSettings:\n  sim.sessions.fetchDays: 31\n'));
    assert.doesNotThrow(loadWith('appSettings:\n  sim.ocpp16.signalKeys: []\n'));
    // The API key is a secret entered in the dashboard.
    assert.throws(
      loadWith('appSettings:\n  sim.hologram.apiKeyEnc: secret\n'),
      /must be entered in the dashboard/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.hologram.apiKey: secret\n'),
      /must be entered in the dashboard/,
    );
    for (const key of ['sim.hologram.enabled', 'sim.1nce.enabled', 'sim.stationSignal.enabled']) {
      assert.throws(loadWith(`appSettings:\n  ${key}: "true"\n`), /true or false/, key);
    }
    // 1NCE (v0.1.49): the switch and the client id; the client secret is entered in the dashboard.
    assert.doesNotThrow(
      loadWith('appSettings:\n  sim.1nce.enabled: true\n  sim.1nce.clientId: client-1.A_b\n'),
    );
    for (const clientId of ['"user:pass"', '"two words"', '""', '12345', `"${'x'.repeat(129)}"`]) {
      assert.throws(
        loadWith(`appSettings:\n  sim.1nce.clientId: ${clientId}\n`),
        /1NCE API client id/,
        clientId,
      );
    }
    assert.throws(
      loadWith('appSettings:\n  sim.1nce.clientSecret: secret\n'),
      /must be entered in the dashboard/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.1nce.clientSecretEnc: secret\n'),
      /must be entered in the dashboard/,
    );
    assert.throws(loadWith('appSettings:\n  sim.hologram.orgId: 12345\n'), /1 to 15 digits/);
    assert.throws(loadWith('appSettings:\n  sim.hologram.orgId: org-12\n'), /1 to 15 digits/);
    assert.throws(loadWith('appSettings:\n  sim.hologram.orgId: ""\n'), /1 to 15 digits/);
    assert.throws(
      loadWith('appSettings:\n  sim.hologram.orgId: "1234567890123456"\n'),
      /1 to 15 digits/,
    );
    assert.throws(loadWith('appSettings:\n  sim.sessions.fetchDays: 0\n'), /1 to 31/);
    assert.throws(loadWith('appSettings:\n  sim.sessions.fetchDays: 32\n'), /1 to 31/);
    assert.throws(loadWith('appSettings:\n  sim.sessions.fetchDays: 1.5\n'), /whole number/);
    for (const key of ['sim.signal.alertBelowDbm', 'sim.signal.goodDbm', 'sim.signal.fairDbm']) {
      assert.throws(loadWith(`appSettings:\n  ${key}: -141\n`), /-140 to -40/, key);
      assert.throws(loadWith(`appSettings:\n  ${key}: -39\n`), /-140 to -40/, key);
      assert.throws(loadWith(`appSettings:\n  ${key}: ""\n`), /-140 to -40/, key);
    }
    assert.throws(
      loadWith('appSettings:\n  sim.signal.goodDbm: -85\n  sim.signal.fairDbm: -85\n'),
      /sim.signal.goodDbm must be above sim.signal.fairDbm/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.signal.goodDbm: -90\n  sim.signal.fairDbm: -80\n'),
      /sim.signal.goodDbm must be above sim.signal.fairDbm/,
    );
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `K${String(i + 1)}`);
    assert.doesNotThrow(
      loadWith(`appSettings:\n  sim.ocpp16.signalKeys: [${keys(20).join(', ')}]\n`),
    );
    assert.throws(
      loadWith(`appSettings:\n  sim.ocpp16.signalKeys: [${keys(21).join(', ')}]\n`),
      /at most 20/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.ocpp16.signalKeys: SignalStrength\n'),
      /OCPP 1.6 configuration key names/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.ocpp16.signalKeys: [Rssi, " "]\n'),
      /not a configuration key name/,
    );
    assert.throws(loadWith('appSettings:\n  sim.ocpp16.signalKeys: [Rssi, 7]\n'), /signalKeys/);
    assert.doesNotThrow(loadWith(`appSettings:\n  sim.ocpp16.signalKeys: [${'k'.repeat(50)}]\n`));
    assert.throws(
      loadWith(`appSettings:\n  sim.ocpp16.signalKeys: [${'k'.repeat(51)}]\n`),
      /longer than 50 characters/,
    );
    assert.throws(
      loadWith('appSettings:\n  sim.ocpp16.signalKeys: [Rssi, Rssi]\n'),
      /name each entry once/,
    );
  });
});

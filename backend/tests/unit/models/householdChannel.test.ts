import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  CHANNEL_MAX_BACKOFF_MS,
  formatMaskedUrl,
  parseWebhookUrl,
  saveHouseholdChannelSchema,
  toChannelSummary,
  type ChannelPlatform,
  type HouseholdChannelRecord,
} from '../../../src/models/householdChannel.js';

/**
 * The webhook allow-list (#674). Every refusal below is paired with a
 * negative control — the nearest address that IS accepted — so a validator
 * that refused everything (or a test whose "bad" URL was bad for some other
 * reason) cannot pass as a working allow-list.
 */
const DISCORD =
  'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwx';
// Deliberately short of gitleaks' slack-webhook-url pattern (43+ characters
// after /services/), so a fixture is never mistaken for a leaked hook.
const SLACK = 'https://hooks.slack.com/services/T0123ABC/B0456EFG/abcdefghijklmnop';
const MATRIX = 'https://hookshot.example-family.org/webhook/7c1f5a2b-9d3e-4c11-8f00-1234567890ab';

function ok(platform: ChannelPlatform, url: string) {
  const parsed = parseWebhookUrl(platform, url);
  expect(parsed.ok, `${platform}: ${url}`).toBe(true);
  return parsed;
}

function refused(platform: ChannelPlatform, url: string) {
  const parsed = parseWebhookUrl(platform, url);
  expect(parsed.ok, `${platform}: ${url}`).toBe(false);
  return parsed.ok ? null : parsed.problem;
}

describe('parseWebhookUrl — the positive controls', () => {
  it('accepts a real-shaped Discord, Slack and Matrix (hookshot) webhook', () => {
    ok('discord', DISCORD);
    ok('slack', SLACK);
    ok('matrix', MATRIX);
    // A hookshot deployed under a path prefix.
    ok('matrix', 'https://matrix.example-family.org/hookshot/webhook/abcdefgh12345678');
  });

  it('normalises an explicit :443 away rather than refusing it', () => {
    ok('slack', SLACK.replace('hooks.slack.com', 'hooks.slack.com:443'));
  });

  it('keeps only the host and the last four characters for display', () => {
    const parsed = ok('discord', DISCORD);
    if (!parsed.ok) return;
    expect(parsed.host).toBe('discord.com');
    expect(parsed.last4).toBe('uvwx');
    expect(formatMaskedUrl(parsed.host, parsed.last4)).toBe('discord.com/…uvwx');
    expect(formatMaskedUrl(parsed.host, parsed.last4)).not.toContain('123456789012345678');
  });
});

describe('parseWebhookUrl — scheme, credentials, port, query', () => {
  it('refuses plain http (control: the same address over https passes)', () => {
    expect(refused('discord', DISCORD.replace('https:', 'http:'))).toBe('not_https');
    ok('discord', DISCORD);
  });

  it('refuses other schemes outright', () => {
    for (const url of [
      'ftp://discord.com/api/webhooks/1/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect(['not_https', 'not_a_url']).toContain(refused('discord', url));
    }
  });

  it('refuses user-info — the classic "discord.com@evil.example" confusion', () => {
    expect(
      refused(
        'discord',
        'https://discord.com@evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz'
      )
    ).toBe('has_credentials');
  });

  it('refuses a non-default port (control: :443 passes, above)', () => {
    expect(refused('matrix', MATRIX.replace('.org/', '.org:8448/'))).toBe('has_port');
    expect(refused('slack', SLACK.replace('hooks.slack.com', 'hooks.slack.com:8443'))).toBe(
      'has_port'
    );
  });

  it('refuses a query string or fragment, even an empty one', () => {
    expect(refused('discord', `${DISCORD}?wait=true`)).toBe('has_query');
    expect(refused('discord', `${DISCORD}?`)).toBe('has_query');
    expect(refused('slack', `${SLACK}#x`)).toBe('has_query');
  });

  it('refuses garbage and over-long input', () => {
    expect(refused('slack', 'not a url')).toBe('not_a_url');
    expect(refused('slack', `${SLACK}${'a'.repeat(600)}`)).toBe('too_long');
  });
});

describe('parseWebhookUrl — host allow-list', () => {
  it('Discord: only discord.com (controls: the exact host passes)', () => {
    const path = new URL(DISCORD).pathname;
    for (const host of [
      'discord.com.evil.example',
      'evil-discord.com',
      'discordapp.com',
      'ptb.discord.com',
      'discord.co',
    ]) {
      expect(refused('discord', `https://${host}${path}`), host).toBe('wrong_host');
    }
    ok('discord', `https://discord.com${path}`);
  });

  it('Slack: only hooks.slack.com', () => {
    const path = new URL(SLACK).pathname;
    for (const host of ['slack.com', 'hooks.slack.com.evil.example', 'hooks-slack.com']) {
      expect(refused('slack', `https://${host}${path}`), host).toBe('wrong_host');
    }
    ok('slack', `https://hooks.slack.com${path}`);
  });

  it('a Discord address is not accepted as Slack, nor the reverse', () => {
    expect(refused('slack', DISCORD)).toBe('wrong_host');
    expect(refused('discord', SLACK)).toBe('wrong_host');
  });

  it('Matrix: refuses IP literals in every spelling the URL parser normalises', () => {
    const path = new URL(MATRIX).pathname;
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.8',
      '2130706433', // decimal 127.0.0.1
      '0x7f.1', // hex/short form of 127.0.0.1
      '[::1]',
      '[fd00:ec2::254]',
    ]) {
      expect(refused('matrix', `https://${host}${path}`), host).toBe('ip_literal');
    }
  });

  it('Matrix: refuses internal and single-label names (control: a public name passes)', () => {
    const path = new URL(MATRIX).pathname;
    for (const host of [
      'localhost',
      'metadata',
      'instance-data',
      'matrix.local',
      'metadata.google.internal',
      'synapse.lan',
      'matrix.home.arpa',
      'foo.localhost',
    ]) {
      const problem = refused('matrix', `https://${host}${path}`);
      expect(['private_host', 'wrong_host'], host).toContain(problem);
    }
    ok('matrix', `https://matrix.example-family.org${path}`);
  });

  it('Matrix: refuses a trailing-dot name', () => {
    expect(refused('matrix', MATRIX.replace('.org/', '.org./'))).toBe('wrong_host');
  });
});

describe('parseWebhookUrl — path shape', () => {
  it('Discord: only /api/webhooks/{id}/{token}', () => {
    for (const path of [
      '/api/webhooks/123/short',
      '/api/v10/users/@me',
      '/',
      '/api/webhooks/abc/AbCdEfGhIjKlMnOpQrStUvWxYz',
    ]) {
      expect(refused('discord', `https://discord.com${path}`), path).toBe('wrong_path');
    }
  });

  it('Slack: only /services/{team}/{bot}/{secret}', () => {
    expect(refused('slack', 'https://hooks.slack.com/workflows/T1/A2/3/xyz')).toBe('wrong_path');
    expect(refused('slack', 'https://hooks.slack.com/services/')).toBe('wrong_path');
  });

  it('Matrix: must end in /webhook/{id}', () => {
    expect(refused('matrix', 'https://matrix.example-family.org/_matrix/client/v3/login')).toBe(
      'wrong_path'
    );
    expect(refused('matrix', 'https://matrix.example-family.org/webhook/short')).toBe('wrong_path');
    expect(refused('matrix', 'https://matrix.example-family.org/webhook/../admin/abcdefgh')).toBe(
      'wrong_path'
    );
  });
});

describe('backoffMs', () => {
  it('doubles from an hour and caps at a day', () => {
    expect(backoffMs(1)).toBe(60 * 60 * 1000);
    expect(backoffMs(2)).toBe(2 * 60 * 60 * 1000);
    expect(backoffMs(4)).toBe(8 * 60 * 60 * 1000);
    expect(backoffMs(9)).toBe(CHANNEL_MAX_BACKOFF_MS);
    expect(backoffMs(50)).toBe(CHANNEL_MAX_BACKOFF_MS);
  });

  it('honours a longer Retry-After, but never past the cap', () => {
    expect(backoffMs(1, 3 * 60 * 60)).toBe(3 * 60 * 60 * 1000);
    expect(backoffMs(1, 10)).toBe(60 * 60 * 1000);
    expect(backoffMs(1, 7 * 24 * 60 * 60)).toBe(CHANNEL_MAX_BACKOFF_MS);
  });
});

describe('saveHouseholdChannelSchema', () => {
  const base = {
    platform: 'discord',
    events: { dailyDue: true, upForGrabs: false },
    quietStart: '',
    quietEnd: '',
    timezone: 'America/Los_Angeles',
    locale: 'en',
  };

  it('accepts a settings-only save without an address', () => {
    expect(saveHouseholdChannelSchema.safeParse(base).success).toBe(true);
  });

  it('requires both ends of quiet hours or neither', () => {
    expect(
      saveHouseholdChannelSchema.safeParse({ ...base, quietStart: '22:00', quietEnd: '' }).success
    ).toBe(false);
    expect(
      saveHouseholdChannelSchema.safeParse({ ...base, quietStart: '22:00', quietEnd: '07:00' })
        .success
    ).toBe(true);
  });

  it('refuses unknown fields and platforms', () => {
    expect(saveHouseholdChannelSchema.safeParse({ ...base, platform: 'teams' }).success).toBe(
      false
    );
    expect(saveHouseholdChannelSchema.safeParse({ ...base, sealedUrl: 'x' }).success).toBe(false);
  });
});

describe('toChannelSummary', () => {
  it('never carries the ciphertext, the url version or who connected it', () => {
    const record: HouseholdChannelRecord = {
      householdId: 'hh-1',
      platform: 'slack',
      sealedUrl: 'AQICAHh-sealed-ciphertext',
      urlVersion: 'version-secret',
      host: 'hooks.slack.com',
      last4: 'uvwx',
      events: { dailyDue: true, upForGrabs: true },
      quietStart: '22:00',
      quietEnd: '07:00',
      timezone: 'UTC',
      locale: 'es',
      status: 'active',
      disabledReason: null,
      consecutiveFailures: 0,
      consecutiveClientErrors: 0,
      nextAttemptAt: null,
      lastFailure: null,
      lastDeliveredAt: null,
      lastTestAt: null,
      connectedBy: 'user-admin',
      connectedAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    const summary = JSON.stringify(toChannelSummary(record));
    expect(summary).toContain('hooks.slack.com/…uvwx');
    expect(summary).not.toContain('AQICAHh');
    expect(summary).not.toContain('version-secret');
    expect(summary).not.toContain('user-admin');
  });
});

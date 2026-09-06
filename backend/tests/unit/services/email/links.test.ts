import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiBaseUrl,
  appUrl,
  isOwnAssetUrl,
  plantUrl,
  safeLinkUrl,
  taskUrl,
  tasksUrl,
  unsubscribeUrl,
} from '../../../../src/services/email/links.js';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL,
    FRONTEND_URL: 'https://app.example/',
    ASSETS_BASE_URL: 'https://cdn.example',
    PUBLIC_API_URL: 'https://api.example/prod',
  };
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('deep links', () => {
  it('links a plant to that plant, not to the dashboard', () => {
    expect(plantUrl('p-1')).toBe('https://app.example/plants/p-1');
  });

  it('encodes ids that would otherwise change the path', () => {
    expect(plantUrl('a/b?c')).toBe('https://app.example/plants/a%2Fb%3Fc');
  });

  it('lands a task on its own plant and carries the task id forward', () => {
    // The SPA has no /tasks/:id route, so the closest thing to "that exact
    // task" is its plant. The query parameter is the forward hook.
    expect(taskUrl('p-1', 't-9')).toBe('https://app.example/plants/p-1?task=t-9');
  });

  it('normalizes a trailing slash on the configured base', () => {
    expect(appUrl('/settings')).toBe('https://app.example/settings');
    expect(tasksUrl()).toBe('https://app.example/tasks?filter=due');
  });
});

describe('capability URLs', () => {
  it('points the unsubscribe link at the API, not the SPA origin', () => {
    expect(unsubscribeUrl('tok')).toBe(
      'https://api.example/prod/notifications/email/unsubscribe?t=tok'
    );
  });

  it('returns null in production when PUBLIC_API_URL is unset', () => {
    // Deliberate: a 404ing unsubscribe link is worse for deliverability than
    // no List-Unsubscribe header, so the caller omits both.
    process.env = { ...ORIGINAL, NODE_ENV: 'production' };
    delete process.env.PUBLIC_API_URL;
    expect(apiBaseUrl()).toBeNull();
    expect(unsubscribeUrl('tok')).toBeNull();
  });

  it('falls back to the local API in development', () => {
    process.env = { ...ORIGINAL, NODE_ENV: 'development' };
    delete process.env.PUBLIC_API_URL;
    expect(apiBaseUrl()).toBe('http://localhost:4000');
  });
});

describe('safeLinkUrl', () => {
  it('accepts http, https and mailto', () => {
    expect(safeLinkUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeLinkUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(safeLinkUrl('mailto:hi@example.net')).toBe('mailto:hi@example.net');
  });

  it('rejects everything else without throwing', () => {
    // eslint-disable-next-line no-script-url -- exercising the guard
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(safeLinkUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeLinkUrl('/relative')).toBeNull();
    expect(safeLinkUrl(null)).toBeNull();
    expect(safeLinkUrl('')).toBeNull();
  });
});

describe('isOwnAssetUrl', () => {
  it('accepts an image under our own asset origin', () => {
    expect(isOwnAssetUrl('https://cdn.example/plants/h/p/photo.jpg')).toBe(true);
  });

  it('rejects any other host, however similar', () => {
    expect(isOwnAssetUrl('https://cdn.example.attacker.test/plants/x.jpg')).toBe(false);
    expect(isOwnAssetUrl('https://evil.example/plants/x.jpg')).toBe(false);
    expect(isOwnAssetUrl('https://cdn.example:8443/plants/x.jpg')).toBe(false);
  });

  it('rejects non-http schemes and unparseable values', () => {
    expect(isOwnAssetUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isOwnAssetUrl('not a url')).toBe(false);
    expect(isOwnAssetUrl(null)).toBe(false);
  });

  it('honours a path prefix on the asset base', () => {
    process.env.ASSETS_BASE_URL = 'https://cdn.example/media';
    expect(isOwnAssetUrl('https://cdn.example/media/plants/x.jpg')).toBe(true);
    expect(isOwnAssetUrl('https://cdn.example/other/plants/x.jpg')).toBe(false);
  });
});

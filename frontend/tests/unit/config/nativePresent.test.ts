import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANCEL_ACTION_ID,
  MAX_PRESENT_ACTIONS,
  chosenAction,
  confirmRequest,
  menuRequest,
  presentProblem,
  removePlantRequest,
  type NativePresentRequest,
} from '@/config/nativePresent';
import { hasNativePresent } from '@/lib/platform';

/**
 * NativeChrome's `present` (Apple's alerts and action sheets in the iOS app),
 * from the web's side: the requests the dialogs send, the one rule that
 * matters (only a tap on a non-cancel button is a choice), and the contract
 * with the Swift that reads them. Swift is not compiled in CI, so, like
 * nativeFrame.test.ts, this reads the Swift source.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const plugin = read('ios/App/App/NativeChromePlugin.swift');
const model = read('ios/App/App/NativePresentModel.swift');
const controller = read('ios/App/App/NativeFrameController.swift');

const confirm = confirmRequest({
  title: 'Leave Maple Street?',
  message: 'You can be invited back.',
  confirmLabel: 'Leave household',
  cancelLabel: 'Stay',
  variant: 'danger',
});

const remove = removePlantRequest({
  title: 'Move Fern out of active care?',
  message: 'Archive it…',
  archive: 'Archive for later',
  gaveAway: 'I gave it away',
  passport: 'Print its passport first',
  died: 'It died',
  moveToTrash: 'Delete — it stays in the trash for 30 days',
  cancel: 'Cancel',
});

describe('the requests the dialogs send', () => {
  it('a danger confirmation: the confirm button is destructive, Cancel is the cancel action', () => {
    expect(confirm).toEqual({
      kind: 'alert',
      title: 'Leave Maple Street?',
      message: 'You can be invited back.',
      actions: [
        { id: 'confirm', title: 'Leave household', style: 'destructive' },
        { id: CANCEL_ACTION_ID, title: 'Stay', style: 'cancel' },
      ],
    });
    expect(presentProblem(confirm)).toBeNull();
  });

  it('a primary confirmation is not drawn red', () => {
    const primary = confirmRequest({
      title: 'Log it anyway?',
      message: 'Already done.',
      confirmLabel: 'Log anyway',
      cancelLabel: 'Don’t log',
      variant: 'primary',
    });
    expect(primary.actions[0]).toEqual({ id: 'confirm', title: 'Log anyway', style: 'default' });
    expect(presentProblem(primary)).toBeNull();
  });

  it('Remove plant: the four outcomes, the passport, Delete in red, Cancel apart', () => {
    expect(remove.kind).toBe('actionSheet');
    expect(remove.actions.map((a) => [a.id, a.style])).toEqual([
      ['archive', 'default'],
      ['gaveAway', 'default'],
      ['passport', 'default'],
      ['died', 'default'],
      ['delete', 'destructive'],
      ['cancel', 'cancel'],
    ]);
    expect(presentProblem(remove)).toBeNull();
    const noPassport = removePlantRequest({
      title: 't',
      message: 'm',
      archive: 'a',
      gaveAway: 'g',
      died: 'd',
      moveToTrash: 'x',
      cancel: 'c',
    });
    expect(noPassport.actions.map((a) => a.id)).not.toContain('passport');
  });

  it('a menu: one default action per option, then Cancel', () => {
    const menu = menuRequest({
      title: 'Snooze',
      options: [
        { id: 'snooze-1', title: '1 day' },
        { id: 'snooze-0', title: 'Skip cycle' },
      ],
      cancel: 'Cancel',
    });
    expect(menu.actions.map((a) => a.style)).toEqual(['default', 'default', 'cancel']);
    expect(presentProblem(menu)).toBeNull();
  });

  it('refuses what Swift refuses: no way out, two ways out, nothing to choose, no words', () => {
    const base: Omit<NativePresentRequest, 'token'> = { kind: 'alert', title: 'x', actions: [] };
    const a = (id: string, style: 'default' | 'destructive' | 'cancel') => ({
      id,
      title: id,
      style,
    });
    expect(presentProblem({ ...base, actions: [a('go', 'destructive')] })).toMatch(/cancel/);
    expect(
      presentProblem({
        ...base,
        actions: [a('c1', 'cancel'), a('c2', 'cancel'), a('go', 'default')],
      })
    ).toMatch(/cancel/);
    expect(presentProblem({ ...base, actions: [a('c', 'cancel')] })).not.toBeNull();
    expect(presentProblem({ ...base, actions: [a('x', 'default'), a('x', 'cancel')] })).toMatch(
      /duplicate/
    );
    expect(
      presentProblem({ kind: 'alert', title: ' ', actions: [a('go', 'default'), a('c', 'cancel')] })
    ).not.toBeNull();
    const many = Array.from({ length: MAX_PRESENT_ACTIONS }, (_, i) => a(`o${i}`, 'default'));
    expect(presentProblem({ ...base, actions: [...many, a('c', 'cancel')] })).not.toBeNull();
  });
});

describe('only a tap on a non-cancel button is a choice', () => {
  it('reports the tapped action', () => {
    expect(chosenAction(confirm, { id: 'confirm' })).toBe('confirm');
    expect(chosenAction(remove, { id: 'delete' })).toBe('delete');
  });

  it('anything else is no choice: null, Cancel, an unknown id, a malformed answer', () => {
    for (const answer of [
      { id: null },
      { id: CANCEL_ACTION_ID },
      { id: 'Confirm' },
      { id: 'confirm ' },
      { id: 1 },
      {},
      null,
      undefined,
      'confirm',
    ]) {
      expect(chosenAction(confirm, answer), JSON.stringify(answer)).toBeNull();
    }
  });

  it('a cancel-styled action never counts, whatever its id', () => {
    const sneaky = {
      actions: [
        { id: 'confirm', title: 'Cancel', style: 'cancel' as const },
        { id: 'other', title: 'Other', style: 'default' as const },
      ],
    };
    expect(chosenAction(sneaky, { id: 'confirm' })).toBeNull();
  });
});

describe('the Swift side reads the same messages', () => {
  const body = plugin.slice(
    plugin.indexOf('@objc func present('),
    plugin.indexOf('@objc func updatePresented(')
  );

  it('reads every request field the web sends, by the same name', () => {
    const request: NativePresentRequest = {
      ...remove,
      token: 't',
      anchor: { x: 1, y: 2, width: 3, height: 4 },
    };
    const fields = new Set([...body.matchAll(/call\.get\w+\("([^"]+)"\)/g)].map((m) => m[1]));
    expect([...fields].sort()).toEqual(Object.keys(request).sort());
    for (const key of Object.keys(request.anchor!)) expect(body).toContain(`raw["${key}"]`);
    for (const key of Object.keys(request.actions[0])) expect(model).toContain(`item["${key}"]`);
  });

  it('knows every kind and style by the same name', () => {
    for (const kind of ['alert', 'actionSheet'])
      expect(model).toMatch(new RegExp(`case ${kind}\\b`));
    for (const style of ['default', 'destructive', 'cancel']) {
      expect(model).toMatch(new RegExp(`case \`?${style}\`?\\b`));
    }
    // ...and draws destructive in red and cancel apart (UIAlertAction's own styles).
    expect(controller).toContain('case .destructive: return .destructive');
    expect(controller).toContain('case .cancel: return .cancel');
  });

  it('answers { id }, null for no choice', () => {
    expect(body).toContain('call.resolve(["id": id ?? NSNull()])');
  });

  it('reads updatePresented and dismissPresented by token', () => {
    const update = plugin.slice(
      plugin.indexOf('@objc func updatePresented('),
      plugin.indexOf('@objc func dismissPresented(')
    );
    for (const key of ['token', 'title', 'message']) expect(update).toContain(`"${key}"`);
    const dismiss = plugin.slice(
      plugin.indexOf('@objc func dismissPresented('),
      plugin.indexOf('// Events for the web')
    );
    expect(dismiss).toContain('"token"');
  });

  it('closes an alert as no choice when the app goes to the background', () => {
    expect(controller).toMatch(
      /didEnterBackgroundNotification[\s\S]{0,200}dismissPresented\(token: nil\)/
    );
    // ...and answers before it slides away, so nothing during the slide can.
    expect(controller).toMatch(/current\.outcome\?\.cancel\(\)\s*\n[\s\S]{0,200}alert\.dismiss/);
  });
});

describe('hasNativePresent', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  const shell = (platform: string, plugins: Array<{ name: string; methods: string[] }>) => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      PluginHeaders: plugins.map((p) => ({
        name: p.name,
        methods: p.methods.map((name) => ({ name })),
      })),
    };
  };

  it('is true in the iOS app whose NativeChrome plugin can present', () => {
    shell('ios', [{ name: 'NativeChrome', methods: ['configure', 'update', 'present'] }]);
    expect(hasNativePresent()).toBe(true);
  });

  it('is false on the website, on Android, without the plugin, or with a frame that cannot present', () => {
    expect(hasNativePresent()).toBe(false);
    shell('android', [{ name: 'NativeChrome', methods: ['present'] }]);
    expect(hasNativePresent()).toBe(false);
    shell('ios', [{ name: 'Print', methods: ['present'] }]);
    expect(hasNativePresent()).toBe(false);
    shell('ios', [{ name: 'NativeChrome', methods: ['configure', 'update'] }]);
    expect(hasNativePresent()).toBe(false);
  });
});

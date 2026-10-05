import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import {
  addTaskFormRequest,
  formSheetValues,
  type NativeFormSheetField,
} from '@/config/nativeFormSheet';

/**
 * Add care task as a native form sheet: what the web sends Swift, and what it
 * accepts back. The rule both sides keep: only the sheet's own submit button
 * reports values; everything else closes the form without writing.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const model = read('ios/App/App/NativeFormSheetModel.swift');
const sheet = read('ios/App/App/NativeFormSheet.swift');
const plugin = read('ios/App/App/NativeChromePlugin.swift');
const controller = read('ios/App/App/NativeFrameController.swift');

const t = i18n.t.bind(i18n);
const request = addTaskFormRequest(t, { type: 'water', customType: '', frequency: 7, notes: '' });

describe('the Add care task sheet the web sends', () => {
  it('has the task kind, a custom name shown only for Custom, how often, and notes', () => {
    expect(request).toMatchObject({ title: 'Add care task', cancel: 'Cancel', submit: 'Add' });
    expect(request.fields.map((f) => [f.kind, f.id])).toEqual([
      ['choice', 'type'],
      ['text', 'customType'],
      ['stepper', 'frequency'],
      ['text', 'notes'],
    ]);
    const type = request.fields[0] as Extract<NativeFormSheetField, { kind: 'choice' }>;
    expect(type.options.map((o) => o.id)).toEqual([
      'water',
      'fertilize',
      'prune',
      'repot',
      'custom',
    ]);
    expect(type.value).toBe('water');
    expect(request.fields[1]).toMatchObject({
      required: true,
      maxLength: 50,
      visibleWhen: { field: 'type', equals: 'custom' },
    });
    expect(request.fields[2]).toMatchObject({
      value: 7,
      min: 1,
      max: 365,
      one: 'Every day',
      other: 'Every {n} days',
    });
  });

  it('carries the reason a save came back, when there is one', () => {
    const again = addTaskFormRequest(
      t,
      { type: 'custom', customType: 'Rotate', frequency: 9, notes: 'n' },
      'Server said no'
    );
    expect(again.message).toBe('Server said no');
    expect(again.fields.find((f) => f.id === 'frequency')).toMatchObject({ value: 9 });
    expect(request).not.toHaveProperty('message');
  });

  it('uses only keys and kinds that the Swift parser reads', () => {
    for (const key of ['title', 'message', 'cancel', 'submit', 'fields']) {
      expect(model).toContain(`"${key}"`);
    }
    const keys = new Set(request.fields.flatMap((f) => Object.keys(f)));
    for (const key of keys) expect(model).toContain(`"${key}"`);
    for (const kind of ['choice', 'stepper', 'text']) expect(model).toContain(`case "${kind}"`);
    expect(model).toContain('"{n}"');
  });
});

describe('what the web accepts back', () => {
  const sent = { type: 'water', frequency: 7, notes: 'Bottom-water' };

  it('a submit: the values, as Add care task values', () => {
    expect(formSheetValues({ values: sent })).toEqual({
      type: 'water',
      customType: '',
      frequency: 7,
      notes: 'Bottom-water',
    });
    expect(
      formSheetValues({ values: { type: 'custom', customType: ' Rotate ', frequency: 3 } })
    ).toEqual({ type: 'custom', customType: 'Rotate', frequency: 3, notes: '' });
  });

  it('anything else is no submit: no answer, null values, or values this form never sends', () => {
    expect(formSheetValues(null)).toBeNull();
    expect(formSheetValues(undefined)).toBeNull();
    expect(formSheetValues({ values: null })).toBeNull();
    expect(formSheetValues({ values: { ...sent, type: 'dance' } })).toBeNull();
    expect(formSheetValues({ values: { ...sent, frequency: '7' } })).toBeNull();
    expect(formSheetValues({ values: { ...sent, frequency: 0 } })).toBeNull();
    expect(formSheetValues({ values: { ...sent, frequency: 366 } })).toBeNull();
    expect(formSheetValues({ values: { ...sent, frequency: 2.5 } })).toBeNull();
    expect(
      formSheetValues({ values: { type: 'custom', customType: '  ', frequency: 3 } })
    ).toBeNull();
  });
});

describe('the Swift side keeps the same rule', () => {
  it('registers presentForm and answers { values } or { values: null }', () => {
    expect(plugin).toMatch(/CAPPluginMethod\(name: "presentForm"/);
    expect(plugin).toMatch(/call\.resolve\(\["values": values \?\? NSNull\(\)\]\)/);
    // The web closing it, by token, closes a form sheet too.
    expect(plugin).toMatch(/dismissForm\(token: token\)/);
  });

  it('Cancel and a swipe down answer no values; only the submit button sends them', () => {
    expect(sheet).toMatch(
      /func presentationControllerDidDismiss\([^)]*\) \{\s*outcome\?\.cancel\(\)\s*\}/
    );
    expect(sheet).toMatch(/@objc func cancelTapped\(\) \{\s*outcome\?\.cancel\(\)/);
    expect(sheet).toMatch(
      /@objc func submitTapped\(\)[\s\S]*?outcome\.submit\(request, values: state\.values\)/
    );
    expect(model).toMatch(
      /func submit\(_ request: FormSheetRequest[\s\S]*?guard request\.canSubmit\(values\)/
    );
    expect(model).toMatch(/deinit \{\s*if !answered \{ completion\(nil\) \}/);
  });

  it('a form is not closed when the app goes to the background; an alert still is', () => {
    expect(controller).toMatch(
      /didEnterBackgroundNotification[\s\S]{0,120}dismissPresented\(token: nil\)/
    );
    expect(controller).not.toMatch(/didEnterBackgroundNotification[\s\S]{0,160}dismissForm/);
  });
});

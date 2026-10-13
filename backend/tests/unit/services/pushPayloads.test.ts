/**
 * The three payload builders a push notification passes through, as pure
 * functions: `notifier.pushPayloadOf` (what both push legs send), the APNs
 * payload for iOS and the FCM message for Android. The transports themselves
 * are covered end to end by apnsNotifier.test.ts and devicePush.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { pushPayloadOf, type NotificationPayload } from '../../../src/services/notifier.js';
import { apnsPayload, APNS_REMINDER_CATEGORY } from '../../../src/services/apnsNotifier.js';
import { ANDROID_REMINDER_KIND, messageBody } from '../../../src/services/fcmNotifier.js';

const TASK = { taskId: 't1', plantId: 'p1', expectedNextDue: '2026-06-01T08:00:00.000Z' };

const reminder: NotificationPayload = {
  title: 'Plant care reminder: 1 due today',
  body: 'Here is where your household stands...\n\n1. Monstera — water, due today',
  shortBody: '1 due today',
  url: 'https://familygreenhouse.net/tasks?filter=due',
  tag: 'reminder-hh-2026-06-01',
  badge: 1,
  emailReplyTo: 'care+abc@familygreenhouse.net',
  push: {
    title: 'Water the Monstera',
    body: 'Due today. Mark it done once you have, or snooze it until tomorrow.',
    url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
    task: TASK,
    actions: { done: 'Done', snooze: 'Snooze until tomorrow' },
  },
};

describe('pushPayloadOf', () => {
  it('shows the push presentation, keeps the tag and badge, and never the reply address', () => {
    const push = pushPayloadOf(reminder);
    expect(push).toEqual({
      title: 'Water the Monstera',
      body: 'Due today. Mark it done once you have, or snooze it until tomorrow.',
      url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
      tag: 'reminder-hh-2026-06-01',
      badge: 1,
      task: TASK,
      actions: { done: 'Done', snooze: 'Snooze until tomorrow' },
    });
    expect(JSON.stringify(push)).not.toContain('care+abc');
    expect(push).not.toHaveProperty('emailReplyTo');
    expect(push).not.toHaveProperty('shortBody');
  });

  it('falls back to the title and the compact body for a payload with no presentation', () => {
    const push = pushPayloadOf({
      title: 'Pest season heads-up',
      body: 'Aphids are active...',
      url: 'https://familygreenhouse.net/plants/p1',
      tag: 'pest-alert-hh-p1-aphid',
    });
    expect(push).toEqual({
      title: 'Pest season heads-up',
      body: 'Aphids are active...',
      url: 'https://familygreenhouse.net/plants/p1',
      tag: 'pest-alert-hh-p1-aphid',
    });
  });

  it('prefers shortBody for the compact body, as before', () => {
    expect(pushPayloadOf({ title: 't', body: 'long\nlist', shortBody: 'short' }).body).toBe(
      'short'
    );
  });

  it('carries actions only alongside the task they act on', () => {
    const push = pushPayloadOf({
      ...reminder,
      push: { ...reminder.push!, task: undefined },
    });
    expect(push).not.toHaveProperty('task');
    expect(push).not.toHaveProperty('actions');
  });
});

describe('apnsPayload', () => {
  const token = 'AB'.repeat(32);

  it('sets the actionable category and the task ids for a single-task reminder', () => {
    const payload = apnsPayload({
      token,
      title: 'Water the Monstera',
      body: 'Due today.',
      url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
      tag: 'reminder-hh-2026-06-01',
      badge: 1,
      task: TASK,
    });
    expect(payload).toEqual({
      aps: {
        alert: { title: 'Water the Monstera', body: 'Due today.' },
        sound: 'default',
        badge: 1,
        'thread-id': 'reminder-hh-2026-06-01',
        category: APNS_REMINDER_CATEGORY,
      },
      url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
      taskId: 't1',
      plantId: 'p1',
      expectedNextDue: '2026-06-01T08:00:00.000Z',
    });
  });

  it('sets no category when there is no single task to act on', () => {
    const payload = apnsPayload({
      token,
      title: '2 plants need water',
      body: 'Fern and Monstera.',
    });
    expect(payload.aps).not.toHaveProperty('category');
    expect(payload).not.toHaveProperty('taskId');
  });

  it('pins the category identifier the iOS app registers', () => {
    // frontend/ios/App/App/AppDelegate.swift registers this exact string with
    // the `done` and `snooze` actions; a rename on either side silently
    // drops the buttons.
    expect(APNS_REMINDER_CATEGORY).toBe('FG_TASK_REMINDER');
  });
});

describe('FCM messageBody', () => {
  type Body = { message: { data: Record<string, string>; android: Record<string, unknown> } };

  it('is a data message the app draws: words, link, task ids and button labels, all strings', () => {
    const body = messageBody({
      token: 'fcm-token',
      title: 'Water the Monstera',
      body: 'Due today.',
      url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
      tag: 'reminder-p1',
      badge: 1,
      task: TASK,
      actions: { done: 'Done', snooze: 'Snooze until tomorrow' },
    }) as Body;
    expect(body.message.data).toEqual({
      kind: ANDROID_REMINDER_KIND,
      title: 'Water the Monstera',
      body: 'Due today.',
      url: 'https://familygreenhouse.net/plants/p1?task=t1#care',
      tag: 'reminder-p1',
      badge: '1',
      taskId: 't1',
      plantId: 'p1',
      expectedNextDue: '2026-06-01T08:00:00.000Z',
      doneLabel: 'Done',
      snoozeLabel: 'Snooze until tomorrow',
    });
    for (const value of Object.values(body.message.data)) expect(typeof value).toBe('string');
    // No `notification` block: FCM would draw that itself, without buttons.
    expect(body.message).not.toHaveProperty('notification');
    expect(body.message.android).toEqual({ priority: 'HIGH', collapse_key: 'reminder-p1' });
  });

  it('offers no buttons without a single task, even when labels are passed', () => {
    const body = messageBody({
      token: 'fcm-token',
      title: '2 plants need water',
      body: 'Monstera and Pothos.',
      actions: { done: 'Done', snooze: 'Snooze until tomorrow' },
    }) as Body;
    expect(body.message.data).toEqual({
      kind: ANDROID_REMINDER_KIND,
      title: '2 plants need water',
      body: 'Monstera and Pothos.',
    });
  });

  it('pins the kind the Android app looks for', () => {
    // frontend/android/.../push/ReminderMessage.kt draws only this kind; a
    // rename on either side silently shows nothing.
    expect(ANDROID_REMINDER_KIND).toBe('fg.reminder.v1');
  });
});

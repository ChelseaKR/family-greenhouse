import { describe, expect, it } from 'vitest';
import { trialLifecycleEmailsEnabled } from '../../../src/config/trialLifecycleEmails.js';

describe('trialLifecycleEmailsEnabled', () => {
  it('is off by default', () => {
    expect(trialLifecycleEmailsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is on only for the exact string true', () => {
    expect(trialLifecycleEmailsEnabled({ TRIAL_LIFECYCLE_EMAILS_ENABLED: 'true' } as never)).toBe(
      true
    );
    for (const v of ['1', 'TRUE', 'True', ' true', 'true ', 'yes', 'on', 'false', '']) {
      expect(trialLifecycleEmailsEnabled({ TRIAL_LIFECYCLE_EMAILS_ENABLED: v } as never)).toBe(
        false
      );
    }
  });
});

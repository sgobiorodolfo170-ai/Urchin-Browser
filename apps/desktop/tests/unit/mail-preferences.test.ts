import { describe, expect, it } from 'vitest';
import {
  defaultMailPreferences,
  isBlockedMail,
  mailPreferencesSchema,
} from '../../src/renderer/mail/preferences';
describe('mail preferences', () => {
  it('requires valid persisted appearance values', () => {
    expect(mailPreferencesSchema.safeParse({ density: 'invalid' }).success).toBe(false);
  });
  it('matches sender addresses exactly and subject keywords without case sensitivity', () => {
    const prefs = {
      ...defaultMailPreferences(),
      spamEnabled: true,
      blockedSenders: ['spam@example.com'],
      blockedWords: ['SALE', ''],
    };
    expect(isBlockedMail('Spammer <spam@example.com>', 'Hello', prefs)).toBe(true);
    expect(isBlockedMail('notspam@example.com', 'Hello', prefs)).toBe(false);
    expect(isBlockedMail('safe@example.com', 'New sale', prefs)).toBe(true);
    expect(isBlockedMail('spam@example.com', 'SALE', { ...prefs, spamEnabled: false })).toBe(false);
  });
});

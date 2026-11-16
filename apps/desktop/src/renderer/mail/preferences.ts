import { z } from 'zod';
export const MAIL_PREFERENCES_KEY = 'mail.preferences';
export const mailPreferencesSchema = z.object({
  defaultAccountId: z.string().default(''),
  names: z.record(z.string()).default({}),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  blockedSenders: z.array(z.string()).default([]),
  blockedWords: z.array(z.string()).default([]),
  spamEnabled: z.boolean().default(false),
});
export type MailPreferences = z.infer<typeof mailPreferencesSchema>;
export const defaultMailPreferences = (): MailPreferences => mailPreferencesSchema.parse({});
export function isBlockedMail(from: string, subject: string, prefs: MailPreferences): boolean {
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  return (
    prefs.spamEnabled &&
    (prefs.blockedSenders.some((s) => s.trim() && s.toLowerCase() === address) ||
      prefs.blockedWords.some((s) => s.trim() && subject.toLowerCase().includes(s.toLowerCase())))
  );
}

import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const health = (await import(pathToFileURL(resolve('scripts/launch-health.mjs')).href)) as {
  isLaunchReady: (record: unknown, pid: number, startedAt: number, now: number) => boolean;
};
describe('启动回执校验', () => {
  it('rejects old, mismatched and stale receipts', () => {
    expect(health.isLaunchReady({ pid: 1, updatedAt: 10 }, 2, 5, 11)).toBe(false);
    expect(health.isLaunchReady({ pid: 1, updatedAt: 10 }, 1, 12, 13)).toBe(false);
    expect(health.isLaunchReady({ pid: 1, updatedAt: 10 }, 1, 5, 7000)).toBe(false);
    expect(health.isLaunchReady({ pid: 1, updatedAt: 10 }, 1, 5, 11)).toBe(true);
  });
});

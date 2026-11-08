/**
 * soft-cap.ts 单元测试
 *
 * 覆盖软上限 token 归一化（数字 / k / m / 千分位）、按模型覆盖表、
 * 以及「软上限 → SDK reserveTokens」换算与放弃条件。
 *
 * 为何 cap 压不下来时要返回 null：若 cap 小于 keepRecent + 最小余量，
 * 换算出的 reserve 会让压缩每次都在工具间隙触发，形成压缩风暴；
 * 宁可不注入，回落到 SDK 默认 reserve。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
}));

import {
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  effectiveSoftCap,
  normalizeAutoCompactionInstructions,
  normalizeSoftCapByModel,
  normalizeSoftCapTokens,
  SOFT_CAP_MAX_OVERRIDES,
  SOFT_CAP_MIN_HEADROOM,
  SOFT_CAP_MIN_TOKENS,
  softCapReserveFor,
  softCapToReserve,
} from '../../src/pi-server/soft-cap.js';

describe('normalizeSoftCapTokens', () => {
  it('should treat zero, negatives, NaN and junk strings as disabled', () => {
    expect(normalizeSoftCapTokens(0)).toBe(0);
    expect(normalizeSoftCapTokens(-5)).toBe(0);
    expect(normalizeSoftCapTokens(NaN)).toBe(0);
    expect(normalizeSoftCapTokens(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeSoftCapTokens('abc')).toBe(0);
    expect(normalizeSoftCapTokens('')).toBe(0);
    expect(normalizeSoftCapTokens('   ')).toBe(0);
    expect(normalizeSoftCapTokens(undefined)).toBe(0);
    expect(normalizeSoftCapTokens(null)).toBe(0);
    expect(normalizeSoftCapTokens({})).toBe(0);
    expect(normalizeSoftCapTokens('12x')).toBe(0);
  });

  it('should floor numbers and clamp to the ten-million ceiling', () => {
    expect(normalizeSoftCapTokens(190000.7)).toBe(190000);
    expect(normalizeSoftCapTokens(99_000_000)).toBe(10_000_000);
    expect(normalizeSoftCapTokens('190000')).toBe(190000);
  });

  it('should support k/m suffixes and grouped digits', () => {
    expect(normalizeSoftCapTokens('300k')).toBe(300000);
    expect(normalizeSoftCapTokens('300K')).toBe(300000);
    expect(normalizeSoftCapTokens('1.5m')).toBe(1500000);
    expect(normalizeSoftCapTokens('1M')).toBe(1000000);
    expect(normalizeSoftCapTokens('300,000')).toBe(300000);
    expect(normalizeSoftCapTokens('300_000')).toBe(300000);
    expect(normalizeSoftCapTokens(' 300 k ')).toBe(300000);
    expect(normalizeSoftCapTokens('99m')).toBe(10_000_000);
  });

  it('should read a small positive number as thousands of tokens', () => {
    expect(normalizeSoftCapTokens(300)).toBe(300000);
    expect(normalizeSoftCapTokens('300')).toBe(300000);
    expect(normalizeSoftCapTokens(128)).toBe(128000);
    expect(normalizeSoftCapTokens(1)).toBe(1000);
    expect(normalizeSoftCapTokens(1000)).toBe(1000000);
    expect(normalizeSoftCapTokens('1001')).toBe(1001);
    expect(normalizeSoftCapTokens('0.0')).toBe(0);
  });
});

describe('normalizeSoftCapByModel', () => {
  it('should keep only non-empty keys with positive values', () => {
    expect(normalizeSoftCapByModel({ 'xai/grok-4': 190000, bad: 0, '': 5 })).toEqual({
      'xai/grok-4': 190000,
    });
  });

  it('should fall back to an empty map for dirty input', () => {
    expect(normalizeSoftCapByModel(null)).toEqual({});
    expect(normalizeSoftCapByModel([])).toEqual({});
    expect(normalizeSoftCapByModel('x')).toEqual({});
  });

  it('should cap the override table and drop over-long keys', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big[`p/m${i}`] = 100000;
    expect(Object.keys(normalizeSoftCapByModel(big))).toHaveLength(SOFT_CAP_MAX_OVERRIDES);
    expect(normalizeSoftCapByModel({ ['k'.repeat(201)]: 190000 })).toEqual({});
    expect(normalizeSoftCapByModel({ '  ': 190000 })).toEqual({});
    expect(normalizeSoftCapByModel({ ' p/m ': 100 })).toEqual({ 'p/m': 100000 });
  });
});

describe('normalizeAutoCompactionInstructions', () => {
  it('should keep strings up to 2000 characters and ignore other types', () => {
    expect(normalizeAutoCompactionInstructions('focus on tests')).toBe('focus on tests');
    expect(normalizeAutoCompactionInstructions('x'.repeat(2500))).toHaveLength(2000);
    expect(normalizeAutoCompactionInstructions(42)).toBe('');
    expect(normalizeAutoCompactionInstructions(null)).toBe('');
  });
});

describe('effectiveSoftCap', () => {
  it('should prefer the per-model override over the global cap', () => {
    expect(effectiveSoftCap(300000, { 'xai/grok-4': 190000 }, 'xai/grok-4')).toBe(190000);
    expect(effectiveSoftCap(300000, { 'xai/grok-4': 190000 }, 'anthropic/claude')).toBe(300000);
    expect(effectiveSoftCap(0, { 'xai/grok-4': 190000 }, 'xai/grok-4')).toBe(190000);
    expect(effectiveSoftCap(0, {}, 'x')).toBe(0);
    expect(effectiveSoftCap(300000, {}, null)).toBe(300000);
    expect(effectiveSoftCap(300000, { 'xai/grok-4': 190000 }, ' xai/grok-4 ')).toBe(190000);
  });
});

describe('softCapToReserve', () => {
  it('should turn a 500K window with a 190K cap into a 310K reserve', () => {
    expect(softCapToReserve(500000, 190000)).toBe(310000);
  });

  it('should return null for illegal combinations so the SDK default applies', () => {
    expect(softCapToReserve(0, 190000)).toBeNull();
    expect(softCapToReserve(Number.NaN, 190000)).toBeNull();
    expect(softCapToReserve(500000, 0)).toBeNull();
    expect(softCapToReserve(500000, Number.NaN)).toBeNull();
    expect(softCapToReserve(500000, SOFT_CAP_MIN_TOKENS - 1)).toBeNull();
    expect(softCapToReserve(200000, 199500)).toBeNull();
    expect(softCapToReserve(200000, 200000)).toBeNull();
  });

  it('should keep the default reserve aligned with the SDK', () => {
    expect(DEFAULT_COMPACTION_RESERVE_TOKENS).toBe(16384);
  });
});

describe('softCapReserveFor (injected reserveTokens, issue #773)', () => {
  it('should translate a legal soft cap into window minus cap', () => {
    expect(softCapReserveFor(1_000_000, 256_000)).toBe(744_000);
    expect(softCapReserveFor(500_000, 190_000, 20_000)).toBe(310_000);
  });

  it('should return null when the soft cap is off or illegal', () => {
    expect(softCapReserveFor(1_000_000, 0)).toBeNull();
    expect(softCapReserveFor(1_000_000, 1500)).toBeNull();
    expect(softCapReserveFor(0, 256_000)).toBeNull();
    expect(softCapReserveFor(200_000, 199_500)).toBeNull();
  });

  it('should never go below the SDK default reserve', () => {
    expect(softCapReserveFor(190_000, 175_000, 20_000)).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
  });

  it('should refuse to inject when the cap cannot go below keepRecent + headroom', () => {
    expect(softCapReserveFor(1_000_000, 20_000, 20_000)).toBeNull();
    expect(softCapReserveFor(1_000_000, 22_000, 20_000)).toBeNull();
    expect(softCapReserveFor(1_000_000, 20_000 + SOFT_CAP_MIN_HEADROOM + 1, 20_000)).toBe(
      1_000_000 - (20_000 + SOFT_CAP_MIN_HEADROOM + 1),
    );
    expect(softCapReserveFor(1_000_000, 20_000)).toBe(980_000);
    expect(softCapReserveFor(1_000_000, 20_000, Number.NaN)).toBe(980_000);
    expect(softCapReserveFor(1_000_000, 20_000, -1)).toBe(980_000);
  });
});

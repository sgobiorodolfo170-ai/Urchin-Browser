/**
 * M24 网页翻译 · 纯函数单元测试（切批 / 语言归一化 / 设置校验 / 缓存键）
 */
import { describe, it, expect } from 'vitest';
import {
  chunkSegments,
  normalizeLangTag,
  sanitizeTargetLang,
  sanitizeEngineSetting,
  cacheKey,
} from '../../../src/main/translate/translate-manager';
import { TRANSLATE_BATCH_MAX_CHARS } from '../../../src/main/translate/engines/types';

function seg(text: string, id = 1): { id: number; text: string } {
  return { id, text };
}

describe('chunkSegments', () => {
  it('should keep small segments in a single batch', () => {
    const batches = chunkSegments([seg('aaa', 1), seg('bbb', 2), seg('ccc', 3)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('should split by segment count cap', () => {
    const batches = chunkSegments(
      [seg('a', 1), seg('b', 2), seg('c', 3), seg('d', 4), seg('e', 5)],
      TRANSLATE_BATCH_MAX_CHARS,
      2,
    );
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('should split by character cap', () => {
    const medium = 'x'.repeat(2000);
    const batches = chunkSegments([seg(medium, 1), seg(medium, 2), seg(medium, 3)], 4000, 40);
    // 2000+2000=4000 恰好不超限同批；第三段 4000+2000>4000 进下一批
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('should give an oversized single segment its own batch', () => {
    const huge = 'y'.repeat(10_000);
    const batches = chunkSegments([seg(huge, 1), seg('tail', 2)]);
    expect(batches).toHaveLength(2);
    expect(batches[0]![0]!.text).toBe(huge);
  });

  it('should return empty array for empty input', () => {
    expect(chunkSegments([])).toEqual([]);
  });
});

describe('normalizeLangTag', () => {
  it('should normalize regional variants to base language', () => {
    expect(normalizeLangTag('en-US')).toBe('en');
    expect(normalizeLangTag('en-GB')).toBe('en');
    expect(normalizeLangTag('pt-BR')).toBe('pt');
  });

  it('should split Chinese variants (simplified vs traditional are not the same)', () => {
    expect(normalizeLangTag('zh')).toBe('zh-CN');
    expect(normalizeLangTag('zh-Hans')).toBe('zh-CN');
    expect(normalizeLangTag('zh-Hant')).toBe('zh-TW');
    expect(normalizeLangTag('zh-HK')).toBe('zh-TW');
    expect(normalizeLangTag('zh-TW')).toBe('zh-TW');
    expect(normalizeLangTag('zh-CN')).toBe('zh-CN');
  });

  it('should return empty string for blank input', () => {
    expect(normalizeLangTag('')).toBe('');
    expect(normalizeLangTag('  ')).toBe('');
  });
});

describe('sanitizeTargetLang / sanitizeEngineSetting / cacheKey', () => {
  it('should accept supported languages and fall back to zh-CN', () => {
    expect(sanitizeTargetLang('ja')).toBe('ja');
    expect(sanitizeTargetLang('klingon')).toBe('zh-CN');
    expect(sanitizeTargetLang(undefined)).toBe('zh-CN');
  });

  it('should accept known engines and fall back to auto', () => {
    expect(sanitizeEngineSetting('google')).toBe('google');
    expect(sanitizeEngineSetting('microsoft')).toBe('microsoft');
    expect(sanitizeEngineSetting('auto')).toBe('auto');
    expect(sanitizeEngineSetting('deepl')).toBe('auto');
  });

  it('should build cache keys distinct by target language', () => {
    expect(cacheKey('zh-CN', 'Hello')).not.toBe(cacheKey('en', 'Hello'));
    expect(cacheKey('zh-CN', 'Hello')).toBe(cacheKey('zh-CN', 'Hello'));
  });
});

/**
 * model-admin/i18n.ts 单元测试
 *
 * 服务端文案语言协商：locale 归一到 ServerLang、繁简判定、翻译表注册/查找、
 * 占位符填充、多行块回退、双语拼接、pack 文件抽取。
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  resolveServerLang,
  isZh,
  isTraditionalLocale,
  registerServerStrings,
  unregisterServerStrings,
  registeredServerLangs,
  getServerString,
  pick,
  formatTable,
  getServerBlock,
  bilingual,
  extractServerStrings,
} from '../src/model-admin/i18n';

afterEach(() => {
  for (const code of registeredServerLangs()) unregisterServerStrings(code);
});

describe('resolveServerLang', () => {
  it('should fold every zh variant into zh', () => {
    expect(resolveServerLang('zh-CN')).toBe('zh');
    expect(resolveServerLang('zh_TW')).toBe('zh');
    expect(resolveServerLang('zh-Hant-HK')).toBe('zh');
  });

  it('should normalise regional codes to their primary subtag', () => {
    expect(resolveServerLang('pt-BR')).toBe('pt');
    expect(resolveServerLang('EN-us')).toBe('en');
    expect(resolveServerLang('ja-JP')).toBe('ja');
  });

  it('should default to en for empty, missing or malformed input', () => {
    expect(resolveServerLang('')).toBe('en');
    expect(resolveServerLang('   ')).toBe('en');
    expect(resolveServerLang(undefined)).toBe('en');
    expect(resolveServerLang(null)).toBe('en');
    expect(resolveServerLang('123')).toBe('en');
  });
});

describe('isZh', () => {
  it('should only be true for zh', () => {
    expect(isZh('zh')).toBe(true);
    expect(isZh('zh-CN')).toBe(false);
    expect(isZh('en')).toBe(false);
  });
});

describe('isTraditionalLocale', () => {
  it('should accept Traditional script and TW/HK/MO regions', () => {
    for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'ZH_tw']) {
      expect(isTraditionalLocale(locale)).toBe(true);
    }
  });

  it('should reject Simplified, bare zh and non-Chinese locales', () => {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans-HK', 'en', '', undefined, null]) {
      expect(isTraditionalLocale(locale)).toBe(false);
    }
  });
});

describe('registerServerStrings / getServerString', () => {
  it('should register a table and look up a non-Chinese language', () => {
    registerServerStrings('ja', {
      'subagents.list.empty': '実行中のサブエージェントはありません。',
    });
    expect(getServerString('ja', 'subagents.list.empty')).toBe(
      '実行中のサブエージェントはありません。',
    );
    expect(registeredServerLangs()).toEqual(['ja']);
  });

  it('should never serve table entries for zh', () => {
    registerServerStrings('zh', { 'a.b': '表值' });
    expect(getServerString('zh', 'a.b')).toBeUndefined();
  });

  it('should return undefined for unknown keys and languages', () => {
    expect(getServerString('ja', 'missing.key')).toBeUndefined();
    expect(getServerString('ko', 'a.b')).toBeUndefined();
    expect(getServerString('en', '')).toBeUndefined();
  });

  it('should normalise the table code the same way as locales', () => {
    registerServerStrings('PT-br', { 'a.b': 'valor' });
    expect(getServerString('pt', 'a.b')).toBe('valor');
    expect(registeredServerLangs()).toEqual(['pt']);
  });

  it('should ignore empty tables and drop non-string values', () => {
    registerServerStrings('fr', {});
    expect(registeredServerLangs()).toEqual([]);

    registerServerStrings('fr', { 'a.b': 'ok', 'c.d': 42 as unknown as string, '': 'x' });
    expect(getServerString('fr', 'a.b')).toBe('ok');
    expect(getServerString('fr', 'c.d')).toBeUndefined();
  });

  it('should replace an existing table and allow unregistering it', () => {
    registerServerStrings('de', { 'a.b': 'alt' });
    registerServerStrings('de', { 'a.b': 'neu' });
    expect(getServerString('de', 'a.b')).toBe('neu');
    unregisterServerStrings('de');
    expect(getServerString('de', 'a.b')).toBeUndefined();
    expect(registeredServerLangs()).toEqual([]);
  });
});

describe('pick', () => {
  it('should return the Chinese copy for zh', () => {
    expect(pick('zh', '剩余 3 项', '3 left', 'k.items.left')).toBe('剩余 3 项');
  });

  it('should prefer a translator table for other languages', () => {
    registerServerStrings('ja', { 'k.items.left': '残り{n}件' });
    expect(pick('ja', '剩余 3 项', '3 left', 'k.items.left', { n: 3 })).toBe('残り3件');
  });

  it('should fall back to English when the key is absent', () => {
    expect(pick('ja', '剩余 3 项', '3 left', 'k.missing')).toBe('3 left');
    expect(pick('en', '剩余 3 项', '3 left')).toBe('3 left');
  });

  it('should not treat an empty table value as a hit', () => {
    registerServerStrings('ko', { 'a.b': '' });
    expect(pick('ko', '中', 'en', 'a.b')).toBe('en');
  });
});

describe('formatTable', () => {
  it('should fill {name} slots', () => {
    expect(formatTable('{a} + {b}', { a: 1, b: 'x' })).toBe('1 + x');
  });

  it('should leave unknown slots literal', () => {
    expect(formatTable('{a} {b}', { a: 1 })).toBe('1 {b}');
  });

  it('should render null/undefined/object values as empty', () => {
    expect(formatTable('[{a}][{b}][{c}]', { a: null, b: undefined, c: { x: 1 } })).toBe('[][][]');
  });

  it('should return the template unchanged without vars', () => {
    expect(formatTable('plain {a}')).toBe('plain {a}');
  });
});

describe('getServerBlock', () => {
  it('should return the Chinese lines for zh', () => {
    expect(getServerBlock('zh', 'k.block', ['中1', '中2'], ['en1'])).toEqual(['中1', '中2']);
  });

  it('should split a table value on newlines', () => {
    registerServerStrings('ja', { 'k.block': '行1\n行2' });
    expect(getServerBlock('ja', 'k.block', ['中'], ['en'])).toEqual(['行1', '行2']);
  });

  it('should fall back to English lines when the key is missing', () => {
    expect(getServerBlock('ja', 'k.block', ['中'], ['en1', 'en2'])).toEqual(['en1', 'en2']);
  });
});

describe('bilingual', () => {
  it('should join English first then Chinese', () => {
    expect(bilingual('Hello', '你好')).toBe('Hello\n你好');
  });

  it('should collapse when one side is empty or identical', () => {
    expect(bilingual('', '你好')).toBe('你好');
    expect(bilingual('Hello', '')).toBe('Hello');
    expect(bilingual('Same', 'Same')).toBe('Same');
  });
});

describe('extractServerStrings', () => {
  it('should extract a table from a pack file', () => {
    expect(extractServerStrings({ code: 'ja', serverStrings: { 'a.b': 'v', 'c.d': '' } })).toEqual({
      code: 'ja',
      table: { 'a.b': 'v' },
    });
  });

  it('should return null for unusable packs', () => {
    expect(extractServerStrings(null)).toBeNull();
    expect(extractServerStrings('x')).toBeNull();
    expect(extractServerStrings({})).toBeNull();
    expect(extractServerStrings({ code: '' })).toBeNull();
    expect(extractServerStrings({ code: 'ja' })).toBeNull();
    expect(extractServerStrings({ code: 'ja', serverStrings: {} })).toBeNull();
    expect(extractServerStrings({ code: 'ja', serverStrings: { 'a.b': 1 } })).toBeNull();
  });
});

/**
 * json-utils.ts 单元测试
 *
 * 覆盖 JSONC 剥离的两类注释、字符串字面量保护（URL 里的 //、转义引号、
 * 块注释片段）以及解析失败语义。纯函数，无 IO。
 */
import { describe, it, expect } from 'vitest';
import { stripJsonComments, parseJsonWithComments } from '../src/model-admin/json-utils';

describe('stripJsonComments', () => {
  it('should remove a trailing line comment', () => {
    expect(stripJsonComments('{"a":1} // note')).toBe('{"a":1} ');
  });

  it('should remove a whole-line line comment while keeping the newline', () => {
    expect(stripJsonComments('// head\n{"a":1}')).toBe('\n{"a":1}');
  });

  it('should remove a block comment on one line', () => {
    expect(stripJsonComments('{"a":1} /* note */')).toBe('{"a":1} ');
  });

  it('should remove a multi-line block comment', () => {
    expect(stripJsonComments('{\n/* a\nb */\n"x":2\n}')).toBe('{\n\n"x":2\n}');
  });

  it('should keep // inside a string literal (URL values)', () => {
    expect(stripJsonComments('{"url":"https://example.com/a"}')).toBe(
      '{"url":"https://example.com/a"}',
    );
  });

  it('should keep /* inside a string literal', () => {
    expect(stripJsonComments('{"glob":"src/*/x"}')).toBe('{"glob":"src/*/x"}');
  });

  it('should keep an escaped quote inside a string literal', () => {
    expect(stripJsonComments('{"a":"say \\"hi\\" // not comment"}')).toBe(
      '{"a":"say \\"hi\\" // not comment"}',
    );
  });

  it('should keep a backslash as the last character of a string', () => {
    // 末尾反斜杠让扫描器 i += 2 越过字符串边界，行为固定为「原样输出」
    expect(stripJsonComments('{"a":"x\\\\"}')).toBe('{"a":"x\\\\"}');
  });

  it('should drop the remainder after an unterminated block comment', () => {
    expect(stripJsonComments('{"a":1} /* never closed')).toBe('{"a":1} ');
  });

  it('should return an empty string unchanged', () => {
    expect(stripJsonComments('')).toBe('');
  });
});

describe('parseJsonWithComments', () => {
  it('should parse JSONC with both comment styles', () => {
    const src = `{
      // provider list
      "providers": ["anthropic"], /* inline */
      "baseUrl": "https://example.com"
    }`;
    expect(parseJsonWithComments(src)).toEqual({
      providers: ['anthropic'],
      baseUrl: 'https://example.com',
    });
  });

  it('should throw for invalid JSON after comment stripping', () => {
    expect(() => parseJsonWithComments('{ "a": }')).toThrow();
  });

  it('should support a generic type argument', () => {
    const parsed = parseJsonWithComments<{ n: number }>('{"n":42}');
    expect(parsed.n).toBe(42);
  });
});

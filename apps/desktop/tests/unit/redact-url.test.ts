/**
 * redactUrlToken 单元测试（§7.3 日志脱敏内核）
 *
 * 覆盖：打码、无 token 原样返回（快路径不重编码）、非 URL 文本原样返回、
 * 多个同名参数折叠为单个打码值且不损伤其它参数、token= 空值同样打码。
 * 断言含 43 位 base64url token 的真实泄漏形态（dsh / pi-web 均此形状）。
 */
import { describe, it, expect } from 'vitest';
import { redactUrlToken } from '../../src/shared/redact-url';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';

describe('redactUrlToken', () => {
  it('should replace the token query param with ***', () => {
    expect(redactUrlToken(`http://127.0.0.1:47001/?token=${TOKEN}`)).toBe(
      'http://127.0.0.1:47001/?token=***',
    );
  });

  it('should return URLs without a token param unchanged', () => {
    const plain = 'http://127.0.0.1:47001/app/sessions?id=42';
    expect(redactUrlToken(plain)).toBe(plain);
  });

  it('should return non-URL text unchanged instead of throwing', () => {
    expect(redactUrlToken('not a url with token=inside')).toBe('not a url with token=inside');
  });

  it('should keep other params and collapse duplicate token params', () => {
    // set() 折叠同名参数：两个 token= 变成一个 ***；其它参数原样保留
    expect(redactUrlToken(`http://127.0.0.1:47001/?a=1&token=${TOKEN}&b=2&token=${TOKEN}`)).toBe(
      'http://127.0.0.1:47001/?a=1&token=***&b=2',
    );
  });

  it('should redact an empty token param too', () => {
    expect(redactUrlToken('http://127.0.0.1:47001/?token=')).toBe(
      'http://127.0.0.1:47001/?token=***',
    );
  });

  it('should not be fooled by keys merely containing "token"', () => {
    // `?notoken=1` 含 'token=' 子串但无 token 参数 → 必须原样返回
    const tricky = 'http://127.0.0.1:47001/?notoken=1';
    expect(redactUrlToken(tricky)).toBe(tricky);
  });

  it('should treat a token encoded inside another param value as a plain value', () => {
    // 语义边界（如实记录）：本工具针对**直接的 token 查询参数**——`next=` 的值里
    // URL 编码嵌套的 token 不属于 token 参数，不拆解码嵌套值。当前三处泄漏点的
    // 真实形态均为直接 `?token=` 参数，此边界不影响修复面。
    const nested = `https://example.com/r?next=http%3A%2F%2F127.0.0.1%3A47001%2F%3Ftoken%3D${TOKEN}`;
    expect(redactUrlToken(nested)).toBe(nested);
  });
});

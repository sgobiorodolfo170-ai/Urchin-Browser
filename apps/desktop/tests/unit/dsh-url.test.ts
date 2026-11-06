/**
 * sameServiceOrigin 单元测试（§7.1 修复的匹配内核）
 *
 * 覆盖三类判定面：
 * - 正例：token URL ↔ 干净 URL（303 重定向后的真实情形）、query/路径差异
 * - 反例：端口不同（= 不同本地服务）、host 不同、非 http 值
 * - 防御：非法 URL（new URL 抛出）不抛异常、返回 false
 */
import { describe, it, expect } from 'vitest';
import { sameServiceOrigin } from '../../src/shared/dsh-url';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';

describe('sameServiceOrigin', () => {
  it('should match the token URL with its post-redirect clean URL', () => {
    // 303 重定向前后的两种 tab.url 形态，origin 相同即同一服务
    expect(
      sameServiceOrigin(`http://127.0.0.1:47001/?token=${TOKEN}`, 'http://127.0.0.1:47001/'),
    ).toBe(true);
  });

  it('should ignore path and query differences for the same origin', () => {
    expect(sameServiceOrigin('http://127.0.0.1:47001/api/foo', 'http://127.0.0.1:47001/')).toBe(
      true,
    );
  });

  it('should distinguish different ports as different local services', () => {
    expect(sameServiceOrigin('http://127.0.0.1:47001/', 'http://127.0.0.1:47002/')).toBe(false);
  });

  it('should distinguish different hosts', () => {
    expect(sameServiceOrigin('http://localhost:47001/', 'http://127.0.0.1:47001/')).toBe(false);
  });

  it('should return false for invalid URLs without throwing', () => {
    expect(sameServiceOrigin('not a url', 'http://127.0.0.1:47001/')).toBe(false);
    expect(sameServiceOrigin('', '')).toBe(false);
  });

  it('should match itself', () => {
    expect(
      sameServiceOrigin(
        `http://127.0.0.1:47001/?token=${TOKEN}`,
        `http://127.0.0.1:47001/?token=${TOKEN}`,
      ),
    ).toBe(true);
  });
});

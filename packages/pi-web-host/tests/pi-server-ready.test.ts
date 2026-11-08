/**
 * pi-server-ready.ts 单元测试
 *
 * 覆盖 pi-server 集成入口的就绪行契约（前缀 / 跨 chunk 终止符正则）与
 * 访问 URL 拼装（通配 host 归一化 + token 有无）。
 *
 * 为何重点测「无终止符不匹配」：父进程按 chunk 累积 stdout，若正则用 `$`
 * 锚定行尾，半个 URL（token 尚未收完）就会被误判为就绪，父进程随即拼出
 * 错误 URL 打开页面。终止符（空白 / ANSI）是唯一的「收完了」证据。
 */
import { describe, expect, it } from 'vitest';
import {
  PI_SERVER_READY_PREFIX,
  PI_SERVER_READY_LINE_RE,
  buildPiServerUrl,
} from '../src/pi-server-ready';

describe('PI_SERVER_READY_PREFIX', () => {
  it('should be the fixed prefix written to utilityProcess stdout', () => {
    expect(PI_SERVER_READY_PREFIX).toBe('pi-server ready: ');
  });
});

describe('PI_SERVER_READY_LINE_RE', () => {
  it('should parse a full ready line terminated by a newline', () => {
    const line = `${PI_SERVER_READY_PREFIX}http://127.0.0.1:41234/?token=abc123_XYZ-\n`;
    const m = PI_SERVER_READY_LINE_RE.exec(line);
    expect(m?.[1]).toBe('http://127.0.0.1:41234/?token=abc123_XYZ-');
  });

  it('should parse a ready line without token', () => {
    const line = `${PI_SERVER_READY_PREFIX}http://127.0.0.1:41234/ `;
    const m = PI_SERVER_READY_LINE_RE.exec(line);
    expect(m?.[1]).toBe('http://127.0.0.1:41234/');
  });

  it('should accept a space and a bare carriage return as terminators', () => {
    const withSpace = PI_SERVER_READY_LINE_RE.exec(
      `${PI_SERVER_READY_PREFIX}http://127.0.0.1:1234/?token=tok `,
    );
    expect(withSpace?.[1]).toBe('http://127.0.0.1:1234/?token=tok');

    const withCr = PI_SERVER_READY_LINE_RE.exec(
      `${PI_SERVER_READY_PREFIX}http://127.0.0.1:1234/?token=tok\r`,
    );
    expect(withCr?.[1]).toBe('http://127.0.0.1:1234/?token=tok');
  });

  it('should match with an ANSI terminator when the chunk ends right after the token', () => {
    // 子进程写 stderr/stdout 时可能附带颜色重置序列，作为 chunk 边界标志
    const m = PI_SERVER_READY_LINE_RE.exec(
      `${PI_SERVER_READY_PREFIX}http://127.0.0.1:1/?token=ab\x1b[0m`,
    );
    expect(m?.[1]).toBe('http://127.0.0.1:1/?token=ab');
  });

  it('should NOT accept a truncated URL with no terminator yet', () => {
    // token 未收完（缓冲末尾），不允许 `$` 终止——防止截断误判
    const truncated = `${PI_SERVER_READY_PREFIX}http://127.0.0.1:1/?token=abc`;
    expect(PI_SERVER_READY_LINE_RE.exec(truncated)).toBeNull();
  });

  it('should only match once the terminator arrives in a later chunk', () => {
    // 模拟 launcher 的增量缓冲：chunk1 无终止符不匹配，拼上 chunk2 后才就绪
    let buffer = `${PI_SERVER_READY_PREFIX}http://127.0.0.1:1/?token=abc`;
    expect(PI_SERVER_READY_LINE_RE.exec(buffer)).toBeNull();

    buffer += 'd\r\n';
    const m = PI_SERVER_READY_LINE_RE.exec(buffer);
    expect(m?.[1]).toBe('http://127.0.0.1:1/?token=abcd');
  });

  it('should NOT match the prefix alone or a non-http payload', () => {
    expect(PI_SERVER_READY_LINE_RE.exec(PI_SERVER_READY_PREFIX)).toBeNull();
    expect(PI_SERVER_READY_LINE_RE.exec(`${PI_SERVER_READY_PREFIX}ws://127.0.0.1:1/ `)).toBeNull();
    expect(PI_SERVER_READY_LINE_RE.exec('pi-server ready: \n')).toBeNull();
  });

  it('should find the ready line inside surrounding log noise', () => {
    const output = [
      'booting pi-server...',
      `${PI_SERVER_READY_PREFIX}http://127.0.0.1:4321/?token=xyz`,
      'listening',
    ].join('\n');
    const m = PI_SERVER_READY_LINE_RE.exec(output);
    expect(m?.[1]).toBe('http://127.0.0.1:4321/?token=xyz');
  });
});

describe('buildPiServerUrl', () => {
  it('should normalize 0.0.0.0 to 127.0.0.1', () => {
    expect(buildPiServerUrl(8081, '0.0.0.0', 'abc')).toBe('http://127.0.0.1:8081/?token=abc');
  });

  it('should normalize :: to 127.0.0.1', () => {
    expect(buildPiServerUrl(8081, '::', 'abc')).toBe('http://127.0.0.1:8081/?token=abc');
  });

  it('should keep an explicit loopback host', () => {
    expect(buildPiServerUrl(9000, '127.0.0.1', 'tok')).toBe('http://127.0.0.1:9000/?token=tok');
  });

  it('should keep a non-wildcard host such as localhost', () => {
    expect(buildPiServerUrl(9000, 'localhost', 'tok')).toBe('http://localhost:9000/?token=tok');
  });

  it('should omit the token query when token is empty', () => {
    expect(buildPiServerUrl(41234, '0.0.0.0', '')).toBe('http://127.0.0.1:41234/');
  });

  it('should percent-encode tokens with reserved characters', () => {
    expect(buildPiServerUrl(41234, '::', 'a b&c=d')).toBe(
      'http://127.0.0.1:41234/?token=a%20b%26c%3Dd',
    );
  });

  it('should keep base64url tokens untouched', () => {
    const token = 'abc123_XYZ-';
    expect(buildPiServerUrl(1, '0.0.0.0', token)).toBe(`http://127.0.0.1:1/?token=${token}`);
  });
});

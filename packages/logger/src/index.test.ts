import { afterEach, describe, expect, it } from 'vitest';
import { addLogSink, createLogger, type LogEntry } from './index';

/**
 * dev.193 整改 R6：日志脱敏回归。
 *
 * 事故背景：sanitizeMeta 原先只按「字段名」判断凭据，字符串值原样落盘，
 * 导致 bookmark.search 的 query（第三方站点 access_token / refresh_token JWT）、
 * tab-manager 与 view-integration 的 url（dsh ?token=）明文写入日志。
 */
const entries: LogEntry[] = [];
let dispose: (() => void) | undefined;

function capture() {
  entries.length = 0;
  dispose?.();
  dispose = addLogSink((entry) => entries.push(entry));
  return createLogger('logger-test');
}

/** 取首条日志；严格模式下数组索引是 possibly undefined，统一在此收窄。 */
function first(): LogEntry {
  const entry: LogEntry | undefined = entries[0];
  if (!entry) throw new Error('未捕获到日志条目（LogSink 未触发？）');
  return entry;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  entries.length = 0;
});

describe('日志脱敏 · URL query 凭据', () => {
  it('脱敏 query 中的 access_token / refresh_token JWT，保留其他参数', () => {
    const log = capture();
    log.info('bookmark.search', {
      query:
        'https://platform.agentscope.io/?access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMWEifQ.ti4ZhuEjI-M0NNlKpa1it0&expires_in=7200&refresh_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMWEifQ.abcXYZ123',
      limit: 50,
    });
    const query = String(first().meta?.query);
    expect(query).not.toContain('eyJ');
    expect(query).toContain('access_token=***REDACTED***');
    expect(query).toContain('refresh_token=***REDACTED***');
    expect(query).toContain('expires_in=7200');
    expect(first().meta?.limit).toBe(50);
  });

  it('脱敏 dsh 本地认证 URL 的 token', () => {
    const log = capture();
    log.warn('computed bounds are zero or negative', {
      tabId: 13,
      url: 'http://127.0.0.1:54210/?token=sFnp58SG6eCwuBAEQBp57SDk6Q9Syq4m3B4QQr6sP-Y',
      bounds: { x: 52, y: 40, width: 0, height: 0 },
    });
    expect(String(first().meta?.url)).toContain('token=***REDACTED***');
    expect(String(first().meta?.url)).not.toContain('sFnp58');
  });

  it('字段名命中 token/key/secret 时整体置红', () => {
    const log = capture();
    log.info('dsh web ready', { port: 59553, token: 'plain-secret-value', apiKey: 'abc' });
    expect(first().meta?.token).toBe('***REDACTED***');
    expect(first().meta?.apiKey).toBe('***REDACTED***');
    expect(first().meta?.port).toBe(59553);
  });

  it('递归处理嵌套对象与数组中的字符串', () => {
    const log = capture();
    log.info('nested', {
      items: ['http://x.example/?token=abc123def', 'plain text'],
      nested: { url: 'http://y.example/?code=xyz789' },
    });
    const meta = first().meta!;
    const items = meta.items as string[];
    expect(items[0]).toContain('token=***REDACTED***');
    expect(items[0]).not.toContain('abc123def');
    expect(items[1]).toBe('plain text');
    expect(String((meta.nested as Record<string, unknown>).url)).not.toContain('xyz789');
  });

  it('message 本身也走同一套脱敏', () => {
    const log = capture();
    log.info('GET http://x.example/?token=abcdefghijk');
    expect(first().message).toContain('token=***REDACTED***');
    expect(first().message).not.toContain('abcdefghijk');
  });

  it('兼容既有的 sk- / Bearer / api_key 脱敏', () => {
    const log = capture();
    log.info('sk-0123456789abcdefghij Bearer abc.def-ghi api_key="1234567890"');
    expect(first().message).not.toContain('sk-0123456789');
    expect(first().message).not.toContain('Bearer abc.def-ghi');
    expect(first().message).toContain('***REDACTED***');
  });

  it('普通 URL 与非凭据参数不受影响', () => {
    const log = capture();
    log.info('page load timing', { url: 'https://example.com/article?tab=1&page=2', cost: 54 });
    expect(first().meta?.url).toBe('https://example.com/article?tab=1&page=2');
    expect(first().meta?.cost).toBe(54);
  });
});

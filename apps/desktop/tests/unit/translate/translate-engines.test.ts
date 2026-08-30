/**
 * M24 网页翻译 · 双引擎单元测试（注入 mock transport，不发起真实网络请求）
 *
 * 覆盖：请求构造（鉴权/语言映射/批量形态）、响应解析（对齐/检测语言）、
 * 401 重握手、429 限流错误（交 failover）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createMicrosoftEngine } from '../../../src/main/translate/engines/microsoft';
import { createGoogleEngine } from '../../../src/main/translate/engines/google';
import { EngineError, type HttpTransport } from '../../../src/main/translate/engines/types';

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

/** 录制型 transport：按 url 分流（auth / translate），响应由 handler 编程 */
function createRecordingTransport(
  handler: (call: RecordedCall) => { status: number; text: string },
): { transport: HttpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = (url, init) => {
    const call: RecordedCall = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { transport, calls };
}

function fixedTransport(status: number, text: string): HttpTransport {
  return () => Promise.resolve({ status, text });
}

describe('createMicrosoftEngine', () => {
  it('should handshake for token then translate with bearer auth and JSON array body', async () => {
    const { transport, calls } = createRecordingTransport((call) => {
      if (call.url.includes('/auth')) return { status: 200, text: 'JWT.TOKEN' };
      return {
        status: 200,
        text: JSON.stringify([
          { detectedLanguage: { language: 'en' }, translations: [{ text: '你好', to: 'zh-Hans' }] },
          { translations: [{ text: '世界', to: 'zh-Hans' }] },
        ]),
      };
    });
    const engine = createMicrosoftEngine({ transport });

    const res = await engine.translateBatch(['Hello', 'World'], { to: 'zh-CN' });

    expect(res).toEqual({ texts: ['你好', '世界'], detectedLang: 'en' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('edge.microsoft.com/translate/auth');
    expect(calls[1]!.url).toContain('api-version=3.0');
    expect(calls[1]!.url).toContain('to=zh-Hans');
    expect(calls[1]!.init?.headers?.Authorization).toBe('Bearer JWT.TOKEN');
    expect(JSON.parse(calls[1]!.init?.body ?? '[]')).toEqual([
      { Text: 'Hello' },
      { Text: 'World' },
    ]);
  });

  it('should reuse cached token across batches (no repeated handshake)', async () => {
    const { transport, calls } = createRecordingTransport((call) => {
      if (call.url.includes('/auth')) return { status: 200, text: 'JWT.TOKEN' };
      return { status: 200, text: JSON.stringify([{ translations: [{ text: 'x' }] }]) };
    });
    const engine = createMicrosoftEngine({ transport });

    await engine.translateBatch(['a'], { to: 'en' });
    await engine.translateBatch(['b'], { to: 'en' });

    expect(calls.filter((c) => c.url.includes('/auth'))).toHaveLength(1);
  });

  it('should re-handshake once on 401 and retry the batch', async () => {
    let translateCalls = 0;
    const { transport, calls } = createRecordingTransport((call) => {
      if (call.url.includes('/auth')) return { status: 200, text: `JWT.${calls.length}` };
      translateCalls += 1;
      if (translateCalls === 1) return { status: 401, text: '' };
      return { status: 200, text: JSON.stringify([{ translations: [{ text: '好' }] }]) };
    });
    const engine = createMicrosoftEngine({ transport });

    const res = await engine.translateBatch(['Hello'], { to: 'zh-CN' });

    expect(res.texts).toEqual(['好']);
    expect(calls.filter((c) => c.url.includes('/auth'))).toHaveLength(2);
  });

  it('should throw rate_limited EngineError on 429 (failover signal)', async () => {
    const { transport } = createRecordingTransport((call) => {
      if (call.url.includes('/auth')) return { status: 200, text: 'JWT.TOKEN' };
      return { status: 429, text: '' };
    });
    const engine = createMicrosoftEngine({ transport });

    await expect(engine.translateBatch(['Hello'], { to: 'zh-CN' })).rejects.toMatchObject({
      name: 'EngineError',
      engine: 'microsoft',
      code: 'rate_limited',
    });
  });

  it('should map zh-TW to zh-Hant in the query', async () => {
    const { transport, calls } = createRecordingTransport((call) => {
      if (call.url.includes('/auth')) return { status: 200, text: 'JWT.TOKEN' };
      return { status: 200, text: JSON.stringify([{ translations: [{ text: 'x' }] }]) };
    });
    const engine = createMicrosoftEngine({ transport });

    await engine.translateBatch(['Hello'], { to: 'zh-TW' });

    expect(calls[1]!.url).toContain('to=zh-Hant');
  });
});

describe('createGoogleEngine', () => {
  it('should POST batched q params to the dict-chrome-ex endpoint', async () => {
    const calls: RecordedCall[] = [];
    const transport: HttpTransport = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status: 200, text: JSON.stringify(['你好', '世界']) });
    };
    const engine = createGoogleEngine({ transport });

    const res = await engine.translateBatch(['Hello', 'World'], { to: 'zh-CN' });

    expect(res.texts).toEqual(['你好', '世界']);
    expect(calls[0]!.url).toContain('translate.googleapis.com/translate_a/t');
    expect(calls[0]!.url).toContain('client=dict-chrome-ex');
    expect(calls[0]!.url).toContain('sl=auto');
    expect(calls[0]!.url).toContain('tl=zh-CN');
    const q = new URLSearchParams(calls[0]!.init?.body).getAll('q');
    expect(q).toEqual(['Hello', 'World']);
  });

  it('should normalize [translation, detectedLang] array elements', async () => {
    const engine = createGoogleEngine({
      transport: fixedTransport(
        200,
        JSON.stringify([
          ['你好', 'en'],
          ['世界', 'en'],
        ]),
      ),
    });

    const res = await engine.translateBatch(['Hello', 'World'], { to: 'zh-CN' });

    expect(res.texts).toEqual(['你好', '世界']);
    expect(res.detectedLang).toBe('en');
  });

  it('should pad missing entries with empty strings instead of throwing', async () => {
    const engine = createGoogleEngine({ transport: fixedTransport(200, JSON.stringify(['你好'])) });

    const res = await engine.translateBatch(['Hello', 'World'], { to: 'zh-CN' });

    expect(res.texts).toEqual(['你好', '']);
  });

  it('should throw rate_limited EngineError on 429', async () => {
    const engine = createGoogleEngine({ transport: fixedTransport(429, '') });

    await expect(engine.translateBatch(['Hello'], { to: 'zh-CN' })).rejects.toBeInstanceOf(
      EngineError,
    );
  });

  it('should throw bad_response on non-JSON body', async () => {
    const engine = createGoogleEngine({ transport: fixedTransport(200, '<html>blocked</html>') });

    await expect(engine.translateBatch(['Hello'], { to: 'zh-CN' })).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('engine contract', () => {
  it('should expose stable engine ids', () => {
    const ms = createMicrosoftEngine({
      transport: vi.fn().mockResolvedValue({ status: 200, text: 't' }),
    });
    const gg = createGoogleEngine({
      transport: vi.fn().mockResolvedValue({ status: 200, text: '[]' }),
    });
    expect(ms.id).toBe('microsoft');
    expect(gg.id).toBe('google');
  });
});

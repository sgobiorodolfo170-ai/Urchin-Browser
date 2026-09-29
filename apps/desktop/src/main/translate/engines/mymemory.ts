/**
 * M24 网页翻译 · MyMemory 免费翻译引擎（国内直连可用，替代已失效的微软 Edge 端点）
 *
 * 背景（2026-09-27 生产事件）：微软 edge.microsoft.com/translate/auth 返回 404 空响应，
 * 端点已关闭；谷歌 translate.googleapis.com 国内直连不可达。双引擎在国内直连环境
 * 全部失效（用户经邮件翻译触发，M24 网页翻译同受影响）。
 *
 * 端点（2026-09-27 实测可用）：
 * GET {baseUrl}/get?q=<text>&langpair=<from|Autodetect>|<to>
 * —— 免鉴权、国内直连可达、JSON 响应：
 *   { responseData: { translatedText, match, detectedLanguage? }, quotaFinished, responseStatus }
 *   detectedLanguage 仅在 from=Autodetect 时返回。
 *
 * 性质与限制：
 * - 免费匿名配额约 5000 词/天（quotaFinished=true / responseStatus 429 视为限流，
 *   抛 EngineError('rate_limited') 交 failover）
 * - 无批量端点：translateBatch 按段循环请求（并发 2，段间隔 100ms 防触发限流）；
 *   大页面翻译慢于微软/谷歌批量端点，定位为「国内直连兜底引擎」
 * - 语言代码直接兼容 zh-CN/zh-TW/en（实测 2026-09-27）
 */
import {
  EngineError,
  type HttpTransport,
  type TranslateBatchResult,
  type TranslateEngine,
} from './types';

const DEFAULT_BASE_URL = 'https://api.mymemory.translated.net';

/** 段间请求间隔（防触发免费配额的风控） */
const SEGMENT_DELAY_MS = 100;

/** 段请求并发上限（免费接口保守值） */
const MAX_CONCURRENCY = 2;

export interface MyMemoryEngineOptions {
  readonly transport?: HttpTransport;
  readonly baseUrl?: string;
}

interface MyMemoryResponse {
  responseData?: {
    translatedText?: string;
    match?: number;
    detectedLanguage?: string;
  };
  quotaFinished?: boolean;
  responseStatus?: number;
  responseDetails?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMyMemoryEngine(opts: MyMemoryEngineOptions = {}): TranslateEngine {
  const transport = opts.transport;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

  async function translateOne(
    text: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; detectedLang?: string }> {
    if (!transport) {
      throw new EngineError('mymemory', 'network', 'http transport is not configured');
    }
    const query = new URLSearchParams({ q: text, langpair: `${from}|${to}` });
    let res: { status: number; text: string };
    try {
      res = await transport(`${baseUrl}/get?${query.toString()}`, { method: 'GET', signal });
    } catch (err) {
      throw new EngineError(
        'mymemory',
        'network',
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 429) {
      throw new EngineError('mymemory', 'rate_limited', 'rate limited (429)');
    }
    if (res.status !== 200) {
      throw new EngineError(
        'mymemory',
        'bad_response',
        `translate failed with status ${res.status}`,
      );
    }

    let data: MyMemoryResponse;
    try {
      data = JSON.parse(res.text) as MyMemoryResponse;
    } catch {
      throw new EngineError('mymemory', 'bad_response', 'translate response is not valid JSON');
    }
    if (data.quotaFinished === true || data.responseStatus === 429) {
      throw new EngineError('mymemory', 'rate_limited', 'daily quota exhausted');
    }
    if (data.responseStatus !== undefined && data.responseStatus !== 200) {
      throw new EngineError(
        'mymemory',
        'bad_response',
        `translate failed with responseStatus ${data.responseStatus}`,
      );
    }
    return {
      text: data.responseData?.translatedText ?? '',
      detectedLang: data.responseData?.detectedLanguage,
    };
  }

  return {
    id: 'mymemory',
    async translateBatch(texts, opts): Promise<TranslateBatchResult> {
      const from = opts.from ?? 'Autodetect';
      const out: string[] = new Array<string>(texts.length).fill('');
      let detectedLang: string | undefined;

      // 并发 2 按段循环（无批量端点）
      for (let i = 0; i < texts.length; i += MAX_CONCURRENCY) {
        const batch = texts.slice(i, i + MAX_CONCURRENCY);
        const results = await Promise.all(
          batch.map((text, j) =>
            translateOne(text, from, opts.to, opts.signal).then((r) => ({ j, r })),
          ),
        );
        for (const { j, r } of results) {
          out[i + j] = r.text;
          detectedLang = detectedLang ?? r.detectedLang;
        }
        if (i + MAX_CONCURRENCY < texts.length) {
          await sleep(SEGMENT_DELAY_MS);
        }
      }
      return { texts: out, detectedLang };
    },
  };
}

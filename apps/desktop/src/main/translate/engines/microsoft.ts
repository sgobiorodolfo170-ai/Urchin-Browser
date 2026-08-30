/**
 * M24 网页翻译 · 微软 Edge 免费翻译引擎（默认引擎）
 *
 * 端点（2026-08-30 调研核实，docs/网页翻译功能规划.md §6.1）：
 * 1. GET {authUrl}——免 Key 换取 JWT（约 10 分钟有效），Edge 浏览器内置翻译同款
 * 2. POST {baseUrl}/translate?api-version=3.0&to=..[&from=..]——Bearer 头 +
 *    JSON 数组批量（[{Text:...}]），响应数组顺序与输入一致，带 detectedLanguage
 *
 * 性质：非官方接口（微软未提供文档/SLA）——社区与主流翻译扩展多年广泛使用，
 * 稳定性实践良好，但必须按「可能限流/变更」对待：401 重握手一次、
 * 429/5xx 抛 EngineError 交 TranslateManager failover（TD2 双引擎互为兜底）。
 *
 * 语言代码映射：微软用 zh-Hans/zh-Hant，本模块统一对外 zh-CN/zh-TW（TD 契约），
 * 引擎内转换，管理器与引擎接口不感知差异。
 */
import {
  EngineError,
  type HttpTransport,
  type TranslateBatchResult,
  type TranslateEngine,
} from './types';

const DEFAULT_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const DEFAULT_BASE_URL = 'https://api-edge.cognitive.microsofttranslator.com';

/** token 视为过期的提前量：JWT 实际 ~10min，按 9min 主动刷新，避免边界请求踩 401 */
const TOKEN_TTL_MS = 9 * 60 * 1000;

export interface MicrosoftEngineOptions {
  /** HTTP 传输（生产由装配方注入 net.fetch 适配；单测注入 mock） */
  readonly transport?: HttpTransport;
  readonly authUrl?: string;
  readonly baseUrl?: string;
  readonly now?: () => number;
}

/** 本项目语言代码 → 微软代码（zh 系唯一有差异） */
function toMicrosoftLang(lang: string): string {
  if (lang === 'zh-CN') return 'zh-Hans';
  if (lang === 'zh-TW') return 'zh-Hant';
  return lang;
}

interface MicrosoftTranslationItem {
  translations?: { text?: string }[];
  detectedLanguage?: { language?: string };
}

export function createMicrosoftEngine(opts: MicrosoftEngineOptions = {}): TranslateEngine {
  const transport = opts.transport;
  const authUrl = opts.authUrl ?? DEFAULT_AUTH_URL;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = opts.now ?? Date.now;

  let cachedToken: string | null = null;
  let tokenExpiresAt = 0;

  async function fetchToken(): Promise<string> {
    if (!transport) {
      throw new EngineError('microsoft', 'auth', 'http transport is not configured');
    }
    const res = await transport(authUrl, { method: 'GET' });
    if (res.status !== 200 || !res.text) {
      throw new EngineError('microsoft', 'auth', `auth handshake failed with status ${res.status}`);
    }
    cachedToken = res.text;
    tokenExpiresAt = now() + TOKEN_TTL_MS;
    return cachedToken;
  }

  /** token 命中缓存直接返回；过期/缺失重新握手 */
  function ensureToken(): Promise<string> {
    if (cachedToken && now() < tokenExpiresAt) return Promise.resolve(cachedToken);
    return fetchToken();
  }

  async function requestTranslate(
    token: string,
    to: string,
    from: string | undefined,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    if (!transport) {
      throw new EngineError('microsoft', 'network', 'http transport is not configured');
    }
    const query = new URLSearchParams({ 'api-version': '3.0', to });
    if (from) query.set('from', from);
    return transport(`${baseUrl}/translate?${query.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(texts.map((t) => ({ Text: t }))),
      signal,
    });
  }

  return {
    id: 'microsoft',
    async translateBatch(texts, opts): Promise<TranslateBatchResult> {
      const to = toMicrosoftLang(opts.to);
      const from = opts.from ? toMicrosoftLang(opts.from) : undefined;

      let token = await ensureToken();
      let res = await requestTranslate(token, to, from, texts, opts.signal);
      // token 提前失效（微软侧回收/时钟偏移）：强制重握手一次再试，仍失败按原始状态处理
      if (res.status === 401) {
        cachedToken = null;
        token = await fetchToken();
        res = await requestTranslate(token, to, from, texts, opts.signal);
      }
      if (res.status === 429) {
        throw new EngineError('microsoft', 'rate_limited', `rate limited (429)`);
      }
      if (res.status !== 200) {
        throw new EngineError(
          'microsoft',
          'bad_response',
          `translate failed with status ${res.status}`,
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new EngineError('microsoft', 'bad_response', 'translate response is not valid JSON');
      }
      if (!Array.isArray(data)) {
        throw new EngineError('microsoft', 'bad_response', 'translate response is not an array');
      }

      const items = data as MicrosoftTranslationItem[];
      const out: string[] = [];
      for (const item of texts) {
        void item;
        const entry = items[out.length];
        out.push(entry?.translations?.[0]?.text ?? '');
      }
      const detectedLang = items[0]?.detectedLanguage?.language;
      return { texts: out, detectedLang: detectedLang ?? undefined };
    },
  };
}

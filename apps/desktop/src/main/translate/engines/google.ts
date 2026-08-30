/**
 * M24 网页翻译 · 谷歌 GTX 免费翻译引擎（备用引擎：国际/代理环境优先）
 *
 * 端点（2026-08-30 调研核实，docs/网页翻译功能规划.md §6.1）：
 * POST {baseUrl}/translate_a/t?client=dict-chrome-ex&sl=auto&tl=..
 * —— Chrome 内置翻译使用的批量形态：表单 body 携带重复 q= 参数（每段一个），
 * 响应为与输入顺序对应的译文数组。相比 translate_a/single（GET、URL 长度受限、
 * 响应为句段嵌套），/t 端点天然支持多段对齐，适配整页分批。
 *
 * 性质：非官方接口（无文档配额，高频按 IP 出 429；2022 年曾有区域性封锁先例，
 * 国内直连不可达）——故 v1 定位为「代理环境优先 + 微软兜底」（评审第二轮决策），
 * 429/网络失败抛 EngineError 交 TranslateManager failover。
 *
 * 响应元素形态容错：实测可能是 "译文" 或 ["译文","检测语言"]（sl=auto 时），
 * 归一化函数递归取首个字符串，保证两种形态都能拿到对齐译文。
 */
import {
  EngineError,
  type HttpTransport,
  type TranslateBatchResult,
  type TranslateEngine,
} from './types';

const DEFAULT_BASE_URL = 'https://translate.googleapis.com';

export interface GoogleEngineOptions {
  readonly transport?: HttpTransport;
  readonly baseUrl?: string;
}

/**
 * 谷歌语言代码：zh-CN/zh-TW 直接可用，无需映射。
 * 保留函数形态与微软引擎对称，后续引擎差异（如 others）集中于此。
 */
function toGoogleLang(lang: string): string {
  return lang;
}

/** 从响应元素中递归取首个字符串（string 直取；数组深入首元素） */
function firstStringOf(item: unknown): string {
  if (typeof item === 'string') return item;
  if (Array.isArray(item)) {
    for (const el of item) {
      const s = firstStringOf(el);
      if (s) return s;
    }
  }
  return '';
}

/** 形如语言代码（^xx 或 xx-XX）的字符串才认定为检测语言，避免把译文误当语言码 */
function looksLikeLangCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value);
}

export function createGoogleEngine(opts: GoogleEngineOptions = {}): TranslateEngine {
  const transport = opts.transport;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

  return {
    id: 'google',
    async translateBatch(texts, opts): Promise<TranslateBatchResult> {
      if (!transport) {
        throw new EngineError('google', 'network', 'http transport is not configured');
      }
      const query = new URLSearchParams({
        client: 'dict-chrome-ex',
        sl: opts.from ? toGoogleLang(opts.from) : 'auto',
        tl: toGoogleLang(opts.to),
      });
      // 表单重复 q 参数：q=段1&q=段2...，响应数组顺序与输入一致
      const body = new URLSearchParams();
      for (const t of texts) body.append('q', t);

      let res: { status: number; text: string };
      try {
        res = await transport(`${baseUrl}/translate_a/t?${query.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: body.toString(),
          signal: opts.signal,
        });
      } catch (err) {
        throw new EngineError(
          'google',
          'network',
          `request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (res.status === 429) {
        throw new EngineError('google', 'rate_limited', 'rate limited (429)');
      }
      if (res.status !== 200) {
        throw new EngineError(
          'google',
          'bad_response',
          `translate failed with status ${res.status}`,
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new EngineError('google', 'bad_response', 'translate response is not valid JSON');
      }
      if (!Array.isArray(data)) {
        throw new EngineError('google', 'bad_response', 'translate response is not an array');
      }

      const out = texts.map((_, i) => firstStringOf((data as unknown[])[i]));
      // 检测语言：首元素为 [译文, 语言码] 形态时取第二位
      const first: unknown = (data as unknown[])[0];
      let detectedLang: string | undefined;
      if (Array.isArray(first) && looksLikeLangCode(first[1])) {
        detectedLang = first[1];
      }
      return { texts: out, detectedLang };
    },
  };
}

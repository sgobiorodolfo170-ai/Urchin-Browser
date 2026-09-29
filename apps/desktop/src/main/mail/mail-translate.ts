/**
 * M25 邮箱模块 · 邮件翻译编排（主进程）
 *
 * 依据：用户决策「翻译按钮复用浏览器翻译引擎；中英互译自动判定；iframe 内替换显示」（2026-09-26）
 * 职责：
 * 1. containsCjk：中英启发式判定（含 CJK → 译 en，否则 → 译 zh-CN）
 * 2. splitHtmlSegments：HTML 分词器——按标签切分，仅提取文本节点（跳过 <style> 块），
 *    标签原样保留，译文回填后版式不变（对齐 QQ 邮箱「翻译此邮件」效果）
 * 3. translateMailBody：编排——分段（≤4000 字符/批，复用 TRANSLATE_BATCH_MAX_CHARS）
 *    → translateTexts（TranslateManager 双引擎 failover）→ 回填
 *
 * 隐私（§六）：原文/译文不出主进程日志；本模块不记正文内容。
 */

/** 引擎批量字符上限（与 translate/engines/types.ts TRANSLATE_BATCH_MAX_CHARS 对齐） */
const BATCH_MAX_CHARS = 4000;

/** 单封邮件最多翻译段数（超出截断不译，防超大邮件失控） */
const MAX_SEGMENTS = 50;

/** translateTexts 的最小依赖签名（与 TranslateManager.translateTexts 结构化一致） */
export type TranslateTextsFn = (
  texts: readonly string[],
  targetLang: string,
) => Promise<{
  texts: string[];
  detectedLang?: string;
  engine: 'microsoft' | 'google' | 'mymemory';
}>;

/** 检测文本是否含 CJK 字符（简体/繁体/扩展 A） */
export function containsCjk(text: string): boolean {
  return /[一-鿿㐀-䶿]/.test(text);
}

/** 中英互译目标语言判定：含 CJK → en，否则 zh-CN */
export function resolveMailTargetLang(sampleText: string): 'zh-CN' | 'en' {
  return containsCjk(sampleText) ? 'en' : 'zh-CN';
}

export interface HtmlSegments {
  /** 提取出的文本段（trim 后非空） */
  readonly segments: string[];
  /** 用译文数组回填，返回完整 HTML（结构保真） */
  readonly rebuild: (translated: readonly string[]) => string;
}

/**
 * HTML 分词器：按标签切分，提取可翻译文本段。
 *
 * 原理：`html.split(/(<[^>]+>)/g)` 产生交替的 [文本, 标签, 文本, 标签…]；
 * 文本节点即为可翻译单元（属性值留在标签内不受影响）。
 * <style> 开闭状态跟踪：样式块内的 CSS 不翻译。
 *
 * rebuild 通过 segments 在原序列中的索引原位替换，结构 100% 保真。
 */
export function splitHtmlSegments(html: string): HtmlSegments {
  const parts = html.split(/(<[^>]+>)/g);
  const segments: string[] = [];
  /** 记录每个 segment 在 parts 中的索引 */
  const segmentIndices: number[] = [];
  let inStyle = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.startsWith('<')) {
      // 标签：跟踪 style 开闭（自闭合/属性形态兼容）
      const tagName = /^<\/?\s*([a-zA-Z0-9]+)/.exec(part)?.[1]?.toLowerCase();
      if (tagName === 'style') {
        inStyle = !part.startsWith('</');
      }
      continue;
    }
    // 文本节点
    if (inStyle) continue;
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    // 纯空白/实体空白（&nbsp; 等）跳过
    if (/^(&[a-zA-Z#0-9]+;|\s)+$/.test(trimmed)) continue;
    segments.push(trimmed);
    segmentIndices.push(i);
  }

  return {
    segments,
    rebuild: (translated: readonly string[]): string => {
      const out = [...parts];
      for (let j = 0; j < segmentIndices.length && j < translated.length; j++) {
        out[segmentIndices[j]!] = translated[j]!;
      }
      return out.join('');
    },
  };
}

/** 把文本段按字符上限拼批（段不被拆断） */
export function batchSegments(segments: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const seg of segments) {
    // 单段超上限时截断（防御极端长段）
    const text = seg.length > BATCH_MAX_CHARS ? seg.slice(0, BATCH_MAX_CHARS) : seg;
    if (currentChars + text.length > BATCH_MAX_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface MailTranslateResult {
  /** 译文 HTML（原邮件有 HTML 时） */
  html?: string;
  /** 译文纯文本（原邮件仅纯文本时） */
  text?: string;
  detectedLang?: string;
  engine: 'microsoft' | 'google' | 'mymemory';
  targetLang: string;
}

/**
 * 邮件正文翻译编排。
 *
 * @param body 邮件正文（html / text 至少其一）
 * @param translateTexts TranslateManager.translateTexts 绑定
 * @param targetLangOverride 用户显式指定目标语言（缺省走中英自动判定）
 */
export async function translateMailBody(
  body: { html?: string; text?: string },
  translateTexts: TranslateTextsFn,
  targetLangOverride?: string,
): Promise<MailTranslateResult> {
  const sample = body.text ?? body.html ?? '';
  const targetLang = targetLangOverride ?? resolveMailTargetLang(sample);

  if (body.html) {
    const { segments, rebuild } = splitHtmlSegments(body.html);
    if (segments.length === 0) {
      // 无可翻译文本（如纯图片邮件）：原样返回
      return { html: body.html, engine: 'microsoft', targetLang };
    }
    const capped = segments.slice(0, MAX_SEGMENTS);
    const batches = batchSegments(capped);
    const translated: string[] = [];
    let detectedLang: string | undefined;
    let engine: 'microsoft' | 'google' | 'mymemory' = 'microsoft';
    for (const batch of batches) {
      const result = await translateTexts(batch, targetLang);
      translated.push(...result.texts);
      detectedLang = detectedLang ?? result.detectedLang;
      engine = result.engine;
    }
    return { html: rebuild(translated), detectedLang, engine, targetLang };
  }

  if (body.text) {
    const trimmed = body.text.trim();
    if (trimmed.length === 0) {
      return { text: body.text, engine: 'microsoft', targetLang };
    }
    // 纯文本按 BATCH_MAX_CHARS 截断翻译（单段）
    const result = await translateTexts([trimmed.slice(0, BATCH_MAX_CHARS)], targetLang);
    return {
      text: result.texts[0] ?? '',
      detectedLang: result.detectedLang,
      engine: result.engine,
      targetLang,
    };
  }

  return { engine: 'microsoft', targetLang };
}

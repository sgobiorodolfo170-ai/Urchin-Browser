/**
 * M24 网页翻译 · 引擎抽象与批处理常量
 *
 * 依据：docs/网页翻译功能规划.md §7.1（TD2/TD6 决策）
 *
 * 设计理由（agents.md §七.2）：
 * - TranslateEngine 接口统一「文本批 → 译文批」，引擎实现（微软/谷歌免费接口）
 *   对 TranslateManager 完全透明——非官方免费接口存在限流/变更风险，
 *   接口抽象是双引擎互为兜底（failover）与后续 v2 挂载官方额度引擎/本地引擎的前提
 * - HttpTransport 由装配方注入（生产为 Electron net.fetch——走 Chromium 网络栈，
 *   系统代理下谷歌可达，auto 引擎判定才成立；单测注入 mock），引擎模块不 import electron，
 *   保证可单测性（与 TabManager 注入 BrowserViewFactory 同一思路）
 */

/** 引擎 ID（v1 内置引擎；mymemory 为 2026-09-27 新增的国内直连兜底引擎——
 *  微软 Edge 免费端点已关闭 404，谷歌国内直连不可达） */
export type EngineId = 'microsoft' | 'google' | 'mymemory';

/**
 * HTTP 传输抽象。
 *
 * 返回原始 status + text（JSON 解析留给引擎），以便单测用纯对象 mock，
 * 生产适配 net.fetch（含系统代理与 TLS，由 Chromium 栈负责）。
 */
export type HttpTransport = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text: string }>;

export interface TranslateRequestOptions {
  /** 源语言（省略时由引擎自动检测） */
  from?: string;
  /** 目标语言（规范化代码，如 zh-CN） */
  to: string;
  signal?: AbortSignal;
}

export interface TranslateBatchResult {
  /** 译文，顺序与输入一一对应 */
  texts: string[];
  /** 引擎检测到的源语言（微软 detectedLanguage；谷歌响应携带时提取） */
  detectedLang?: string;
}

export interface TranslateEngine {
  readonly id: EngineId;
  translateBatch(
    texts: readonly string[],
    opts: TranslateRequestOptions,
  ): Promise<TranslateBatchResult>;
}

export type EngineErrorCode = 'network' | 'auth' | 'rate_limited' | 'bad_response';

/**
 * 引擎错误：携带引擎 ID 与错误码，TranslateManager 据此决定
 * 重试 / failover（TD2）并生成对用户无害的提示（不携带页面原文，§六隐私）。
 */
export class EngineError extends Error {
  constructor(
    readonly engine: EngineId,
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

// ---------------------------------------------------------------------------
// 批处理常量（agents.md §七.3：禁止裸写 magic number，集中定义并注明依据）
// ---------------------------------------------------------------------------

/** 单次引擎请求最大字符量（免费接口保守上限：微软单请求 50k 仍分批，防超时与限流） */
export const TRANSLATE_BATCH_MAX_CHARS = 4000;

/** 单次引擎请求最大段数（防止 URL/请求体过大，与字符上限双保险） */
export const TRANSLATE_BATCH_MAX_SEGMENTS = 40;

/** 引擎请求并发上限（免费接口限流敏感，3 路并发实测安全区） */
export const TRANSLATE_MAX_CONCURRENCY = 3;

/** 单页采集段数上限（超大国页面保护：超出部分 v1 不翻译，§10 风险表「大页面性能」） */
export const TRANSLATE_PAGE_MAX_SEGMENTS = 3000;

/** 动态内容轮询间隔（活动期 pending 拉取，§4 拉取模型；空闲段成本为一次 executeJavaScript 空查询） */
export const TRANSLATE_POLL_INTERVAL_MS = 1500;

/** 每轮 pending 拉取段数（与单请求段数上限对齐） */
export const TRANSLATE_PENDING_BATCH = TRANSLATE_BATCH_MAX_SEGMENTS;

/** 划词翻译文本上限（与 ipc-schema translateSelectionReqSchema max 对齐） */
export const SELECTION_MAX_CHARS = 5000;

/** 注入脚本执行超时（页面 collect 大页面 TreeWalker + executeJavaScript 往返，宽于 page-context 的 5s） */
export const TRANSLATE_INJECT_TIMEOUT_MS = 8000;

/** 引擎单次 HTTP 请求超时（免费接口无 SLA，必须自带超时才能触发 failover） */
export const TRANSLATE_HTTP_TIMEOUT_MS = 15000;

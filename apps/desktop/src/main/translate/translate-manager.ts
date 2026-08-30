/**
 * M24 网页翻译 · TranslateManager（主进程权威源）
 *
 * 依据：docs/网页翻译功能规划.md §4/§7.5（TD1/TD2/TD4/TD6 决策）
 *
 * 职责：
 * 1. 每 tab 翻译状态机：collecting → translating → done/error（stop 回 idle）
 * 2. 引擎自动选择（TD2/评审第二轮）：resolveProxy 判定——直连微软优先、走系统代理谷歌优先；
 *    双引擎互为兜底（主引擎失败重试一次 → 备用引擎；备用成功后后续批次直接用它）
 * 3. 页面交互全经 executeJavaScript 注入（TD1：tab 无 preload 且明令禁止；
 *    节点映射留在页面世界，主进程只拿纯文本段与回传译文——拉取模型）
 * 4. 分批并发翻译 + 每 tab 内存缓存（导航重译/重开翻译时缓存命中段零请求）
 * 5. did-finish-load：激活态自动重译；autoTranslate 开启（opt-in）时外语页自动翻译
 * 6. 动态内容：完成后启动 pending 轮询（页面 MutationObserver 暂存 + 主进程定时拉取）
 * 7. 进度事件 translate:progress 下发渲染层（载荷只含计数/阶段/提示，不含原文译文——§六隐私）
 *
 * 不在本文件实现的职责：
 * - 引擎 HTTP 细节（engines/microsoft.ts、engines/google.ts）
 * - 页面脚本内容（scripts/page-translate-script.ts）
 * - IPC 注册（register-handlers.ts）
 */
import { createLogger } from '@urchin/logger';
import {
  TRANSLATE_TARGET_LANGS,
  type TranslateEngineSetting,
  type TranslateGetStatusRes,
  type TranslateSelectionRes,
  type TranslateStartRes,
  type TranslateStopRes,
  type TranslateTargetLang,
} from '@urchin/ipc-contract';
import type { WebContentsLike } from '../tabs/types';
import {
  EngineError,
  SELECTION_MAX_CHARS,
  TRANSLATE_BATCH_MAX_CHARS,
  TRANSLATE_BATCH_MAX_SEGMENTS,
  TRANSLATE_HTTP_TIMEOUT_MS,
  TRANSLATE_INJECT_TIMEOUT_MS,
  TRANSLATE_MAX_CONCURRENCY,
  TRANSLATE_PAGE_MAX_SEGMENTS,
  TRANSLATE_PENDING_BATCH,
  TRANSLATE_POLL_INTERVAL_MS,
  type EngineId,
  type TranslateEngine,
} from './engines/types';
import {
  TEARDOWN_CALL,
  buildApplyCall,
  buildCollectCall,
  buildTakePendingCall,
} from './scripts/page-translate-script';

const log = createLogger('translate');

// ---------------------------------------------------------------------------
// 依赖注入接口（结构化最小依赖，便于单测 mock——与 TabManager 注入风格一致）
// ---------------------------------------------------------------------------

export interface TranslateTabEntry {
  readonly id: number;
  readonly webContents: WebContentsLike;
}

/** TabManager 的最小依赖面（真实 TabManager 结构化满足；单测注入 mock） */
export interface TranslateTabManagerLike {
  getTab(id: number): TranslateTabEntry | undefined;
  query(filter: Record<string, unknown>): readonly { id: number }[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/** SettingsManager 的最小依赖面（只读 get） */
export interface TranslateSettingsLike {
  get(key: string): unknown;
}

export interface TranslateManagerDeps {
  readonly tabManager: TranslateTabManagerLike;
  readonly settings: TranslateSettingsLike;
  /**
   * 系统代理解析（生产注入 session.defaultSession.resolveProxy）。
   * auto 引擎判定依据：谷歌域名解析结果含 PROXY/SOCKS ⇒ 翻墙环境（谷歌优先）；
   * DIRECT ⇒ 直连（微软优先）。本地确定性判定，不发探测请求。
   */
  readonly resolveProxy: (url: string) => Promise<string>;
  /** 引擎注册表（TD6）：生产装配方注入 net.fetch 版双引擎；单测注入 mock */
  readonly engines: Record<EngineId, TranslateEngine>;
  readonly pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 纯函数（导出供单测）
// ---------------------------------------------------------------------------

/** 校验目标语言设置值，非法回退默认 zh-CN（评审确认 zh-CN 必含且默认） */
export function sanitizeTargetLang(value: unknown): TranslateTargetLang {
  const list = TRANSLATE_TARGET_LANGS as readonly string[];
  return list.includes(value as string) ? (value as TranslateTargetLang) : 'zh-CN';
}

/** 校验引擎设置值，非法回退 auto */
export function sanitizeEngineSetting(value: unknown): TranslateEngineSetting {
  return value === 'microsoft' || value === 'google' || value === 'auto' ? value : 'auto';
}

/**
 * 语言标签归一化（TD7：语言一致跳过判定）。
 * - en-US / en-GB → en；pt-BR → pt（取主子 tag）
 * - zh 系细拆：zh / zh-Hans / zh-CN → zh-CN；zh-Hant / zh-TW / zh-HK → zh-TW
 *   （简繁互译是合法诉求，不能因 base 同为 zh 而跳过）
 * - 精确命中目标语言集合时原样返回
 */
export function normalizeLangTag(tag: string): string {
  const t = tag.trim().toLowerCase();
  if (!t) return '';
  const exact = (TRANSLATE_TARGET_LANGS as readonly string[]).find((l) => l.toLowerCase() === t);
  if (exact) return exact;
  if (t === 'zh' || t.startsWith('zh-')) {
    if (t.includes('hant') || t.includes('tw') || t.includes('hk') || t.includes('mo')) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  return t.split('-')[0] ?? t;
}

export interface CollectableSegment {
  id: number;
  text: string;
}

/**
 * 按字符量与段数上限把待译段切批（贪心装箱）。
 * 超长单段独占一批（引擎侧单请求仍可承载，批上限只约束「多段合并」）。
 */
export function chunkSegments(
  segments: readonly CollectableSegment[],
  maxChars: number = TRANSLATE_BATCH_MAX_CHARS,
  maxSegments: number = TRANSLATE_BATCH_MAX_SEGMENTS,
): CollectableSegment[][] {
  const batches: CollectableSegment[][] = [];
  let current: CollectableSegment[] = [];
  let currentChars = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (current.length >= maxSegments || (current.length > 0 && currentChars + len > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(seg);
    currentChars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 每 tab 内存缓存键：目标语言 + 原文（同 tab 内导航重译命中零请求） */
export function cacheKey(targetLang: string, text: string): string {
  return `${targetLang}\u0000${text}`;
}

// ---------------------------------------------------------------------------
// 状态与进度事件载荷（渲染层经 preload on('translate:progress') 订阅）
// ---------------------------------------------------------------------------

export interface TranslateProgressPayload {
  tabId: number;
  phase: 'collecting' | 'translating' | 'done' | 'error';
  done?: number;
  total?: number;
  /** 面向用户的简短提示（切换引擎/失败计数等；不含页面原文译文） */
  message?: string;
}

export const TRANSLATE_PROGRESS_CHANNEL = 'translate:progress';

interface TabState {
  status: 'collecting' | 'translating' | 'done' | 'error';
  targetLang: TranslateTargetLang;
  engineSetting: TranslateEngineSetting;
  resolvedEngine: EngineId;
  total: number;
  done: number;
  failed: number;
  failoverNotified: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  settledPromise: Promise<void>;
  settle: () => void;
}

export interface TranslateStartOptions {
  targetLang?: unknown;
  engine?: unknown;
  /**
   * 自动翻译触发（TD4）：仅当 translate.autoTranslate 开启时由导航钩子传入。
   * 开启保守规则——页面 lang 属性缺失/未知时不翻译（规划 §7.5）。
   */
  autoTriggered?: boolean;
}

export class TranslateManager {
  private readonly states = new Map<number, TabState>();
  private readonly cacheByTab = new Map<number, Map<string, string>>();
  private readonly disposers: (() => void)[] = [];
  /** auto 引擎判定缓存（会话级；双引擎均失败时清除，下次重新判定） */
  private autoEngineCache?: EngineId;

  constructor(private readonly deps: TranslateManagerDeps) {
    // created 事件 + 存量补装（zoom installZoomControl 同款模式）：
    // 每个 tab 的 webContents 挂 did-finish-load → 激活态重译 / 自动翻译判定
    const attach = (...args: unknown[]): void => {
      const snapshot = args[0] as { id: number } | undefined;
      if (!snapshot || typeof snapshot.id !== 'number') return;
      const tab = this.deps.tabManager.getTab(snapshot.id);
      if (!tab) return;
      const onLoad = (): void => this.onNavigationFinished(tab.id);
      tab.webContents.on('did-finish-load', onLoad);
      this.disposers.push(() => {
        tab.webContents.removeListener?.('did-finish-load', onLoad);
      });
    };
    this.deps.tabManager.on('created', attach);
    this.deps.tabManager.on('removed', (...args: unknown[]) => {
      const snapshot = args[0] as { id: number } | undefined;
      if (snapshot && typeof snapshot.id === 'number') this.forgetTab(snapshot.id);
    });
    for (const snapshot of this.deps.tabManager.query({})) {
      attach(snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // 公共 API（register-handlers 调用）
  // -------------------------------------------------------------------------

  /**
   * 启动整页翻译。采集完成后即返回（后台分批翻译，进度经事件推送）；
   * 测试/E2E 用 whenSettled 同步等待收尾。
   */
  async start(tabId: number, opts: TranslateStartOptions = {}): Promise<TranslateStartRes> {
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) throw new Error(`tab not found: ${tabId}`);

    // 已激活：静默重置（恢复原文 + 清理），再重新开始
    if (this.states.has(tabId)) await this.resetTab(tabId);

    const targetLang = sanitizeTargetLang(
      opts.targetLang ?? this.deps.settings.get('translate.targetLang'),
    );
    const engineSetting = sanitizeEngineSetting(
      opts.engine ?? this.deps.settings.get('translate.engine'),
    );
    const resolvedEngine =
      engineSetting === 'auto' ? await this.resolveAutoEngine() : engineSetting;

    this.emitProgress(tabId, { phase: 'collecting' });

    let lang = '';
    let segments: CollectableSegment[] = [];
    try {
      const result = await this.executeWithTimeout<{
        lang?: string;
        segments?: CollectableSegment[];
      }>(tab.webContents, buildCollectCall(), TRANSLATE_INJECT_TIMEOUT_MS);
      lang = typeof result?.lang === 'string' ? result.lang : '';
      segments = Array.isArray(result?.segments)
        ? result.segments
            .filter(
              (s): s is CollectableSegment =>
                typeof s?.id === 'number' && typeof s?.text === 'string',
            )
            .slice(0, TRANSLATE_PAGE_MAX_SEGMENTS)
        : [];
    } catch (err) {
      log.warn('collect failed', {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emitProgress(tabId, { phase: 'error', message: '页面采集失败' });
      throw new Error(
        `translate collect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // TD4 保守规则：自动触发但页面语言未知 → 不翻译（避免误翻与检测请求）
    if (opts.autoTriggered && !lang) {
      await this.teardownPage(tabId);
      return { status: 'skipped', message: 'page language unknown' };
    }

    // TD7：页面语言与目标一致 → 跳过（不发翻译请求）
    if (lang && normalizeLangTag(lang) === normalizeLangTag(targetLang)) {
      await this.teardownPage(tabId);
      log.info('translate skipped (same language)', { tabId, lang, targetLang });
      return {
        status: 'skipped',
        detectedLang: lang,
        segmentCount: segments.length,
        message: 'page language matches target',
      };
    }

    const state = this.createState(targetLang, engineSetting, resolvedEngine);
    this.states.set(tabId, state);
    this.cacheByTab.set(tabId, this.cacheByTab.get(tabId) ?? new Map<string, string>());

    if (segments.length === 0) {
      state.status = 'done';
      state.settle();
      this.emitProgress(tabId, { phase: 'done', done: 0, total: 0 });
      this.startPolling(tabId);
      return { status: 'started', detectedLang: lang || undefined, segmentCount: 0 };
    }

    state.total = segments.length;
    // 后台执行：start 即刻返回 started，完成/失败经事件与 whenSettled 体现
    void this.translateSegments(tabId, state, segments).catch((err) => {
      log.warn('translate pipeline crashed', {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
      state.status = 'error';
      state.settle();
      this.emitProgress(tabId, { phase: 'error', message: '翻译过程出现异常' });
    });

    return { status: 'started', detectedLang: lang || undefined, segmentCount: segments.length };
  }

  /** 停止翻译并恢复原文；未激活返回 idle */
  async stop(tabId: number): Promise<TranslateStopRes> {
    if (!this.states.has(tabId)) return { status: 'idle' };
    await this.resetTab(tabId);
    this.emitProgress(tabId, { phase: 'done', message: '已恢复原文' });
    return { status: 'restored' };
  }

  /** 地址栏按钮态查询 */
  getStatus(tabId: number): TranslateGetStatusRes {
    const state = this.states.get(tabId);
    if (!state) return { active: false };
    return {
      active: true,
      engine: state.engineSetting,
      resolvedEngine: state.resolvedEngine,
      targetLang: state.targetLang,
      segmentCount: state.total,
    };
  }

  /** 划词翻译（右键菜单 selectionText）：不走页面注入，单次引擎调用 + 备用引擎兜底 */
  async translateSelection(
    tabId: number,
    text: string,
    targetLang?: unknown,
  ): Promise<TranslateSelectionRes> {
    void tabId;
    const to = sanitizeTargetLang(targetLang ?? this.deps.settings.get('translate.targetLang'));
    const engineSetting = sanitizeEngineSetting(this.deps.settings.get('translate.engine'));
    const primary = engineSetting === 'auto' ? await this.resolveAutoEngine() : engineSetting;
    const secondary: EngineId = primary === 'microsoft' ? 'google' : 'microsoft';

    let lastError: unknown;
    for (const engineId of [primary, secondary]) {
      try {
        const result = await this.callEngine(engineId, [text.slice(0, SELECTION_MAX_CHARS)], to);
        return { result: result.texts[0] ?? '', detectedLang: result.detectedLang };
      } catch (err) {
        lastError = err;
        log.warn('selection translate failed, trying fallback', {
          engineId,
          code: err instanceof EngineError ? err.code : 'unknown',
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 等待指定 tab 当前翻译轮收尾（done/error/被取代/停止）；未激活立即返回。测试与 E2E 同步用 */
  whenSettled(tabId: number): Promise<void> {
    return this.states.get(tabId)?.settledPromise ?? Promise.resolve();
  }

  /** 释放：停轮询、移除监听、清空状态（应用退出时调用） */
  dispose(): void {
    for (const [tabId] of this.states) {
      const state = this.states.get(tabId);
      if (state?.pollTimer) clearInterval(state.pollTimer);
      state?.abort?.abort();
      state?.settle();
    }
    this.states.clear();
    this.cacheByTab.clear();
    this.autoEngineCache = undefined;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private createState(
    targetLang: TranslateTargetLang,
    engineSetting: TranslateEngineSetting,
    resolvedEngine: EngineId,
  ): TabState {
    let settle!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      status: 'translating',
      targetLang,
      engineSetting,
      resolvedEngine,
      total: 0,
      done: 0,
      failed: 0,
      failoverNotified: false,
      abort: new AbortController(),
      settledPromise,
      settle,
    };
  }

  /** 状态身份校验：in-flight 回调只允许作用于仍在册的同一状态对象（stop/重开即失效） */
  private isCurrent(tabId: number, state: TabState): boolean {
    return this.states.get(tabId) === state;
  }

  /** 恢复原文 + 拆除页面运行时 + 清理定时器与在途请求 */
  private async resetTab(tabId: number): Promise<void> {
    const state = this.states.get(tabId);
    if (!state) return;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = undefined;
    }
    state.abort?.abort();
    this.states.delete(tabId);
    await this.teardownPage(tabId);
    state.settle();
  }

  /** 仅拆除页面运行时（collect 已注入但决定不翻译时也必须拆，防 Observer 泄漏） */
  private async teardownPage(tabId: number): Promise<void> {
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) return;
    try {
      await this.executeWithTimeout(tab.webContents, TEARDOWN_CALL, TRANSLATE_INJECT_TIMEOUT_MS);
    } catch {
      // 页面可能已导航/销毁：恢复无从谈起，静默即可
    }
  }

  /** tab 移除（关闭/窗口销毁）：不注入恢复（页面已不存在），仅清状态 */
  private forgetTab(tabId: number): void {
    const state = this.states.get(tabId);
    if (state?.pollTimer) clearInterval(state.pollTimer);
    state?.abort?.abort();
    state?.settle();
    this.states.delete(tabId);
    this.cacheByTab.delete(tabId);
  }

  /**
   * auto 引擎解析（TD2/评审第二轮）：resolveProxy 判定网络环境。
   * - DIRECT（直连，国内）⇒ 微软优先
   * - PROXY/SOCKS（系统代理，翻墙）⇒ 谷歌优先（可达且质量更优）
   * 判定按会话缓存；双引擎均失败时清除（translateWithFailover），下次重新判定。
   * 判定误判不影响正确性：优先引擎失败仍有 failover 兜底。
   */
  private async resolveAutoEngine(): Promise<EngineId> {
    if (this.autoEngineCache) return this.autoEngineCache;
    let proxyInfo = '';
    try {
      proxyInfo = await this.deps.resolveProxy('https://translate.googleapis.com/');
    } catch (err) {
      log.warn('resolveProxy failed, default to microsoft', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const prefer: EngineId = /proxy|socks/i.test(proxyInfo) ? 'google' : 'microsoft';
    this.autoEngineCache = prefer;
    log.info('auto engine resolved', { proxyInfo, prefer });
    return prefer;
  }

  /** 引擎调用 + HTTP 超时兜底（免费接口无 SLA，超时按失败走 failover） */
  private async callEngine(
    engineId: EngineId,
    texts: readonly string[],
    to: string,
    signal?: AbortSignal,
  ): Promise<{ texts: string[]; detectedLang?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.deps.engines[engineId].translateBatch(texts, { to, signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EngineError(
                  engineId,
                  'network',
                  `timeout after ${TRANSLATE_HTTP_TIMEOUT_MS}ms`,
                ),
              ),
            TRANSLATE_HTTP_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 单批翻译（互为兜底，TD2）：
   * 主引擎 → 失败重试一次 → 备用引擎；备用成功后后续批次直接用备用引擎
   * 并在进度事件中提示一次「已切换」。双引擎均失败：清 auto 缓存 + 抛错（跳过该批）。
   */
  private async translateWithFailover(
    tabId: number,
    state: TabState,
    items: readonly string[],
  ): Promise<{ texts: string[]; detectedLang?: string }> {
    const primary = state.resolvedEngine;
    const secondary: EngineId = primary === 'microsoft' ? 'google' : 'microsoft';
    const attempts: EngineId[] = [primary, primary, secondary];
    let lastError: unknown;
    for (const engineId of attempts) {
      if (!this.isCurrent(tabId, state)) throw new Error('translation superseded');
      try {
        const result = await this.callEngine(
          engineId,
          items,
          state.targetLang,
          state.abort?.signal,
        );
        if (engineId !== primary) {
          state.resolvedEngine = engineId;
          if (!state.failoverNotified) {
            state.failoverNotified = true;
            this.emitProgress(tabId, {
              phase: 'translating',
              done: state.done,
              total: state.total,
              message: `已切换至${engineId === 'microsoft' ? '微软' : '谷歌'}翻译引擎`,
            });
          }
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!this.isCurrent(tabId, state)) throw new Error('translation superseded');
        log.warn('engine attempt failed', {
          tabId,
          engineId,
          code: err instanceof EngineError ? err.code : 'unknown',
        });
      }
    }
    this.autoEngineCache = undefined;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * 翻译管线：缓存命中段直接回写；未命中段切批 → 受限并发 → 逐批引擎翻译 → 写回页面。
   * 全部收尾后置 done、发完成事件（含失败计数）、启动 pending 轮询。
   */
  private async translateSegments(
    tabId: number,
    state: TabState,
    segments: readonly CollectableSegment[],
  ): Promise<void> {
    const cache = this.cacheByTab.get(tabId) ?? new Map<string, string>();
    this.cacheByTab.set(tabId, cache);

    const hits: { id: number; text: string }[] = [];
    const todo: CollectableSegment[] = [];
    for (const seg of segments) {
      const cached = cache.get(cacheKey(state.targetLang, seg.text));
      if (cached !== undefined) hits.push({ id: seg.id, text: cached });
      else todo.push(seg);
    }
    state.total += segments.length;
    if (hits.length > 0) {
      state.done += hits.length;
      await this.applyBatch(tabId, state, hits);
      if (this.isCurrent(tabId, state)) {
        this.emitProgress(tabId, { phase: 'translating', done: state.done, total: state.total });
      }
    }

    const batches = chunkSegments(todo);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length && this.isCurrent(tabId, state)) {
        const batch = batches[next];
        if (!batch) break;
        next += 1;
        await this.processBatch(tabId, state, batch);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TRANSLATE_MAX_CONCURRENCY, batches.length) }, worker),
    );

    if (!this.isCurrent(tabId, state)) return; // 已被 stop/新 start 取代
    state.status = 'done';
    state.settle();
    this.emitProgress(tabId, {
      phase: 'done',
      done: state.done,
      total: state.total,
      message: state.failed > 0 ? `${state.failed} 段翻译失败` : undefined,
    });
    this.startPolling(tabId);
  }

  private async processBatch(
    tabId: number,
    state: TabState,
    batch: readonly CollectableSegment[],
  ): Promise<void> {
    try {
      const texts = batch.map((s) => s.text);
      const result = await this.translateWithFailover(tabId, state, texts);
      if (!this.isCurrent(tabId, state)) return;
      const cache = this.cacheByTab.get(tabId);
      const applied: { id: number; text: string }[] = [];
      batch.forEach((seg, i) => {
        const translated = result.texts[i] ?? '';
        cache?.set(cacheKey(state.targetLang, seg.text), translated);
        applied.push({ id: seg.id, text: translated });
      });
      state.done += batch.length;
      await this.applyBatch(tabId, state, applied);
      if (this.isCurrent(tabId, state)) {
        this.emitProgress(tabId, { phase: 'translating', done: state.done, total: state.total });
      }
    } catch (err) {
      // 单批彻底失败：跳过该批（节点保持原文），计入失败数，不中断整体
      state.failed += batch.length;
      log.warn('batch translate failed, skipped', {
        tabId,
        segments: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 写回一批译文到页面（节点映射在页面世界，主进程只传 id+译文） */
  private async applyBatch(
    tabId: number,
    state: TabState,
    items: readonly { id: number; text: string }[],
  ): Promise<void> {
    if (!this.isCurrent(tabId, state)) return;
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) return;
    try {
      await this.executeWithTimeout(
        tab.webContents,
        buildApplyCall(items),
        TRANSLATE_INJECT_TIMEOUT_MS,
      );
    } catch (err) {
      log.warn('apply batch failed', {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 完成后启动 pending 轮询：页面 MutationObserver 暂存新增节点 → 主进程定时拉取翻译 */
  private startPolling(tabId: number): void {
    const state = this.states.get(tabId);
    if (!state || state.pollTimer) return;
    const interval = this.deps.pollIntervalMs ?? TRANSLATE_POLL_INTERVAL_MS;
    state.pollTimer = setInterval(() => void this.pollPending(tabId), interval);
  }

  private async pollPending(tabId: number): Promise<void> {
    const state = this.states.get(tabId);
    if (state?.status !== 'done') return;
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) return;
    let pending: CollectableSegment[] = [];
    try {
      const raw = await this.executeWithTimeout<unknown>(
        tab.webContents,
        buildTakePendingCall(TRANSLATE_PENDING_BATCH),
        TRANSLATE_INJECT_TIMEOUT_MS,
      );
      pending = Array.isArray(raw)
        ? (raw as CollectableSegment[]).filter(
            (s): s is CollectableSegment =>
              typeof s?.id === 'number' && typeof s?.text === 'string',
          )
        : [];
    } catch {
      return; // 页面可能正在导航，下轮再取
    }
    if (pending.length === 0 || !this.isCurrent(tabId, state)) return;
    state.status = 'translating';
    await this.translateSegments(tabId, state, pending);
  }

  /**
   * did-finish-load：激活态 → 导航后自动重译（页面世界已随导航重建）；
   * 非激活 + autoTranslate 开启 + http(s) → 自动翻译判定（TD4）。
   */
  private onNavigationFinished(tabId: number): void {
    const state = this.states.get(tabId);
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) return;
    if (state) {
      const { targetLang, engineSetting } = state;
      void this.resetTab(tabId)
        .then(() => this.start(tabId, { targetLang, engine: engineSetting }))
        .then((res) => {
          if (res.status === 'started') log.info('re-translated after navigation', { tabId });
        })
        .catch((err) => {
          log.warn('re-translate after navigation failed', {
            tabId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return;
    }
    if (
      this.deps.settings.get('translate.autoTranslate') === true &&
      /^https?:\/\//i.test(tab.webContents.getURL())
    ) {
      void this.start(tabId, { autoTriggered: true }).catch((err) => {
        log.warn('auto translate failed', {
          tabId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private emitProgress(tabId: number, payload: Omit<TranslateProgressPayload, 'tabId'>): void {
    const tab = this.deps.tabManager.getTab(tabId);
    tab?.webContents.send?.(TRANSLATE_PROGRESS_CHANNEL, {
      tabId,
      ...payload,
    } satisfies TranslateProgressPayload);
  }

  /** 带超时保护的 executeJavaScript（page-context extractor 同款竞速模式） */
  private async executeWithTimeout<T>(
    webContents: WebContentsLike,
    code: string,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        webContents.executeJavaScript<T>(code, true),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`executeJavaScript timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

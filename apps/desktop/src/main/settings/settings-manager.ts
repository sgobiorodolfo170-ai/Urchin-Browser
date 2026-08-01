/**
 * M7 Settings · 核心类
 *
 * 依据：契约 B §3.1 settings.* 通道 / 04-模块全景 M7
 * 职责：
 * 1. 管理设置集合（Map<string, unknown>）
 * 2. 构造时预填充默认设置（theme / searchEngine / homepage 等）
 * 3. get / set / getAll / has / delete 方法
 * 4. 事件分发（changed）
 * 5. 持久化到 StorageLayer（设置变更时自动写入 SQLite）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是设置状态的唯一权威源，渲染层 store 只是镜像
 * - 全部方法同步执行（内存操作），持久化通过 StorageLayer 写入 SQLite
 * - value 为 unknown 类型，承载异构配置值
 */
import type { SettingEntry, SettingsEvent, SettingsEventListener } from './types';
import { createLogger } from '@urchin/logger';

const log = createLogger('settings-manager');

/** 持久化存储接口（最小依赖，便于测试 mock） */
export interface SettingsPersistence {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete?(key: string): void;
}

/** 默认设置项：构造时预填充。 */
const DEFAULT_SETTINGS: readonly (readonly [string, unknown])[] = [
  ['theme', 'light'],
  ['language', 'zh-CN'],
  ['searchEngine', 'google'],
  ['homepage', 'urchin://newtab'],
  ['downloadsPath', ''],
  ['blockTrackers', true],
  ['doNotTrack', true],
  // 链接行为：点击网页内链接时是否在新标签页打开（默认 false = 当前标签页打开）
  ['links.openInNewTab', false],
  // pi 模块（AI 对话标签页）AI 助手设置：由 PiSettingsDialog 编辑，pi-agent-factory 消费。
  // 注意：此组设置与 summary.* 完全独立，pi 模块与摘要模块互不干扰。
  ['ai.model', 'gpt-4o-mini'],
  ['ai.apiKey', ''],
  ['ai.providerId', ''],
  // OpenAI 兼容协议的 Base URL（留空使用官方 https://api.openai.com；
  // 可填 Azure OpenAI、Ollama、vLLM、LM Studio 等兼容端点）
  ['ai.baseUrl', ''],
  // 摘要助手（浏览器内置单 agent，独立于 pi 模块）配置：
  // 由设置页「AI 助手」选项卡编辑，SummaryAgent 消费。
  // 与 ai.* 设置完全独立，两套配置不互通。
  ['summary.model', 'gpt-4o-mini'],
  ['summary.apiKey', ''],
  ['summary.providerId', ''],
  ['summary.baseUrl', ''],
  // 摘要文档本地保存目录（留空使用默认 userData/summaries）
  ['summary.saveDirectory', ''],
  // 调试选项：右侧边栏折叠态下鼠标停留后延迟展开的时长（毫秒，默认 300ms）
  ['debug.sidebarHoverDelay', 300],
] as const;

export class SettingsManager {
  /** 设置集合：key → value */
  private readonly entries = new Map<string, unknown>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<SettingsEvent, SettingsEventListener[]>();

  /** 持久化存储（可选，注入后 set 时自动写入） */
  private readonly persistence?: SettingsPersistence;

  /**
   * 构造时预填充默认设置，并从持久化存储加载已保存的值覆盖默认值。
   *
   * @param persistence 可选的持久化存储（StorageLayer.mainStore）
   */
  constructor(persistence?: SettingsPersistence) {
    this.persistence = persistence;

    // 1. 预填充默认值
    for (const [key, value] of DEFAULT_SETTINGS) {
      this.entries.set(key, value);
    }

    // 2. 从持久化存储加载已保存的值，覆盖默认值
    if (persistence) {
      for (const [key] of DEFAULT_SETTINGS) {
        const saved = persistence.get<unknown>(`settings:${key}`);
        if (saved !== null) {
          this.entries.set(key, saved);
        }
      }
      log.info('settings loaded from persistence');
    }
  }

  /**
   * 获取指定键的值。
   *
   * @param key 设置键名
   * @returns 值；键不存在时返回 undefined
   */
  get(key: string): unknown {
    return this.entries.get(key);
  }

  /**
   * 设置指定键的值。
   *
   * 若键已存在则覆盖原值。触发 'changed' 事件，传入键名与新值。
   * 若注入了持久化存储，同步写入 SQLite。
   *
   * @param key 设置键名
   * @param value 设置值
   */
  set(key: string, value: unknown): void {
    this.entries.set(key, value);
    // 持久化到 SQLite（同步写入，better-sqlite3 是同步的）
    if (this.persistence) {
      try {
        this.persistence.set(`settings:${key}`, value);
      } catch (err) {
        log.error('failed to persist setting', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.emit('changed', key, value);
  }

  /**
   * 获取全部设置条目。
   *
   * @returns SettingEntry 数组（每个条目含 { key, value }）
   */
  getAll(): SettingEntry[] {
    const result: SettingEntry[] = [];
    for (const [key, value] of this.entries) {
      result.push({ key, value });
    }
    return result;
  }

  /**
   * 判断指定键是否存在。
   *
   * @param key 设置键名
   * @returns 存在返回 true，否则 false
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 删除指定键。
   *
   * 触发 'changed' 事件，传入键名与 undefined。
   * 若注入了持久化存储，同步从 SQLite 删除。
   *
   * @param key 设置键名
   * @returns 删除成功返回 true，键不存在返回 false
   */
  delete(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) {
      if (this.persistence?.delete) {
        try {
          this.persistence.delete(`settings:${key}`);
        } catch (err) {
          log.error('failed to delete persisted setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.emit('changed', key, undefined);
    }
    return deleted;
  }

  /** 注册事件监听。 */
  on(event: SettingsEvent, listener: SettingsEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: SettingsEvent, listener: SettingsEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  emit(event: SettingsEvent, key: string, value: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(key, value);
    }
  }
}

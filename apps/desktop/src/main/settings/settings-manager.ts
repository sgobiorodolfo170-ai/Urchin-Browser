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
import type { SecretStore } from '../storage/types';
import { createLogger } from '@urchin/logger';

const log = createLogger('settings-manager');

/** 持久化存储接口（最小依赖，便于测试 mock） */
export interface SettingsPersistence {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete?(key: string): void;
}

/**
 * 敏感设置键集合（apiKey 类）。
 *
 * 这些键的值通过 secretStore（safeStorage 加密）落盘，不写入明文 SQLite。
 * 内存中仍以普通值存在（主进程是 Single Source of Truth，渲染层经 IPC 读取用于编辑展示）。
 */
const SECRET_KEYS = new Set(['ai.apiKey', 'summary.apiKey']);

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
  // 右侧边栏展开方式（默认双击展开；true=悬停自动展开，与双击互斥，设置页 select 切换）
  ['ui.rightSidebarAutoExpand', false],
  // 主页常用网站（用户手动添加/拖拽排序，持久化于 settings；仅存根网址）
  ['home.frequentSites', []],
  // pi 模块（AI 对话标签页）AI 助手设置：由 PiSettingsDialog 编辑，pi-agent-factory 消费。
  // 注意：此组设置与 summary.* 完全独立，pi 模块与摘要模块互不干扰。
  ['ai.model', 'gpt-4o-mini'],
  // ai.apiKey 为敏感键：注入 secretStore 时经 safeStorage 加密落盘（SECRET_KEYS），不存明文 SQLite
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

  /** 敏感数据存储（可选，safeStorage 加密；注入后 SECRET_KEYS 键不再明文落盘） */
  private readonly secretStore?: SecretStore;

  /** 敏感键预加载 Promise（构造时启动，内部消费者经 ensureSecretsLoaded 等待） */
  private readonly secretPreload?: Promise<void>;

  /**
   * 构造时预填充默认设置，并从持久化存储加载已保存的值覆盖默认值。
   *
   * @param persistence 可选的持久化存储（StorageLayer.mainStore）
   * @param secretStore 可选的敏感数据存储（StorageLayer.secrets，safeStorage 加密）
   */
  constructor(persistence?: SettingsPersistence, secretStore?: SecretStore) {
    this.persistence = persistence;
    this.secretStore = secretStore;

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

    // 3. 启动敏感键预加载：从 secretStore 读取已保存的 apiKey 覆盖默认值。
    //    secretStore.get 为 async（内部为同步 fs I/O，Promise 当轮结算），
    //    消费者在读取敏感键前应 await ensureSecretsLoaded() 避免读到 undefined。
    if (secretStore) {
      this.secretPreload = this.preloadSecrets(secretStore);
    }
  }

  /**
   * settings key → SecretStore name 映射。
   *
   * ST6 决策（secret-store.ts VALID_NAME_PATTERN）要求 name 仅含字母数字/下划线/
   * 连字符/斜杠——settings key 中的点号（如 ai.apiKey）不合法，否则读写抛
   * "Invalid secret name" 导致 apiKey 无法落盘（2026-08-14 修复）。
   * 约定：`settings/<key 点转下划线>`，settings/ 前缀做命名空间隔离。
   */
  private secretNameFor(key: string): string {
    return `settings/${key.replace(/\./g, '_')}`;
  }

  /** 从 secretStore 加载全部敏感键到内存 entries。 */
  private async preloadSecrets(secretStore: SecretStore): Promise<void> {
    for (const key of SECRET_KEYS) {
      try {
        const value = await secretStore.get(this.secretNameFor(key));
        if (value !== null) {
          this.entries.set(key, value);
        }
      } catch (err) {
        log.error('failed to load secret setting', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 等待敏感键预加载完成。
   *
   * 供主进程内部消费者（agentConfigProvider / mergedConfigProvider）在读取
   * ai.apiKey / summary.apiKey 前调用，避免启动早期读到未加载的 undefined。
   */
  async ensureSecretsLoaded(): Promise<void> {
    await this.secretPreload;
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
      if (this.secretStore && SECRET_KEYS.has(key)) {
        // 敏感键：写入 safeStorage 加密存储，不落明文 SQLite；同时删除旧的明文条目（迁移）。
        // secretStore.set 内部为同步 fs I/O（async 包装，当轮结算），fire-and-forget 安全。
        const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        void this.secretStore.set(this.secretNameFor(key), raw).catch((err) => {
          log.error('failed to persist secret setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        this.persistence.delete?.(`settings:${key}`);
      } else {
        try {
          this.persistence.set(`settings:${key}`, value);
        } catch (err) {
          log.error('failed to persist setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
      // 敏感键同步从加密存储删除
      if (this.secretStore && SECRET_KEYS.has(key)) {
        void this.secretStore.delete(this.secretNameFor(key)).catch((err) => {
          log.error('failed to delete secret setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        });
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

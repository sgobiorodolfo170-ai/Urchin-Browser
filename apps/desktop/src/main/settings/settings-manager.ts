/**
 * M7 Settings · 核心类
 *
 * 依据：契约 B §3.1 settings.* 通道 / 04-模块全景 M7
 * 职责：
 * 1. 管理设置集合（Map<string, unknown>）
 * 2. 构造时预填充默认设置（searchEngine / downloadsPath 等）
 * 3. get / set / getAll / has / delete 方法
 * 4. 事件分发（changed）
 * 5. 持久化到 StorageLayer（设置变更时自动写入 SQLite）
 *
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
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
const SECRET_KEYS = new Set(['pi.apiKey']);

/**
 * pi 设置键判定（DD1 决策）：
 * pi.* 键属 pi 对话模块，持久化到 pi 目录（pi/ai.db + pi/secrets），
 * 与用户个人数据（书签/历史/普通设置）隔离，不随 data.directory 配置变动。
 */
export function isPiSettingKey(key: string): boolean {
  return key.startsWith('pi.');
}

/** pi 持久化注入项（DD1 决策：pi 键独立存储） */
export interface SettingsPiOptions {
  /** pi 键持久化存储（pi/ai.db 的 settings 表） */
  readonly piPersistence?: SettingsPersistence;
  /** pi 敏感键加密存储（pi/secrets，safeStorage） */
  readonly piSecretStore?: SecretStore;
  /** 扫描旧主库残留 pi 键（settings:ai.* / settings:pi.*），构造时迁移到 pi store 后删除 */
  readonly legacyPiKeysScan?: () => readonly { key: string; value: unknown }[];
}

/** 默认设置项：构造时预填充。 */
const DEFAULT_SETTINGS: readonly (readonly [string, unknown])[] = [
  ['language', 'zh-CN'],
  ['searchEngine', 'google'],
  ['downloadsPath', ''],
  ['blockTrackers', true],
  ['doNotTrack', true],
  // 广告浮窗屏蔽（DB1 决策：默认开启，隐藏网页内悬浮/弹窗类广告）
  ['blockAds', true],
  // 链接行为：点击网页内链接时是否在新标签页打开（默认 false = 当前标签页打开）
  ['links.openInNewTab', false],
  // 右侧边栏展开方式（默认双击展开；true=悬停自动展开，与双击互斥，设置页 select 切换）
  ['ui.rightSidebarAutoExpand', false],
  // 左侧边栏悬停自动展开（默认关闭；双击切换始终可用，悬停展开仅在折叠态生效）
  ['ui.leftSidebarAutoExpand', false],
  // 右侧边栏展开宽度（拖拽调节后落盘，重启恢复）。默认 360 =
  // renderer/lib/layout-constants.ts 的 RIGHT_EXPANDED，两处必须同步修改。
  // 该键必须登记（原因见下方 session.lastTabs），否则宽度每次重启被重置。
  ['ui.rightSidebarWidth', 360],
  // 底部悬浮球灵敏度（上下/左右，范围 0.1-5，设置页调试页可调）。
  // 该键必须登记，否则每次重启被重置为 1（main/index.ts sendBallConfig 回退值）。
  ['ui.statusBall.sensitivityVertical', 1],
  ['ui.statusBall.sensitivityHorizontal', 1],
  // 悬浮球主题（sendBallConfig 读取，未设置时按 light 兜底；当前无写入方，保留兼容）。
  ['theme', 'light'],
  // 折叠态工作区切换模式（'cards'=点击弹出卡片面板切换【默认】；'wheel'=滚轮循环切换，
  // 参考 ego-lite Space 卡片切换设计；仅影响折叠态交互，展开态 WorkspaceBar 不变）
  ['ui.workspaceSwitcherMode', 'cards'],
  // 主页常用网站（用户手动添加/拖拽排序，持久化于 settings；仅存根网址）
  ['home.frequentSites', []],
  // 主页图标排序独立于收藏夹层级与网页时间排序。
  ['home.frequentSiteOrder', []],
  ['home.recentSiteOrder', []],
  // 用户数据目录（DD1 决策）：书签/历史/普通设置/截图/下载/网页保存的根目录。
  // 留空 = userData/data；填写后写 data-location 指针，重启后迁移生效。
  // pi 数据（pi.* / pi 库 / 密钥）固定 userData/pi，不随此目录变动。
  ['data.directory', ''],
  // pi 对话模块设置：pi-agent-factory / pi-web-host agentCredsProvider 消费。
  // pi.* 命名空间与未来 AI 助手（ai.*）完全独立。
  ['pi.model', 'gpt-4o-mini'],
  // pi.apiKey 为敏感键：注入 secretStore 时经 safeStorage 加密落盘（SECRET_KEYS），不存明文 SQLite
  ['pi.apiKey', ''],
  ['pi.providerId', ''],
  // OpenAI 兼容协议的 Base URL（留空使用官方 https://api.openai.com；
  // 可填 Azure OpenAI、Ollama、vLLM、LM Studio 等兼容端点）
  ['pi.baseUrl', ''],
  // 调试选项：右侧边栏折叠态下鼠标停留后延迟展开的时长（毫秒，默认 300ms）
  ['debug.sidebarHoverDelay', 300],
  // 网页翻译（M24，dev.79）：目标语言（2026-08-30 评审确认 zh-CN 默认必含；
  // 全集见 ipc-schema TRANSLATE_TARGET_LANGS）。
  ['translate.targetLang', 'zh-CN'],
  // 引擎选择：auto = 直连微软优先 / 走系统代理谷歌优先（resolveProxy 判定，双引擎互为兜底）；
  // 可手动锁定 'microsoft' | 'google'。免费接口引擎，无敏感键。
  ['translate.engine', 'auto'],
  // 自动翻译开关（TD4 修订：opt-in 默认关）——开启后外语页（documentElement.lang 判定）
  // 加载完成自动翻译为 translate.targetLang；关闭则仅手动触发。
  ['translate.autoTranslate', false],
  // 主窗口几何记忆（2026-08-28 用户需求）：{ x, y, width, height, isMaximized }，
  // 由 main/windows/window-state.ts 读写（resize/move/maximize 防抖落盘，启动恢复）。
  // null = 尚无记录（首次启动/从未改动），恢复逻辑回退默认 1280x800。
  // 主进程内部状态，不暴露给设置页 UI。
  ['window.bounds', null],
  // 标签持久化（TP4）：启动时恢复默认工作区上次打开的标签（默认 ON）。
  // 其他工作区的标签始终保存，切换到该工作区时懒恢复。
  ['startup.restoreTabs', true],
  // 关闭窗口时最小化到系统托盘（2026-11-10 用户需求，默认 OFF）：
  // 开启后点 X 隐藏窗口并驻留托盘，托盘菜单「完全退出」才结束进程；
  // 关闭时维持原行为（最后一个窗口关闭即退出）。
  // 默认 OFF 的理由：驻留进程会持续占用内存且用户可能不知道程序还在运行，
  // 保持与既有安装版本行为一致，由用户显式选择开启。
  ['ui.minimizeToTray', false],
  // 上次退出时的标签快照（TP4）：[{ url, title, workspaceId, active }]，
  // 由 lifecycle/cleanup.ts 在退出前写入。默认 [] = 首次运行无快照。
  // 该键必须登记在此处，SettingsManager 构造时才会从 SQLite 加载已保存状态；
  // 未登记会导致启动时 session.lastTabs 恒为 undefined——默认工作区标签不恢复、
  // 其他工作区懒恢复也拿不到数据（2026-11-09 修复）。
  ['session.lastTabs', []],
  // 工作区注册表（TP7）：{ version, workspaces }，仅名字/颜色/创建时间等非敏感元数据。
  // 默认 null = 无记录，由 WorkspaceRegistry 种子默认工作区后落盘。
  // 该键必须登记：未登记时启动读回 null → 按空状态重建并立即覆盖原记录，
  // 自定义工作区在每次重启后被永久清空（2026-11-09 修复）。
  ['workspaces.registry', null],
  // 剪藏（M26）：保存格式、快照清洗、选中优先与模板。
  ['clipper.defaultFormat', 'markdown'],
  // 剪藏保存路径（2026-11-06 用户需求）：空 = 默认 <数据目录>/documents/clipper。
  // 非（绝对）路径值由 resolveClipDirSetting 回退默认；ClipperStore 每次落盘
  // 动态读取，改后立即生效，无需重启。
  ['clipper.saveDir', ''],
  ['clipper.cleanSnapshot', true],
  ['clipper.selectionPriority', true],
  ['clipper.loadLazyContent', false],
  ['clipper.trimBoilerplate', true],
  ['clipper.noteNameFormat', '{{title}}'],
  [
    'clipper.properties',
    [
      'title: {{title}}',
      'source: {{url}}',
      'author: {{author}}',
      'published: {{published}}',
      'created: {{date}}',
      'description: {{description}}',
      'tags: clippings',
    ].join('\n'),
  ],
  ['clipper.content', '{{content}}'],
  // M27 笔记 / 便利贴（urchin://notebook）：整体状态 JSON（笔记本/页面/任务/便利贴/
  // 画布视口/三区分割位置）。默认 null = 首次运行由渲染层种下默认笔记本。
  // 该键必须登记在此处，SettingsManager 构造时才会从 SQLite 加载已保存状态。
  ['notebook.state', null],
  // M25 邮箱页（urchin://mail）三区布局：左/中两栏像素宽度 JSON（右区铺满余量）。
  // 默认 null = 首次运行由渲染层回退默认宽。该键必须登记在此处，SettingsManager
  // 构造时才会从 SQLite 加载已保存状态。
  ['mail.state', null],
  // 中转区（左侧栏）：items 数组 JSON（文件索引，不复制原文件）。
  // 默认 null = 首次运行为空。该键必须登记在此处，SettingsManager 构造时才会加载。
  ['transit.items', null],
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

  /** pi 键持久化存储（DD1 决策：pi.* 键写 pi/ai.db） */
  private readonly piPersistence?: SettingsPersistence;

  /** pi 敏感键加密存储（pi/secrets） */
  private readonly piSecretStore?: SecretStore;

  /** 敏感键预加载 Promise（构造时启动，内部消费者经 ensureSecretsLoaded 等待） */
  private readonly secretPreload?: Promise<void>;

  /**
   * 构造时预填充默认设置，并从持久化存储加载已保存的值覆盖默认值。
   *
   * @param persistence 可选的持久化存储（StorageLayer.mainStore）——非 pi 键
   * @param secretStore 可选的敏感数据存储（StorageLayer.secrets，safeStorage 加密）
   * @param piOptions pi 键独立存储与旧数据迁移（DD1 决策）
   */
  constructor(
    persistence?: SettingsPersistence,
    secretStore?: SecretStore,
    piOptions?: SettingsPiOptions,
  ) {
    this.persistence = persistence;
    this.secretStore = secretStore;
    this.piPersistence = piOptions?.piPersistence;
    this.piSecretStore = piOptions?.piSecretStore;

    // 1. 预填充默认值
    for (const [key, value] of DEFAULT_SETTINGS) {
      this.entries.set(key, value);
    }

    // 2. 从持久化存储加载已保存的值，覆盖默认值（pi 键优先 pi 库，未注入回退主库）
    if (persistence || piOptions?.piPersistence) {
      for (const [key] of DEFAULT_SETTINGS) {
        const store = isPiSettingKey(key) ? (piOptions?.piPersistence ?? persistence) : persistence;
        const saved = store?.get<unknown>(`settings:${key}`);
        if (saved !== null && saved !== undefined) {
          this.entries.set(key, saved);
        }
      }
      log.info('settings loaded from persistence');
    }

    // 3. 迁移旧布局残留：早期版本 pi 键曾写入主库（settings:ai.* / settings:pi.*），
    //    搬入 pi 库并删除主库条目，保证重启后不再读写错库。
    //    ai.*→pi.* 重命名迁移：旧 ai.model/apiKey/providerId/baseUrl → pi.* 同名。
    //    summary.* / ai.providerProfiles 已废弃：仅从主库删除，不迁移。
    if (piOptions?.legacyPiKeysScan && persistence) {
      for (const { key, value } of piOptions.legacyPiKeysScan()) {
        const bare = key.startsWith('settings:') ? key.slice('settings:'.length) : key;
        // ai.* → pi.* 重命名映射
        const migratedKey = bare.startsWith('ai.') ? 'pi.' + bare.slice(3) : bare;
        const isAiOrPiKey = bare.startsWith('ai.') || bare.startsWith('pi.');
        const isAbandonedKey = bare.startsWith('summary.') || bare === 'ai.providerProfiles';
        if (isAiOrPiKey && !isAbandonedKey) {
          // 迁移到 pi 库（ai.* 重命名为 pi.*）
          piOptions.piPersistence?.set(`settings:${migratedKey}`, value);
          persistence.delete?.(`settings:${bare}`);
          this.entries.set(migratedKey, value);
        } else if (isAbandonedKey) {
          // 废弃键：仅从主库删除
          persistence.delete?.(`settings:${bare}`);
        }
      }
    }

    // 4. 启动敏感键预加载：从对应 secretStore 读取已保存的 apiKey 覆盖默认值。
    //    secretStore.get 为 async（内部为同步 fs I/O，Promise 当轮结算），
    //    消费者在读取敏感键前应 await ensureSecretsLoaded() 避免读到 undefined。
    if (secretStore || piOptions?.piSecretStore) {
      this.secretPreload = this.preloadSecrets(secretStore, piOptions?.piSecretStore);
    }
  }

  /**
   * settings key → SecretStore name 映射。
   *
   * ST6 决策（secret-store.ts VALID_NAME_PATTERN）要求 name 仅含字母数字/下划线/
   * 连字符/斜杠——settings key 中的点号（如 pi.apiKey）不合法，否则读写抛
   * "Invalid secret name" 导致 apiKey 无法落盘（2026-08-14 修复）。
   * 约定：`settings/<key 点转下划线>`，settings/ 前缀做命名空间隔离。
   */
  private secretNameFor(key: string): string {
    return `settings/${key.replace(/\./g, '_')}`;
  }

  /**
   * 敏感键值在 set 时被写入 secretStore，读取时还原。
   * 当前所有 SECRET_KEYS 均为字符串（pi.apiKey），直接返回。
   */
  private parseSecretValue(_key: string, value: string): unknown {
    return value;
  }

  /** 从对应 secretStore 加载全部敏感键到内存 entries。 */
  private async preloadSecrets(
    secretStore?: SecretStore,
    piSecretStore?: SecretStore,
  ): Promise<void> {
    for (const key of SECRET_KEYS) {
      // SECRET_KEYS 均为 pi 键：优先 pi 密钥存储，未注入时回退主存储（向后兼容）
      const store = piSecretStore ?? secretStore;
      if (!store) continue;
      try {
        const value = await store.get(this.secretNameFor(key));
        if (value !== null) {
          this.entries.set(key, this.parseSecretValue(key, value));
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
   * pi.apiKey 前调用，避免启动早期读到未加载的 undefined。
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
    // 持久化（同步写入）：pi 键（pi.*）优先 pi 库，未注入时回退主库
    // （DD1 决策 + 向后兼容）；其余键始终走主库。
    const store = isPiSettingKey(key) ? (this.piPersistence ?? this.persistence) : this.persistence;
    const secretStore = isPiSettingKey(key)
      ? (this.piSecretStore ?? this.secretStore)
      : this.secretStore;
    if (store) {
      if (secretStore && SECRET_KEYS.has(key)) {
        // 敏感键：写入 safeStorage 加密存储，不落明文 SQLite；同时删除旧的明文条目（迁移）。
        // secretStore.set 内部为同步 fs I/O（async 包装，当轮结算），fire-and-forget 安全。
        const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        void secretStore.set(this.secretNameFor(key), raw).catch((err) => {
          log.error('failed to persist secret setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        store.delete?.(`settings:${key}`);
      } else {
        try {
          store.set(`settings:${key}`, value);
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
      const store = isPiSettingKey(key)
        ? (this.piPersistence ?? this.persistence)
        : this.persistence;
      const secretStore = isPiSettingKey(key)
        ? (this.piSecretStore ?? this.secretStore)
        : this.secretStore;
      if (store?.delete) {
        try {
          store.delete(`settings:${key}`);
        } catch (err) {
          log.error('failed to delete persisted setting', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // 敏感键同步从加密存储删除
      if (secretStore && SECRET_KEYS.has(key)) {
        void secretStore.delete(this.secretNameFor(key)).catch((err) => {
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

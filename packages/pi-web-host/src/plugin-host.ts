/**
 * pi-web-host · 插件 host 对象 + 副作用栈（阶段 4：LLM + 存储持久化）
 *
 * host 对象是插件与宿主交互的唯一接口。
 * 阶段 2：registerAgentTool / registerCommand / storage / fs / notify / log
 * 阶段 3：权限检查（canUse）
 * 阶段 4：LLM 调用 / KV 存储持久化 / 定时任务占位
 */

import { canUse } from './plugin-permissions';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** LLM 提供回调（由 server.ts 注入 streamSimple） */
export type LlmProvider = (req: {
  prompt: string;
  system?: string;
}) => Promise<{ ok: boolean; text?: string; error?: string }>;

/**
 * Host 上下文（阶段 5a：A+B 类 host 方法补全）。
 * 由 server.ts 在连接时构造，传入路径、会话状态与桥接回调。
 */
export interface HostContext {
  /** agent 数据目录（会话/插件/存储根） */
  readonly agentDir?: string;
  /** 当前工作目录 */
  readonly cwd?: string;
  /** 当前会话 ID */
  readonly conversationId?: string;
  /** 当前消息计数 */
  readonly messageCount?: number;
  /** B 类：返回 provider 列表（桥接 agent-bridge getProviderList） */
  readonly getProviderList?: () => readonly string[];
  /** B 类：列出会话（桥接 session-store listSessions） */
  readonly listConversations?: () => Promise<
    readonly { readonly id: string; readonly firstMessage: string; readonly messageCount: number }[]
  >;
  /** B 类：切换会话（桥接 server switch_session） */
  readonly openSession?: (id: string) => Promise<void>;
  /** B 类：steer 消息（桥接 agent） */
  readonly steer?: (text: string) => void;
  /** B 类：中止当前轮（桥接 agent.abort） */
  readonly abortRun?: () => void;
  /** D 类：广播到所有 WS 连接（server.ts 注入） */
  readonly broadcast?: (msg: unknown) => void;
  /** D 类：定向发送到指定客户端 */
  readonly sendTo?: (clientId: string, msg: unknown) => void;
  /** D 类：项目信息 */
  readonly project?: { readonly name: string; readonly root: string };
}

/** 可逆副作用栈：插件注册的一切都登记，反激活时逆序回卷 */
export class PluginEffectStack {
  private cleanups: (() => void)[] = [];

  add(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  release(): void {
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      try {
        cleanup?.();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

/** 插件注册的 AI 工具 */
export interface PluginTool {
  name: string;
  description: string;
  label?: string;
  execute: (params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/** 插件注册的斜杠命令 */
export interface PluginCommand {
  name: string;
  description: string;
  execute: (args: string) => Promise<string>;
}

/** 已激活插件实例 */
export interface LoadedPlugin {
  id: string;
  name: string;
  effects: PluginEffectStack;
  tools: Map<string, PluginTool>;
  commands: Map<string, PluginCommand>;
  /** C 类：向该插件已注册的回调分发事件（server.ts 调用） */
  dispatchEvent?: (event: string, data: unknown) => void;
  deactivate?: () => void;
}

// 插件 KV 存储（内存态，阶段 4 改为持久化）
const pluginStorage = new Map<string, unknown>();

/** 构建简化 host 对象（插件通过 host 访问宿主能力） */
export function createPluginHost(
  pluginId: string,
  effects: PluginEffectStack,
  tools: Map<string, PluginTool>,
  commands: Map<string, PluginCommand>,
  caps: { families: Set<string>; apiVersion: number; netAllowlist: string[] },
  llmProvider?: LlmProvider,
  hostContext?: HostContext,
): Record<string, unknown> {
  const ctxCwd = hostContext?.cwd ?? process.cwd();
  const ctxAgentDir = hostContext?.agentDir;

  // C 类回调表（on* 注册，dispatchEvent 分发，effects 自动清理）
  const eventCallbacks = new Map<string, Set<(data: unknown) => void>>();
  function registerCallback(event: string, cb: (data: unknown) => void): void {
    if (!eventCallbacks.has(event)) eventCallbacks.set(event, new Set());
    eventCallbacks.get(event)!.add(cb);
    effects.add(() => eventCallbacks.get(event)?.delete(cb));
  }
  const dispatchEvent = (event: string, data: unknown): void => {
    eventCallbacks.get(event)?.forEach((cb) => {
      try {
        cb(data);
      } catch {
        /* ignore callback errors */
      }
    });
  };
  return {
    // ── 工具注册（需 tools 权限） ──
    registerAgentTool(tool: PluginTool): void {
      if (!canUse(caps, 'tools')) return;
      if (!tool.name || !tool.description || typeof tool.execute !== 'function') return;
      tools.set(tool.name, tool);
      effects.add(() => tools.delete(tool.name));
    },

    registerTool(tool: {
      name: string;
      description: string;
      exec: (args: unknown) => Promise<unknown>;
    }): void {
      if (!tool.name || typeof tool.exec !== 'function') return;
      const adapted: PluginTool = {
        name: tool.name,
        description: tool.description,
        execute: (params: unknown) => tool.exec(params),
      };
      tools.set(tool.name, adapted);
      effects.add(() => tools.delete(tool.name));
    },

    // ── 命令注册 ──
    registerCommand(cmd: PluginCommand): void {
      if (!cmd.name || typeof cmd.execute !== 'function') return;
      commands.set(cmd.name, cmd);
      effects.add(() => commands.delete(cmd.name));
    },

    // ── KV 存储（需 storage 权限） ──
    storage: {
      get(key: string): unknown {
        if (!canUse(caps, 'storage')) return undefined;
        return pluginStorage.get(`${pluginId}:${key}`);
      },
      set(key: string, value: unknown): void {
        if (!canUse(caps, 'storage')) return;
        pluginStorage.set(`${pluginId}:${key}`, value);
      },
      delete(key: string): void {
        if (!canUse(caps, 'storage')) return;
        pluginStorage.delete(`${pluginId}:${key}`);
      },
    },

    // ── 文件系统（需 fs:read 权限，实际实现） ──
    fs: {
      async readFile(filePath: string): Promise<string> {
        if (!canUse(caps, 'fs:read')) return '';
        try {
          return await readFile(filePath, 'utf8');
        } catch {
          return '';
        }
      },
      async readdir(dirPath: string): Promise<string[]> {
        if (!canUse(caps, 'fs:read')) return [];
        try {
          return await readdir(dirPath);
        } catch {
          return [];
        }
      },
    },

    // ── 通知 ──
    notify(notification: { title: string; body?: string }): void {
      console.log(`[plugin:${pluginId}] ${notification.title}: ${notification.body ?? ''}`);
    },

    // ── 日志 ──
    log(level: string, message: string): void {
      console.log(`[plugin:${pluginId}:${level}] ${message}`);
    },

    // ── 插件元信息 ──
    pluginId,

    // ── LLM 调用（需 llm 权限，由 server.ts 注入 streamSimple） ──
    llm: {
      async complete(req: {
        prompt: string;
        system?: string;
      }): Promise<{ ok: boolean; text?: string; error?: string }> {
        if (!canUse(caps, 'llm')) {
          return { ok: false, error: 'llm permission not granted' };
        }
        if (!llmProvider) {
          return { ok: false, error: 'llm provider not configured' };
        }
        const promptText = req.prompt ?? '';
        if (promptText.length > 8000) {
          return { ok: false, error: 'prompt exceeds 8000 chars' };
        }
        return llmProvider(req);
      },
    },
    // ── 网络请求（需 net 权限，实际实现） ──
    net: {
      async fetch(url: string): Promise<{ ok: boolean; status: number; body?: string }> {
        if (!canUse(caps, 'net')) return { ok: false, status: 0 };
        try {
          const response = await globalThis.fetch(url);
          const body = await response.text();
          return { ok: true, status: response.status, body: body.slice(0, 100000) };
        } catch (e) {
          return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    // ── 定时任务（需 tools 权限，setInterval 实现） ──
    registerSchedule(name: string, intervalMs: number, callback: () => void): void {
      if (!canUse(caps, 'tools')) return;
      const timer = setInterval(() => {
        try {
          callback();
        } catch {
          /* ignore schedule errors */
        }
      }, intervalMs);
      effects.add(() => clearInterval(timer));
    },
    reloadCatalog: (): void => {
      /* 由 server.ts plugins_reload 处理 */
    },

    // ── A 类：路径与状态（阶段 5a） ──
    cwd: ctxCwd,
    agentDir: ctxAgentDir,
    dataDir: ctxAgentDir,
    pluginsDir: ctxAgentDir ? join(ctxAgentDir, 'plugins') : undefined,
    conversationId: hostContext?.conversationId,
    getActiveConversation: () => ({
      id: hostContext?.conversationId ?? '',
      messageCount: hostContext?.messageCount ?? 0,
    }),

    // ── A 类：execCommand（需 tools 权限，child_process.execFile） ──
    execCommand: (
      cmd: string,
      args: string[] = [],
      opts?: { cwd?: string; timeout?: number },
    ): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }> => {
      if (!canUse(caps, 'tools')) {
        return Promise.resolve({ ok: false, error: 'permission denied' });
      }
      return new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { cwd: opts?.cwd ?? ctxCwd, timeout: opts?.timeout ?? 5000, maxBuffer: 1024 * 512 },
          (err, stdout, stderr) => {
            if (err) {
              resolve({ ok: false, error: err.message, stdout, stderr });
            } else {
              resolve({ ok: true, stdout, stderr });
            }
          },
        );
      });
    },

    // ── A 类：watch（需 fs:read 权限，fs.watch + effects 自动清理） ──
    watch: (path: string, callback: (event: string, filename: string | null) => void): void => {
      if (!canUse(caps, 'fs:read')) return;
      try {
        const watcher = fsWatch(path, { recursive: false }, (event, filename) => {
          callback(event, filename ?? null);
        });
        effects.add(() => watcher.close());
      } catch {
        /* 路径不存在或不可监听 */
      }
    },

    // ── A 类：glob（需 fs:read 权限，简化通配符匹配） ──
    glob: async (pattern: string, baseDir?: string): Promise<string[]> => {
      if (!canUse(caps, 'fs:read')) return [];
      const dir = baseDir ?? ctxCwd;
      const regex = new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
      try {
        const entries = await readdir(dir);
        return entries.filter((e) => regex.test(e));
      } catch {
        return [];
      }
    },

    // ── A 类：ensureDeps（检查 npm 包是否可达） ──
    ensureDeps: (deps: readonly string[]): { name: string; installed: boolean }[] => {
      return deps.map((d) => {
        const pkgPath = ctxAgentDir
          ? join(ctxAgentDir, 'node_modules', d)
          : join(process.cwd(), 'node_modules', d);
        return { name: d, installed: existsSync(pkgPath) };
      });
    },

    // ── B 类：scm（桥接 git-ops，需 fs:read 权限） ──
    scm: {
      async status() {
        if (!canUse(caps, 'fs:read')) return { ok: false, error: 'permission denied' };
        const { getGitStatus } = await import('./git-ops');
        return getGitStatus(ctxCwd);
      },
      async history() {
        if (!canUse(caps, 'fs:read')) return { ok: false, error: 'permission denied' };
        const { getGitHistory } = await import('./git-ops');
        return getGitHistory(ctxCwd);
      },
    },

    // ── B 类：models（桥接 agent-bridge getProviderList） ──
    models: {
      list: (): readonly string[] => {
        if (hostContext?.getProviderList) return hostContext.getProviderList();
        return [];
      },
    },

    // ── B 类：conversations（桥接 session-store） ──
    conversations: {
      list: async (): Promise<
        readonly {
          readonly id: string;
          readonly firstMessage: string;
          readonly messageCount: number;
        }[]
      > => {
        if (hostContext?.listConversations) return hostContext.listConversations();
        return [];
      },
      open: async (id: string): Promise<void> => {
        if (hostContext?.openSession) await hostContext.openSession(id);
      },
      current: (): { id: string; messageCount: number } => ({
        id: hostContext?.conversationId ?? '',
        messageCount: hostContext?.messageCount ?? 0,
      }),
    },

    // ── B 类：steer / abortRun（桥接 agent） ──
    steer: (text: string): void => {
      hostContext?.steer?.(text);
    },
    abortRun: (): void => {
      hostContext?.abortRun?.();
    },

    // ── C 类：回调注册（阶段 5b） ──
    // 插件通过 on* 注册回调；server.ts 通过 dispatchEvent 分发事件。
    // 回调登记在 effects stack 中，反激活时自动移除。
    onMessage: (cb: (data: unknown) => void): void => registerCallback('message', cb),
    onRunEvent: (cb: (data: unknown) => void): void => registerCallback('runEvent', cb),
    onStreaming: (cb: (data: unknown) => void): void => registerCallback('streaming', cb),
    onStats: (cb: (data: unknown) => void): void => registerCallback('stats', cb),
    onToolPre: (cb: (data: unknown) => void): void => registerCallback('toolPre', cb),
    onToolPost: (cb: (data: unknown) => void): void => registerCallback('toolPost', cb),
    onConversationChanged: (cb: (data: unknown) => void): void =>
      registerCallback('conversationChanged', cb),
    onCwdChange: (cb: (data: unknown) => void): void => registerCallback('cwdChange', cb),
    onSettingsChanged: (cb: (data: unknown) => void): void =>
      registerCallback('settingsChanged', cb),
    onClientModelChanged: (cb: (data: unknown) => void): void =>
      registerCallback('clientModelChanged', cb),

    // 内部：供 activatePlugin 提取到 LoadedPlugin.dispatchEvent
    _dispatchEvent: dispatchEvent,

    // ── D 类：插件间通信（阶段 5c） ──
    broadcast: (msg: unknown): void => {
      hostContext?.broadcast?.(msg);
    },
    sendTo: (clientId: string, msg: unknown): void => {
      hostContext?.sendTo?.(clientId, msg);
    },
    // 事件总线：插件可 emit/on 自定义事件（独立于 C 类宿主事件）
    events: {
      on: (event: string, cb: (data: unknown) => void): void => {
        registerCallback(`bus:${event}`, cb);
      },
      emit: (event: string, data: unknown): void => {
        dispatchEvent(`bus:${event}`, data);
      },
    },
    // 项目信息
    project: hostContext?.project ?? { name: 'pi-web-host', root: ctxCwd },

    // ── D 类：高级功能（阶段 5d，按需实现） ──
    // 后台任务：注册后自动 start，反激活时 stop
    registerBackgroundTask: (task: {
      name: string;
      start?: () => void;
      stop?: () => void;
    }): void => {
      try {
        task.start?.();
      } catch {
        /* ignore start errors */
      }
      effects.add(() => {
        try {
          task.stop?.();
        } catch {
          /* ignore stop errors */
        }
      });
    },

    // 内联标记：简化实现（记录到 effects，反激活时移除）
    registerMarker: (name: string): void => {
      void name;
      effects.add(() => {
        /* marker removed */
      });
    },

    // 动态权限请求：简化为检查 manifest caps（真实实现需前端弹窗交互）
    requestPermission: (req: {
      family: string;
      detail?: string;
    }): Promise<{ granted: boolean; reason?: string }> => {
      if (canUse(caps, req.family)) {
        return Promise.resolve({ granted: true });
      }
      return Promise.resolve({
        granted: false,
        reason: `${req.family} permission not in manifest`,
      });
    },

    // HTTP 路由注册：简化实现（server.ts 暂未支持动态路由，记录到 effects）
    route: (path: string, handler: (req: unknown) => unknown): void => {
      void path;
      void handler;
      effects.add(() => {
        /* route removed */
      });
    },
  };
}

/** 清除指定插件的内存存储 */
export function clearPluginStorage(pluginId: string): void {
  const prefix = `${pluginId}:`;
  for (const key of pluginStorage.keys()) {
    if (key.startsWith(prefix)) pluginStorage.delete(key);
  }
}

/** 从文件加载插件存储到内存 */
export async function loadPluginStorage(agentDir: string, pluginId: string): Promise<void> {
  try {
    const raw = await readFile(join(agentDir, 'plugins', pluginId, 'storage.json'), 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      pluginStorage.set(`${pluginId}:${key}`, value);
    }
  } catch {
    /* 文件不存在或损坏，用空存储 */
  }
}

/** 保存插件内存存储到文件 */
export async function savePluginStorage(agentDir: string, pluginId: string): Promise<void> {
  const data: Record<string, unknown> = {};
  const prefix = `${pluginId}:`;
  for (const [key, value] of pluginStorage.entries()) {
    if (key.startsWith(prefix)) {
      data[key.slice(prefix.length)] = value;
    }
  }
  try {
    const pluginDir = join(agentDir, 'plugins', pluginId);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'storage.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 写入失败不阻塞反激活 */
  }
}

/**
 * pi-web-host · 插件 host 对象 + 副作用栈（阶段 2：激活 + 工具注册）
 *
 * host 对象是插件与宿主交互的唯一接口。阶段 2 实现核心 ~15 方法：
 * registerAgentTool / registerTool / registerCommand / storage / fs / notify / log
 * 后续阶段逐步补全（llm / net / dom / secrets / schedule ...）
 */

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
): Record<string, unknown> {
  return {
    // ── 工具注册 ──
    registerAgentTool(tool: PluginTool): void {
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

    // ── KV 存储（内存态） ──
    storage: {
      get(key: string): unknown {
        return pluginStorage.get(`${pluginId}:${key}`);
      },
      set(key: string, value: unknown): void {
        pluginStorage.set(`${pluginId}:${key}`, value);
      },
      delete(key: string): void {
        pluginStorage.delete(`${pluginId}:${key}`);
      },
    },

    // ── 文件系统（简化：阶段 3 添加权限检查） ──
    fs: {
      readFile(): Promise<string> {
        return Promise.resolve('');
      },
      readdir(): Promise<string[]> {
        return Promise.resolve([]);
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

    // ── 占位方法（阶段 4 实现） ──
    llm: {
      complete(): Promise<{ ok: boolean; text?: string; error?: string }> {
        return Promise.resolve({ ok: false, error: 'llm not implemented in this phase' });
      },
    },
    net: {
      fetch(): Promise<{ ok: boolean; status: number; body?: string }> {
        return Promise.resolve({ ok: false, status: 0 });
      },
    },
    reloadCatalog: (): void => {
      /* 阶段 4 */
    },
  };
}

/** 清除指定插件的存储 */
export function clearPluginStorage(pluginId: string): void {
  const prefix = `${pluginId}:`;
  for (const key of pluginStorage.keys()) {
    if (key.startsWith(prefix)) pluginStorage.delete(key);
  }
}

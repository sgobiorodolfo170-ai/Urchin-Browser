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
import { join } from 'node:path';

/** LLM 提供回调（由 server.ts 注入 streamSimple） */
export type LlmProvider = (req: {
  prompt: string;
  system?: string;
}) => Promise<{ ok: boolean; text?: string; error?: string }>;

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
  caps: { families: Set<string>; apiVersion: number; netAllowlist: string[] },
  llmProvider?: LlmProvider,
): Record<string, unknown> {
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

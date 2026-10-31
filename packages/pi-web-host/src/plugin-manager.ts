/**
 * pi-web-host · 插件管理器（阶段 1：基础框架）
 *
 * 插件 = <agentDir>/plugins/<id>/ 目录（manifest.json + index.mjs + client/）
 * 本阶段实现：扫描 / 列表 / catalog / 安装 / 卸载 / 启用 / 禁用
 * 后续阶段实现：激活 / host 对象 / 工具注册 / 权限系统
 */
import { readdir, readFile, stat, mkdir, rm, writeFile } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import {
  createPluginHost,
  PluginEffectStack,
  clearPluginStorage,
  loadPluginStorage,
  savePluginStorage,
  type LoadedPlugin,
  type PluginTool,
  type LlmProvider,
  type HostContext,
} from './plugin-host';
import { validatePluginManifest, extractCapabilities } from './plugin-permissions';

const execFileAsync = promisify(execFile);

const ID_RE = /^[A-Za-z0-9_-]+$/;
const PLUGINS_DIR = 'plugins';
const CATALOG_FILE = 'plugin-catalog.json';

export interface UiPluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  hasClient: boolean;
  icon?: string;
  iconSvg?: string;
  error?: string;
  active?: boolean;
  permissions?: string[];
  netAllowlist?: string[];
  builtin?: boolean;
}

export interface UiPluginCatalogEntry {
  id: string;
  name: string;
  nameEn?: string;
  description?: string;
  descriptionEn?: string;
  icon?: string;
  iconSvg?: string;
  source: string;
  builtin?: boolean;
}

interface PluginManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  icon?: string;
  iconSvg?: string;
  permissions?: string[];
  netAllowlist?: string[];
  engines?: Record<string, string>;
  peerPlugins?: string[];
}

function getPluginsDir(agentDir: string): string {
  return join(agentDir, PLUGINS_DIR);
}

function getCatalogPath(agentDir: string): string {
  return join(agentDir, CATALOG_FILE);
}

/** 扫描插件目录，返回所有已安装插件信息 */
export async function scanPlugins(agentDir: string): Promise<UiPluginInfo[]> {
  const pluginsDir = getPluginsDir(agentDir);
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const plugins: UiPluginInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!ID_RE.test(id)) continue;

    const pluginDir = join(pluginsDir, id);
    const manifestPath = join(pluginDir, 'manifest.json');
    const clientDir = join(pluginDir, 'client');

    let manifest: PluginManifest = {};
    let error: string | undefined;

    try {
      const raw = await readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw) as PluginManifest;
    } catch {
      error = 'manifest.json missing or invalid';
    }

    let hasClient = false;
    try {
      await stat(join(clientDir, 'entry.mjs'));
      hasClient = true;
    } catch {
      /* no client */
    }

    plugins.push({
      id,
      name: manifest.name ?? id,
      version: manifest.version,
      description: manifest.description,
      homepage: manifest.homepage,
      hasClient,
      icon: manifest.icon,
      iconSvg: manifest.iconSvg,
      error,
      active: false,
      permissions: manifest.permissions,
      netAllowlist: manifest.netAllowlist,
      builtin: false,
    });
  }

  return plugins;
}

/** 读取插件 catalog（builtin + custom 两层合并） */
export async function readCatalog(
  agentDir: string,
  builtinCatalog?: UiPluginCatalogEntry[],
): Promise<UiPluginCatalogEntry[]> {
  const entries: UiPluginCatalogEntry[] = [];

  if (builtinCatalog && builtinCatalog.length > 0) {
    entries.push(...builtinCatalog);
  }

  try {
    const raw = await readFile(getCatalogPath(agentDir), 'utf8');
    const custom = JSON.parse(raw) as UiPluginCatalogEntry[];
    for (const entry of custom) {
      if (!entries.some((e) => e.id === entry.id)) {
        entries.push({ ...entry, builtin: false });
      }
    }
  } catch {
    /* no custom catalog */
  }

  return entries;
}

/** 添加 catalog 条目 */
export async function addCatalogEntry(
  agentDir: string,
  entry: UiPluginCatalogEntry,
): Promise<void> {
  const catalog = await readCatalog(agentDir);
  const idx = catalog.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    catalog[idx] = entry;
  } else {
    catalog.push(entry);
  }
  await mkdir(agentDir, { recursive: true });
  await writeFile(getCatalogPath(agentDir), JSON.stringify(catalog, null, 2), 'utf8');
}

/** 删除 catalog 条目 */
export async function removeCatalogEntry(agentDir: string, id: string): Promise<void> {
  const catalog = await readCatalog(agentDir);
  const filtered = catalog.filter((e) => e.id !== id || e.builtin);
  await writeFile(getCatalogPath(agentDir), JSON.stringify(filtered, null, 2), 'utf8');
}

/** 解析安装来源 */
export function parseInstallSpec(source: string): {
  kind: 'npm' | 'github' | 'url' | 'path' | 'invalid';
  pkg?: string;
  repo?: string;
  ref?: string;
} {
  const s = source.trim();
  if (!s) return { kind: 'invalid' };

  if (/^https?:\/\//.test(s)) {
    return { kind: 'url' };
  }

  if (/^@?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(s)) {
    const [repo, ref] = s.split('#');
    const parts = (repo ?? '').split('/');
    if (parts.length >= 2 && !(parts[0] ?? '').startsWith('@')) {
      return { kind: 'github', repo, ref };
    }
  }

  if (/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(@\d+\.\d+\.\d+[\w.-]*)?$/.test(s)) {
    return { kind: 'npm', pkg: s };
  }

  if (isAbsolute(s)) {
    return { kind: 'path' };
  }

  return { kind: 'invalid' };
}

/** 安装插件 */
export async function installPlugin(
  agentDir: string,
  source: string,
  pluginId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!ID_RE.test(pluginId)) {
    return { ok: false, error: 'invalid plugin id' };
  }

  const pluginsDir = getPluginsDir(agentDir);
  const targetDir = join(pluginsDir, pluginId);
  const spec = parseInstallSpec(source);

  try {
    await mkdir(pluginsDir, { recursive: true });

    switch (spec.kind) {
      case 'npm': {
        const tmpDir = join(tmpdir(), `pi-plugin-${pluginId}-${Date.now()}`);
        await mkdir(tmpDir, { recursive: true });
        const pkgName = spec.pkg ?? source;
        const { stdout } = await execFileAsync(
          'npm',
          ['pack', pkgName, '--pack-destination', tmpDir],
          { timeout: 60000 },
        );
        const tgzName = stdout.trim().split('\n').pop();
        if (!tgzName) return { ok: false, error: 'npm pack returned no file' };
        const tgzPath = join(tmpDir, tgzName);
        await execFileAsync('tar', ['-xzf', tgzPath, '-C', tmpDir], { timeout: 30000 });
        const packageDir = join(tmpDir, 'package');
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });
        await copyDir(packageDir, targetDir);
        await rm(tmpDir, { recursive: true, force: true });
        return { ok: true };
      }
      case 'github': {
        const tmpDir = join(tmpdir(), `pi-plugin-${pluginId}-${Date.now()}`);
        const cloneArgs = ['clone', '--depth', '1'];
        if (spec.ref) cloneArgs.push('--branch', spec.ref);
        cloneArgs.push(`https://github.com/${spec.repo ?? ''}`, tmpDir);
        await execFileAsync('git', cloneArgs, { timeout: 120000 });
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });
        await copyDir(tmpDir, targetDir);
        await rm(tmpDir, { recursive: true, force: true });
        return { ok: true };
      }
      case 'path': {
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });
        await copyDir(source, targetDir);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unsupported source: ${spec.kind}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 卸载插件 */
export async function uninstallPlugin(agentDir: string, pluginId: string): Promise<void> {
  const pluginsDir = getPluginsDir(agentDir);
  await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    }
  }
}

// ── 阶段 2：激活 / 反激活 / 工具收集 ──

const loadedPlugins = new Map<string, LoadedPlugin>();

/** 动态加载插件入口文件（支持 ESM .mjs 和 CJS .js） */
async function loadPluginEntry(entryPath: string): Promise<{ default?: unknown }> {
  const url = pathToFileURL(entryPath).href;
  return (await import(url)) as { default?: unknown };
}

/** 激活插件 */
export async function activatePlugin(
  agentDir: string,
  pluginId: string,
  llmProvider?: LlmProvider,
  hostContext?: HostContext,
): Promise<{ ok: boolean; error?: string }> {
  if (loadedPlugins.has(pluginId)) {
    return { ok: true };
  }

  const pluginsDir = getPluginsDir(agentDir);
  const pluginDir = join(pluginsDir, pluginId);
  const entryPath = join(pluginDir, 'index.mjs');

  let hasEntry = false;
  try {
    await stat(entryPath);
    hasEntry = true;
  } catch {
    /* no entry → 纯静态插件，不需要激活 */
  }

  if (!hasEntry) {
    return { ok: true };
  }

  try {
    // 校验 manifest
    const manifestPath = join(pluginDir, 'manifest.json');
    let manifest: { permissions?: string[]; apiVersion?: number; netAllowlist?: string[] } = {};
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest;
    } catch {
      return { ok: false, error: 'manifest.json missing or invalid' };
    }
    const validation = validatePluginManifest(manifest);
    if (validation.errors.length > 0) {
      return { ok: false, error: validation.errors.join('; ') };
    }

    const caps = extractCapabilities(manifest);
    await loadPluginStorage(agentDir, pluginId);
    const effects = new PluginEffectStack();
    const tools = new Map<string, PluginTool>();
    const commands = new Map<
      string,
      LoadedPlugin['commands'] extends Map<string, infer V> ? V : never
    >();
    const host = createPluginHost(
      pluginId,
      effects,
      tools,
      commands,
      caps,
      llmProvider,
      hostContext,
    );

    const mod = await loadPluginEntry(entryPath);
    const activateFn = mod.default as
      { activate?: (host: unknown) => unknown } | ((host: unknown) => unknown) | undefined;

    let deactivate: (() => void) | undefined;

    if (typeof activateFn === 'function') {
      const ret = await activateFn(host);
      if (typeof ret === 'function') {
        deactivate = ret as () => void;
      }
    } else if (
      activateFn &&
      typeof activateFn === 'object' &&
      typeof activateFn.activate === 'function'
    ) {
      const ret = await activateFn.activate(host);
      if (typeof ret === 'function') {
        deactivate = ret as () => void;
      }
    }

    const loaded: LoadedPlugin = {
      id: pluginId,
      name: pluginId,
      effects,
      tools,
      commands: commands,
      deactivate,
    };
    loadedPlugins.set(pluginId, loaded);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 反激活插件 */
export async function deactivatePlugin(agentDir: string, pluginId: string): Promise<void> {
  const plugin = loadedPlugins.get(pluginId);
  if (!plugin) return;

  try {
    plugin.deactivate?.();
  } catch {
    /* ignore */
  }

  plugin.effects.release();
  loadedPlugins.delete(pluginId);
  await savePluginStorage(agentDir, pluginId);
  clearPluginStorage(pluginId);
}

/** 反激活所有插件 */
export async function deactivateAllPlugins(agentDir: string): Promise<void> {
  for (const id of loadedPlugins.keys()) {
    await deactivatePlugin(agentDir, id);
  }
}

/** 获取所有已激活插件注册的 AI 工具 */
export function getActivePluginTools(): PluginTool[] {
  const allTools: PluginTool[] = [];
  for (const plugin of loadedPlugins.values()) {
    for (const tool of plugin.tools.values()) {
      allTools.push(tool);
    }
  }
  return allTools;
}

/** 获取所有已激活插件 ID */
export function getActivePluginIds(): string[] {
  return Array.from(loadedPlugins.keys());
}

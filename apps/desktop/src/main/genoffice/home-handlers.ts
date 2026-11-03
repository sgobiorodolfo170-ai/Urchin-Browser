/**
 * GenOffice Home 宿主适配（阶段 4.6，用户指令）
 *
 * 背景：左侧栏文档入口改为**直接使用 GenOffice 原项目的 shell Home 前端**
 * （apps/shell/src/renderer）。该页由 GenOffice 自己的 preload 提供
 * `window.aiOffice`，宿主侧原本有 60+ 个 `home:*` 通道；嵌入 Urchin 后由本
 * 模块实现其中的可用子集（打开/最近/星标/文件夹/新建/主题/语言/AI 设置），
 * 账号、云项目、MCP、更新、集成等 GenOffice 云/壳能力以中性桩返回，保证
 * Home 完整渲染且不报错（首期范围见 CHANGELOG dev.97）。
 *
 * 通道设计：单一 `genoffice:home` invoke（`{ method, args }`）+ 单一
 * `genoffice:home:event` 推送（folderChanged），宿主 preload 负责映射成
 * `window.aiOffice` 的形状——避免为上游 60+ 通道逐个建 IPC。
 */
import type { IpcMain } from 'electron';
import { app, clipboard, dialog, shell, webContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, relative } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@urchin/logger';
import { classifyFileKind } from '../files/file-kind';
import type { GenOfficeAiPanelPrefsStore } from './host-channels';
import type { GenOfficeEmbedApi } from './loader';
import type { GenOfficeHomeStore } from './home-store';

const log = createLogger('genoffice-home');

/** Home 文件列表可展示的类型（binary 不列）。 */
function isListableFile(name: string): boolean {
  return classifyFileKind(name) !== 'binary';
}

/** 取字符串参数（Home 的 invoke 参数为 unknown：非字符串一律回落默认值）。 */
function strArg(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 文件/文件夹名合法性校验（防路径穿越）：拒绝空、`.`/`..`、含路径分隔符的名字。
 * Home 的改名/新建输入框只接受纯名字；宿主侧再兜一道，避免「改名」变「移动」。
 */
function isPlainName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return false;
  return !/[/\\]/.test(trimmed);
}

/**
 * 校验目标路径是否在指定根目录内（防路径穿越）。
 * 用于 deleteFiles/deleteFolder/movePaths 等破坏性操作的安全兜底。
 */
function isWithinRoot(target: string, root: string): boolean {
  if (!isAbsolute(target) || !isAbsolute(root)) return false;
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** genoffice:home 请求 payload 的 zod schema。 */
const HOME_REQUEST_SCHEMA = z.object({
  method: z.string().min(1),
  args: z.array(z.unknown()).default([]),
});

/** 最近/星标条目（与上游 RecentEntry 形状一致）。 */
interface HomeEntry {
  path: string;
  name: string;
  ext: string;
  mtimeMs: number;
  sizeBytes: number;
  starred: boolean;
  missing?: boolean;
}

interface HomeQuery {
  offset?: number;
  limit?: number;
  ext?: string;
}

export interface GenOfficeHomeDeps {
  readonly ipcMain: IpcMain;
  readonly store: GenOfficeHomeStore;
  /** 文档根目录（Home「文件夹」面板根；<数据目录>/documents）。 */
  readonly documentsRoot: string;
  readonly getTheme: () => string;
  readonly setTheme: (theme: string) => void;
  readonly getVersion: () => string;
  readonly aiPanelPrefs: GenOfficeAiPanelPrefsStore;
  /** 路由打开本地文件（GenOffice 伪地址分流）；返回 true 表示已受理。 */
  readonly openLocalPath: (path: string) => boolean;
  /** 新建空白文档标签（docs/markdown/html）。 */
  readonly openBlankDocument: (kind: 'docs' | 'markdown' | 'html' | 'slides' | 'sheets') => boolean;
  /** 写空白 PDF（vendor pdf-lib）。 */
  readonly writeBlankPdf: (filePath: string) => Promise<void>;
  /** 切换 GenOffice UI 语言（主进程字典 + 原生对话框）。 */
  readonly setLanguage: (lang: string) => void;
  /** GenOffice 嵌入包 API（CL11：删除 md 时触发 assets GC） */
  readonly embedApi?: GenOfficeEmbedApi | null;
}

/** 向所有 GenOffice Home 视图推送事件（folderChanged 等）。 */
function broadcastHomeEvent(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.getURL().startsWith('genoffice-app://shell/')) wc.send(channel, payload);
    } catch {
      /* 已销毁的 webContents：忽略 */
    }
  }
}

/** 取唯一路径（冲突时追加 " (2)"、"(3)"…）。 */
async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(dir, i === 1 ? fileName : `${stem} (${i})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

export function registerGenOfficeHomeHandlers(deps: GenOfficeHomeDeps): void {
  const { ipcMain, store } = deps;
  const starredSet = (): Set<string> => new Set(store.get().starred);

  /** app-settings.json 路径（与编辑器的 configuredDefaultSaveDir 同源读取）。 */
  const appSettingsPath = join(app.getPath('userData'), 'app-settings.json');

  /** 读取 app-settings.json（小文件，同步读）。 */
  function readAppSettings(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(appSettingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** 写入 app-settings.json（合并已有键，不覆盖）。 */
  function writeAppSettings(patch: Record<string, unknown>): void {
    try {
      const current = readAppSettings();
      writeFileSync(appSettingsPath, JSON.stringify({ ...current, ...patch }, null, 2));
    } catch {
      /* 写入失败：编辑器回落到 <Documents>/GenOffice，不影响 Home 侧 */
    }
  }

  /**
   * 默认保存目录：与编辑器 configuredDefaultSaveDir(app) 同源——读 app-settings.json
   * 的 defaultSaveDir 键；未设置时回落到 documentsRoot（<数据目录>/documents）。
   * 启动时由 index.ts 确保该键指向 documentsRoot，保证编辑器与 Home 对齐。
   */
  async function defaultSaveDir(): Promise<string> {
    const settings = readAppSettings();
    const configured =
      typeof settings.defaultSaveDir === 'string' && isAbsolute(settings.defaultSaveDir)
        ? settings.defaultSaveDir
        : deps.documentsRoot;
    await mkdir(configured, { recursive: true }).catch(() => undefined);
    return configured;
  }

  /**
   * 文件夹根（上游 v0.12 Home 的「文件夹」面板支持默认保存目录 + 用户添加的
   * 多个根）。`removable` 区分：默认保存目录不可移除，用户添加的可移除。
   */
  interface HomeFolderRoot {
    path: string;
    name: string;
    usable: boolean;
    readable: boolean;
    removable: boolean;
  }

  /** 探测一个文件夹根：不存在则尝试创建；权限/盘符失效时标记为不可用。 */
  async function folderRootInfo(path: string, removable: boolean): Promise<HomeFolderRoot> {
    let usable = false;
    let readable = false;
    try {
      await mkdir(path, { recursive: true });
      usable = true;
    } catch {
      usable = false;
    }
    try {
      const info = await stat(path);
      readable = info.isDirectory();
      usable = usable || readable;
    } catch {
      readable = false;
    }
    return { path, name: basename(path), usable, readable, removable };
  }

  /** 默认保存目录 + 用户添加的目录（去重，默认根始终在首位）。 */
  async function listFolderRoots(): Promise<HomeFolderRoot[]> {
    await store.load();
    const primary = await defaultSaveDir();
    const roots = [await folderRootInfo(primary, false)];
    const known = new Set([primary]);
    for (const dir of store.get().folderRoots ?? []) {
      if (known.has(dir)) continue;
      known.add(dir);
      roots.push(await folderRootInfo(dir, true));
    }
    return roots;
  }

  async function toEntry(filePath: string): Promise<HomeEntry> {
    const starred = starredSet();
    const name = basename(filePath);
    const ext = extname(name).replace(/^\./, '').toLowerCase();
    try {
      const info = await stat(filePath);
      return {
        path: filePath,
        name,
        ext,
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        starred: starred.has(filePath),
      };
    } catch {
      return {
        path: filePath,
        name,
        ext,
        mtimeMs: 0,
        sizeBytes: 0,
        starred: starred.has(filePath),
        missing: true,
      };
    }
  }

  async function page(paths: readonly string[], query?: HomeQuery): Promise<unknown> {
    const all = await Promise.all(paths.map((p) => toEntry(p)));
    const filtered = query?.ext ? all.filter((e) => e.ext === query.ext) : all;
    const offset = Math.max(0, query?.offset ?? 0);
    const limit = query?.limit ?? 50;
    return {
      entries: limit === 0 ? [] : filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalAll: all.length,
    };
  }

  async function recordAndOpen(filePath: string): Promise<void> {
    await store.recordRecent(filePath);
    deps.openLocalPath(filePath);
  }

  /** 单方法分发（未实现的方法名返回 null，preload 侧方法均为显式枚举）。 */
  async function dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'recents': {
        await store.load();
        return page(store.get().recent, args[0] as HomeQuery | undefined);
      }
      case 'starred': {
        await store.load();
        return page(store.get().starred, args[0] as HomeQuery | undefined);
      }
      case 'statPaths': {
        const paths = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        return Promise.all(paths.map((p) => toEntry(p)));
      }
      case 'toggleStar': {
        await store.toggleStar(strArg(args[0], ''));
        return null;
      }
      case 'unstarPaths': {
        const paths = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        for (const p of paths) {
          if (store.get().starred.includes(p)) await store.toggleStar(p);
        }
        return null;
      }
      case 'removeRecent': {
        await store.removeRecent(Array.isArray(args[0]) ? (args[0] as string[]) : []);
        return null;
      }
      case 'openPath': {
        const target = strArg(args[0], '');
        if (target) await recordAndOpen(target);
        return null;
      }
      case 'browse': {
        const result = await dialog.showOpenDialog({
          title: '打开文件',
          properties: ['openFile', 'multiSelections'],
        });
        if (!result.canceled) {
          for (const filePath of result.filePaths) await recordAndOpen(filePath);
        }
        return null;
      }
      case 'newDoc':
      case 'newMarkdown':
      case 'newHtml':
      case 'newSlide':
      case 'newSheet': {
        const kind =
          method === 'newDoc'
            ? 'docs'
            : method === 'newMarkdown'
              ? 'markdown'
              : method === 'newSlide'
                ? 'slides'
                : method === 'newSheet'
                  ? 'sheets'
                  : 'html';
        deps.openBlankDocument(kind);
        return null;
      }
      case 'newPdf': {
        const dir = await defaultSaveDir();
        const target = await uniquePath(dir, 'untitled.pdf');
        await deps.writeBlankPdf(target);
        await recordAndOpen(target);
        return null;
      }
      case 'revealPath': {
        const target = strArg(args[0], '');
        if (target) shell.showItemInFolder(target);
        return null;
      }
      case 'renameFile': {
        const filePath = strArg(args[0]);
        const newName = strArg(args[1]).trim();
        if (!filePath || !isPlainName(newName)) {
          return { ok: false, error: 'invalid arguments' };
        }
        const target = join(dirname(filePath), newName);
        try {
          await rename(filePath, target);
          await store.rebindPath(filePath, target);
          return { ok: true, path: target };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      case 'duplicateFile': {
        const filePath = strArg(args[0], '');
        if (!filePath) return null;
        const target = await uniquePath(dirname(filePath), basename(filePath));
        await copyFile(filePath, target);
        return null;
      }
      case 'deleteFiles': {
        const paths = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        for (const p of paths) {
          try {
            await shell.trashItem(p);
          } catch (e) {
            log.warn('trash failed', { path: p, error: String(e) });
          }
          // CL11：删除 .md 后触发 assets GC。
          // 传空 imageSources → manifest 删除该 docKey → siblingMarkdownReferences
          // 扫描同目录存活 md → GC 清理不再被引用的独占图片（共享图片保留）。
          if (/\.(?:md|markdown)$/i.test(p) && deps.embedApi?.reconcileOwnedAssets) {
            try {
              await deps.embedApi.reconcileOwnedAssets(p, []);
            } catch {
              // no manifest / no assets dir / read error — nothing to clean
            }
          }
        }
        await store.forgetPaths(paths);
        return null;
      }
      case 'folderRoot': {
        const roots = await listFolderRoots();
        return roots[0];
      }
      case 'folderRoots':
        return listFolderRoots();
      case 'addFolderRoot': {
        const current = await defaultSaveDir();
        const result = await dialog.showOpenDialog({
          title: '添加文件夹',
          defaultPath: current,
          properties: ['openDirectory', 'createDirectory'],
        });
        const selected = result.canceled ? null : (result.filePaths[0] ?? null);
        if (!selected) return null;
        await store.load();
        if (selected !== current) await store.addFolderRoot(selected);
        return folderRootInfo(selected, selected !== current);
      }
      case 'removeFolderRoot': {
        const dir = strArg(args[0], '');
        if (!dir) return null;
        await store.removeFolderRoot(dir);
        return null;
      }
      case 'dropFolderRoots': {
        const paths = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        const primary = await defaultSaveDir();
        const added: HomeFolderRoot[] = [];
        await store.load();
        const known = new Set([primary, ...(store.get().folderRoots ?? [])]);
        for (const dir of paths) {
          if (typeof dir !== 'string' || dir.length === 0 || known.has(dir)) continue;
          try {
            const info = await stat(dir);
            if (!info.isDirectory()) continue;
          } catch {
            continue;
          }
          known.add(dir);
          await store.addFolderRoot(dir);
          added.push(await folderRootInfo(dir, true));
        }
        return added;
      }
      case 'listFolder': {
        const dir = strArg(args[0], deps.documentsRoot);
        try {
          const items = await readdir(dir, { withFileTypes: true });
          const folders: { path: string; name: string; mtimeMs: number; hasSubfolders: boolean }[] =
            [];
          const files: HomeEntry[] = [];
          for (const item of items) {
            const full = join(dir, item.name);
            if (item.isDirectory()) {
              let hasSubfolders = false;
              try {
                const children = await readdir(full, { withFileTypes: true });
                hasSubfolders = children.some((c) => c.isDirectory());
              } catch {
                /* 无权限：视为无子目录 */
              }
              let mtimeMs = 0;
              try {
                mtimeMs = (await stat(full)).mtimeMs;
              } catch {
                /* 忽略 */
              }
              folders.push({ path: full, name: item.name, mtimeMs, hasSubfolders });
            } else if (item.isFile() && isListableFile(item.name)) {
              files.push(await toEntry(full));
            }
          }
          folders.sort((a, b) => a.name.localeCompare(b.name));
          files.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return { dir, folders, files };
        } catch {
          return { dir, folders: [], files: [], missing: true };
        }
      }
      case 'createFolder': {
        const parent = strArg(args[0]);
        const name = strArg(args[1]).trim();
        if (!parent || !isPlainName(name)) return { ok: false, error: 'invalid arguments' };
        const target = join(parent, name);
        try {
          await mkdir(target, { recursive: false });
          return { ok: true, path: target };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      case 'renameFolder': {
        const dir = strArg(args[0]);
        const newName = strArg(args[1]).trim();
        if (!dir || !isPlainName(newName)) return { ok: false, error: 'invalid arguments' };
        const target = join(dirname(dir), newName);
        try {
          await rename(dir, target);
          await store.rebindPath(dir, target);
          broadcastHomeEvent('genoffice:home:event', {
            type: 'folderChanged',
            dirs: [dirname(dir), target],
          });
          return { ok: true, path: target };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      case 'deleteFolder': {
        const dir = strArg(args[0], '');
        if (!dir) return null;
        // 安全兜底：文件夹删除限定在 documentsRoot 子树内
        if (!isWithinRoot(dir, deps.documentsRoot)) {
          log.warn('deleteFolder blocked: path outside documentsRoot', { dir });
          return { ok: false, error: 'PERMISSION: path outside root' };
        }
        try {
          await shell.trashItem(dir);
        } catch (e) {
          log.warn('trash folder failed', { dir, error: String(e) });
        }
        await store.forgetPaths([dir]);
        broadcastHomeEvent('genoffice:home:event', {
          type: 'folderChanged',
          dirs: [dirname(dir)],
        });
        return null;
      }
      case 'movePaths': {
        const paths = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        const targetDir = strArg(args[1], '');
        const policy = strArg(args[2], 'ask');
        const moved: { from: string; to: string }[] = [];
        const conflicts: string[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const from of paths) {
          const candidate = join(targetDir, basename(from));
          let target = candidate;
          try {
            await stat(candidate);
            if (policy === 'replace') {
              await rm(candidate, { recursive: true, force: true });
            } else if (policy === 'skip' || policy === 'ask') {
              conflicts.push(from);
              continue;
            } else {
              target = await uniquePath(targetDir, basename(from));
            }
            await rename(from, target);
            await store.rebindPath(from, target);
            moved.push({ from, to: target });
          } catch (e) {
            failed.push({ path: from, error: String(e) });
          }
        }
        if (moved.length > 0) {
          broadcastHomeEvent('genoffice:home:event', {
            type: 'folderChanged',
            dirs: [targetDir, ...moved.map((m) => dirname(m.from))],
          });
        }
        return { moved, conflicts, failed };
      }
      case 'openTrash':
        return null;
      case 'getLanguage': {
        await store.load();
        return store.get().language ?? 'zh';
      }
      case 'setLanguage': {
        const lang = strArg(args[0]);
        if (!lang) return null;
        await store.setLanguage(lang);
        deps.setLanguage(lang);
        // 广播语言变更（与上游 shell 一致）：编辑器/Home 的 LocaleProvider 据此
        // 实时切换，否则要重载页面才生效。
        for (const wc of webContents.getAllWebContents()) {
          try {
            wc.send('app:language-changed', lang);
          } catch {
            /* 已销毁：忽略 */
          }
        }
        return null;
      }
      case 'getTheme':
        return deps.getTheme();
      case 'setTheme': {
        const theme = strArg(args[0], '');
        if (theme === 'light' || theme === 'dark' || theme === 'system') deps.setTheme(theme);
        return null;
      }
      case 'getAutoSaveDefault':
        return { on: false, updatedAt: 0 };
      case 'setAutoSaveDefault':
        return null;
      case 'getAiPanelPrefs':
        return deps.aiPanelPrefs.get();
      case 'setAiPanelPrefs':
        return deps.aiPanelPrefs.set(args[0]);
      case 'getDefaultSaveDir':
        return defaultSaveDir();
      case 'pickDefaultSaveDir': {
        // 允许用户自定义默认保存位置：弹目录选择器，选中后写入 app-settings.json
        // 的 defaultSaveDir 键（编辑器的 configuredDefaultSaveDir 读同一文件），
        // 取消则返回当前值。默认值由 index.ts 启动时写入（= <数据目录>/documents）。
        const current = await defaultSaveDir();
        const result = await dialog.showOpenDialog({
          title: '选择默认保存位置',
          defaultPath: current,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) {
          return current;
        }
        const selected = result.filePaths[0];
        writeAppSettings({ defaultSaveDir: selected });
        log.info('default save dir changed', { from: current, to: selected });
        return selected;
      }
      case 'getAppVersion':
        return deps.getVersion();
      case 'onboardingSeen':
        return true;
      case 'setOnboardingSeen':
        return true;
      case 'getUpdateChannel':
        return 'stable';
      case 'setUpdateChannel':
        return null;
      case 'getMcpStatus':
      case 'setMcpSettings':
        return {
          running: false,
          enabled: false,
          port: 3093,
          background: false,
          logging: false,
          url: null,
          capabilities: ['docs'],
        };
      case 'getMcpLogs':
        return [];
      case 'clearMcpLogs':
      case 'openMcpLogFile':
        return null;
      case 'getAnalyticsEnabled':
        return false;
      case 'setAnalyticsEnabled':
        // Urchin 不上报任何遥测：回显入参让开关状态自洽（否则 UI 表现为「开关卡住」），
        // 不产生任何实际采集/上报。
        return args[0] === true;
      case 'githubStars':
        return null;
      case 'starPromptShouldShow':
        return { show: false, docOpens: 0 };
      case 'starPromptAction':
        return null;
      case 'openGitHubRepo':
        void shell.openExternal('https://github.com/genspark-ai/genoffice');
        return null;
      case 'integrations.status':
        // 形状对齐上游 IntegrationsStatus：cli.status='missing' 让面板显示
        // 「CLI 不在 PATH」而不是空白/崩溃（Urchin 不随包分发 genoffice CLI）。
        return {
          cli: {
            ok: false,
            installed: false,
            linked: false,
            status: 'missing',
            location: null,
            manual: null,
            version: '',
            launcherDir: '',
            ephemeral: false,
          },
          skillVersion: '',
          skillNeedsCli: '',
          agents: [],
        };
      case 'integrations.installSkill':
      case 'integrations.uninstallSkill':
        return { installed: false, error: 'Urchin 暂不支持集成安装' };
      case 'integrations.pickSkillDir': {
        const result = await dialog.showOpenDialog({
          title: '选择安装目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
      case 'integrations.saveSkillZip':
        return null;
      case 'integrations.copyText': {
        clipboard.writeText(strArg(args[0], ''));
        return null;
      }
      // ── 文件搜索（Phase B：基础文件名匹配；非全文索引） ──
      case 'searchFiles': {
        const query = (args[0] ?? {}) as { q?: string; ext?: string; limit?: number };
        const q = typeof query.q === 'string' ? query.q : '';
        const ext = typeof query.ext === 'string' && query.ext !== 'all' ? query.ext : undefined;
        const limit = Math.min(
          Math.max(typeof query.limit === 'number' ? query.limit : 100, 1),
          200,
        );
        if (!q.trim()) {
          return { hits: [], total: 0, index: { indexed: 0, pending: 0, scanning: false } };
        }
        const needle = q.trim().toLowerCase();
        const root = deps.documentsRoot;
        const hits: HomeEntry[] = [];
        const scan = async (dir: string, depth: number): Promise<void> => {
          if (depth > 5 || hits.length >= limit) return;
          try {
            const items = await readdir(dir, { withFileTypes: true });
            for (const item of items) {
              if (hits.length >= limit) return;
              const full = join(dir, item.name);
              if (item.isDirectory()) {
                await scan(full, depth + 1);
              } else if (item.isFile() && isListableFile(item.name)) {
                const nameLower = item.name.toLowerCase();
                if (
                  nameLower.includes(needle) &&
                  (!ext || extname(item.name).replace(/^\./, '').toLowerCase() === ext)
                ) {
                  hits.push(await toEntry(full));
                }
              }
            }
          } catch {
            /* 无权限或不存在：跳过 */
          }
        };
        await scan(root, 0);
        hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return {
          hits: hits.map((h) => ({ ...h, snippet: null, needles: [needle] })),
          total: hits.length,
          index: { indexed: hits.length, pending: 0, scanning: false },
        };
      }
      case 'rerankSearch':
        // 重排序需要决策模型；宿主不支持，返回 null（Home 回落到本地顺序）
        return null;
      case 'getFileSearchSettings':
        return {
          rerank: false,
          endpoint: 'none',
          keys: {},
          customBaseUrl: '',
          customModel: '',
          cloudflareAccountId: '',
          cloudflareModel: '',
        };
      case 'setFileSearchSettings':
        return {
          rerank: false,
          endpoint: 'none',
          keys: {},
          customBaseUrl: '',
          customModel: '',
          cloudflareAccountId: '',
          cloudflareModel: '',
        };
      case 'testFileSearchRerank':
        return { ok: false, error: 'not supported' };
      case 'setStarredGroup':
        // 星标分组：宿主暂不支持分组，静默成功
        return { ok: true };
      // ── 设置面板其余项（返回合理默认值，使面板不空/loading） ──
      case 'getRestoreLastSession':
        return false; // Urchin 有自己的会话恢复
      case 'setRestoreLastSession':
        return false;
      case 'getAutoUpdateCheck':
        return true;
      case 'setAutoUpdateCheck':
        return true;
      case 'getTabSleepEnabled':
        return true;
      case 'setTabSleepEnabled':
        return true;
      case 'getAuthorName':
        return ''; // 空 = 用 OS 用户名
      case 'setAuthorName':
        return '';
      case 'getDocumentTheme':
        return 'light';
      case 'setDocumentTheme':
        return 'light';
      case 'getDefaultAppStatus':
        return { registered: false };
      case 'setDefaultApp':
        return { ok: false, error: 'not supported' };
      case 'getUpdateState':
        return null;
      case 'openUpdateDialog':
        return undefined;
      case 'openHelp':
        return undefined;
      case 'getCustomModels':
        return { models: [], defaultModel: '' };
      default:
        log.warn('unhandled genoffice home method', { method });
        return null;
    }
  }

  ipcMain.handle('genoffice:home', (_event, payload: unknown) => {
    const parsed = HOME_REQUEST_SCHEMA.safeParse(payload ?? {});
    if (!parsed.success) {
      log.warn('genoffice:home invalid payload', { error: parsed.error.message });
      return null;
    }
    const { method, args } = parsed.data;
    return dispatch(method, args);
  });

  log.info('genoffice home handlers registered', { version: app.getVersion() });
}

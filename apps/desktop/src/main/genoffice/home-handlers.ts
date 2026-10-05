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
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createLogger } from '@urchin/logger';
import { classifyFileKind } from '../files/file-kind';
import type { GenOfficeAiPanelPrefsStore } from './host-channels';
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

  /** 默认保存目录（未设置时用文档根）。 */
  async function defaultSaveDir(): Promise<string> {
    await store.load();
    const dir = store.get().defaultSaveDir ?? deps.documentsRoot;
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    return dir;
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
        }
        await store.forgetPaths(paths);
        return null;
      }
      case 'folderRoot': {
        const root = deps.documentsRoot;
        let usable = true;
        try {
          await mkdir(root, { recursive: true });
        } catch {
          usable = false;
        }
        return { path: root, name: basename(root), usable };
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
        const result = await dialog.showOpenDialog({
          title: '选择默认保存位置',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        const dir = result.filePaths[0];
        await store.setDefaultSaveDir(dir);
        broadcastHomeEvent('genoffice:home:event', { type: 'folderChanged', dirs: [dir] });
        return dir;
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
      default:
        log.warn('unhandled genoffice home method', { method });
        return null;
    }
  }

  ipcMain.handle('genoffice:home', (_event, payload: unknown) => {
    const request = (payload ?? {}) as { method?: unknown; args?: unknown };
    const method = typeof request.method === 'string' ? request.method : '';
    const args = Array.isArray(request.args) ? request.args : [];
    return dispatch(method, args);
  });

  log.info('genoffice home handlers registered', { version: app.getVersion() });
}

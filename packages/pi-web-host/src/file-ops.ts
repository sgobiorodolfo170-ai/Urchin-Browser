/**
 * pi-web-host · 文件操作 + 设置存储（第一批扩展）
 *
 * utility 进程有 Node.js fs 访问，直接读写 agentDir 下的文件系统。
 */
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, dirname, extname, relative, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const SETTINGS_FILE = 'settings.json';

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与前端 DirectoryBrowser、全量服务
 *  apps/pi-web/server/files-service.ts 的 MACHINE_ROOT 同值。 */
const MACHINE_ROOT = '@root';

/** 目录选择器隐藏条目：会淹没选择列表/制造噪音的目录与系统垃圾文件。
 *  刻意比文件面板 IGNORED_ENTRIES* 小：项目选择器要看清项目本身
 *  （dist / .venv 等都是合法的工作目录，不藏）。 */
const PICKER_IGNORED = new Set(['node_modules', 'Thumbs.db', 'desktop.ini', '.DS_Store']);

const IS_WIN32 = process.platform === 'win32';

/** 补全条目 wire 形状：path 恒为 "/" 分隔的绝对路径（前端 DirectoryBrowser 直接
 *  把它 setBrowsePath / set_cwd，反斜杠会破坏 browseQuery 的拼接约定）。 */
interface PathCompletion {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

/** 全目录排序：隐藏名（"." 开头）垫底 → 目录在前 → 名称 localeCompare。 */
function sortCompletions(items: PathCompletion[]): PathCompletion[] {
  return items.sort((a, b) => {
    const aHidden = a.name.startsWith('.');
    const bHidden = b.name.startsWith('.');
    if (aHidden !== bHidden) return aHidden ? 1 : -1;
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 机器根（此电脑）目录列表：Windows 枚举 A~Z 已挂载盘符；posix 即根 "/"。
 * 与 files-service.ts 的 machineRootEntries 同语义（那边的 Android/Termux
 * 存储回退不搬 —— 本宿主只跑桌面 Electron，设备形态单一）。
 */
async function machineRootEntries(): Promise<PathCompletion[]> {
  if (IS_WIN32) {
    const out: PathCompletion[] = [];
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:`;
      try {
        const st = await stat(`${drive}\\`);
        if (st.isDirectory()) out.push({ name: drive, path: drive, type: 'dir' });
      } catch {
        // 空口/未挂载盘符 —— 跳过
      }
    }
    return out;
  }
  try {
    await readdir('/');
    return [{ name: '/', path: '/', type: 'dir' }];
  } catch {
    return [];
  }
}

/**
 * cwd 选择器的真目录浏览补全（重构自旧实现）。
 *
 * 为什么重写：旧实现把一切路径经 safePath() 解析在 agentDir 之下 —— 「打开项目」
 * 弹窗的整树浏览（此电脑 → 盘符 → 任意目录）在其上是天然不可见域，绝对路径一律
 * throw('path outside root') 回空列表，弹窗因此死屏（无法打开项目的主要根因）。
 * cwd 选择是**读取**能力（与 list_files 的沙箱写面不同），放开跨 agentDir 读目录
 * 不扩大写面。实现移植自 apps/pi-web/server/files-service.ts 的 completePath
 * （机器根 / 盘符 / ~ 展开 / 混合分隔符切分），并保持 agentDir 相对路径的
 * 回退兼容（插件内部按相对路径补全的调用不受影响）。
 */
async function listPathCompletions(agentDir: string, raw: string): Promise<PathCompletion[]> {
  const input = raw.trim();
  if (!input) return [];

  // ── 机器根（此电脑/盘符列表）──
  if (input === MACHINE_ROOT || input === MACHINE_ROOT + '/') {
    return machineRootEntries();
  }

  // ── Windows 盘符输入："D"（Tab 即补全为 "D:"）/ "D:"（列出盘根）──
  if (IS_WIN32 && /^[A-Za-z]:?$/.test(input)) {
    const drive = `${input[0].toUpperCase()}:`;
    try {
      const st = await stat(`${drive}\\`);
      if (!st.isDirectory()) return [];
    } catch {
      return [];
    }
    if (input.length === 2) {
      const dirents = await readdir(`${drive}\\`, { withFileTypes: true }).catch(() => []);
      return sortCompletions(
        dirents
          .filter((d) => !PICKER_IGNORED.has(d.name))
          .map((d) => ({
            name: d.name,
            path: `${drive}/${d.name}`,
            type: d.isDirectory() ? ('dir' as const) : ('file' as const),
          }))
          .slice(0, 100),
      );
    }
    return [{ name: drive, path: drive, type: 'dir' }];
  }

  // ── ~ 展开（Windows 用户会输 ~\）──
  let expanded = input;
  if (expanded === '~' || expanded === '~\\') {
    expanded = homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = homedir() + sep + expanded.slice(2);
  }
  // ── 相对输入回退 agentDir（老取值语义）；其余全是真绝对路径浏览 ──
  if (!isAbsolute(expanded)) {
    expanded = resolve(agentDir, expanded);
  }

  // ── 按最后出现的分隔符（/ 与 \ 都收）切「父目录 + 前缀」──
  const lastSlash = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf('\\'));
  let dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;
  if (IS_WIN32 && /^[A-Za-z]:$/.test(dirPart)) {
    // 裸盘符 "C:"（无尾分隔）对 readdir 而言是「该盘的当前目录」这种含糊语义，
    // 规范化为盘根 "C:\"，避免结果随进程驱动器状态漂移。
    dirPart += '\\';
  }

  const dirents = await readdir(dirPart, { withFileTypes: true }).catch(() => []);
  const completions = dirents
    .filter((d) => !PICKER_IGNORED.has(d.name) && d.name.startsWith(prefix))
    .map((d) => ({
      name: d.name,
      // wire 统一 "/" 分隔；join 处理好盘符根与尾分隔的拼接。
      path: join(dirPart, d.name).split(sep).join('/'),
      type: d.isDirectory() ? ('dir' as const) : ('file' as const),
    }))
    .slice(0, 100);
  return sortCompletions(completions);
}

function safePath(rootDir: string, requestPath: string): string {
  const clean = requestPath.replace(/^\/+/, '').replace(/\.\./g, '');
  const full = resolve(rootDir, clean || '.');
  const rel = relative(rootDir, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path outside root');
  }
  return full;
}

export interface FileOpsResult {
  type: string;
  [key: string]: unknown;
}

export async function handleFileOps(
  msg: Record<string, unknown>,
  agentDir: string,
): Promise<FileOpsResult | null> {
  const type = typeof msg.type === 'string' ? msg.type : '';

  switch (type) {
    case 'list_files': {
      const requestPath = typeof msg.path === 'string' ? msg.path : '';
      const targetDir = requestPath ? safePath(agentDir, requestPath) : agentDir;
      try {
        const entries = await readdir(targetDir, { withFileTypes: true });
        const items = await Promise.all(
          entries.map(async (entry) => {
            const fullPath = join(targetDir, entry.name);
            let size = 0;
            try {
              const s = await stat(fullPath);
              size = s.size;
            } catch {
              /* ignore */
            }
            return {
              name: entry.name,
              path: relative(agentDir, fullPath).replace(/\\/g, '/'),
              isDirectory: entry.isDirectory(),
              size,
            };
          }),
        );
        return {
          type: 'files',
          files: {
            path: requestPath || '',
            parent: requestPath ? requestPath.split('/').slice(0, -1).join('/') : null,
            entries: items,
            truncated: false,
          },
        };
      } catch {
        return {
          type: 'files',
          files: { path: requestPath || '', parent: null, entries: [], truncated: false },
        };
      }
    }

    case 'read_file': {
      const requestPath = typeof msg.path === 'string' ? msg.path : '';
      if (!requestPath) return null;
      try {
        const fullPath = safePath(agentDir, requestPath);
        const content = await readFile(fullPath, 'utf8');
        const ext = extname(fullPath).toLowerCase();
        const name = basename(fullPath);
        const s = await stat(fullPath);
        const lines = content.split('\n').length;
        const textExts = ['.txt', '.md', '.json', '.ts', '.tsx', '.js', '.css', '.html'];
        const imageExts = ['.png', '.jpg', '.gif', '.webp'];
        const kind = imageExts.includes(ext) ? 'image' : textExts.includes(ext) ? 'text' : 'none';
        return {
          type: 'file_content',
          content: {
            path: requestPath,
            name,
            kind,
            text: kind === 'text' ? content : '',
            truncated: false,
            binary: kind !== 'text' && kind !== 'none',
            lines,
            size: s.size,
          },
        };
      } catch {
        return null;
      }
    }

    case 'complete_path': {
      // cwd 选择器 = 整机目录浏览（真实现见 listPathCompletions 注释）。
      const partial = typeof msg.path === 'string' ? msg.path : '';
      try {
        return {
          type: 'path_completions',
          completions: await listPathCompletions(agentDir, partial),
        };
      } catch {
        return { type: 'path_completions', completions: [] };
      }
    }

    case 'write_file': {
      const requestPath = typeof msg.path === 'string' ? msg.path : '';
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!requestPath) return null;
      try {
        const fullPath = safePath(agentDir, requestPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, text, 'utf8');
        return { type: 'file_changed', path: requestPath };
      } catch {
        return null;
      }
    }

    case 'search_files': {
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      return {
        type: 'search_files_result',
        reqId,
        ok: true,
        results: [],
        truncated: false,
      };
    }

    case 'get_settings': {
      try {
        const raw = await readFile(join(agentDir, SETTINGS_FILE), 'utf8');
        return { type: 'settings_state', settings: JSON.parse(raw) };
      } catch {
        return { type: 'settings_state', settings: {} };
      }
    }

    case 'set_settings': {
      const settings = msg.settings;
      try {
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8');
      } catch {
        /* ignore */
      }
      return { type: 'settings_state', settings: settings ?? {} };
    }

    default:
      return null;
  }
}

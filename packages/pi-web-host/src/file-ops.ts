/**
 * pi-web-host · 文件操作 + 设置存储（第一批扩展）
 *
 * utility 进程有 Node.js fs 访问，直接读写 agentDir 下的文件系统。
 */
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, extname, relative, isAbsolute, resolve } from 'node:path';

const SETTINGS_FILE = 'settings.json';

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
      const partial = typeof msg.path === 'string' ? msg.path : '';
      const lastSlash = partial.lastIndexOf('/');
      const dirPart = lastSlash >= 0 ? partial.slice(0, lastSlash) : '';
      const prefix = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;
      try {
        const targetDir = dirPart ? safePath(agentDir, dirPart) : agentDir;
        const entries = await readdir(targetDir, { withFileTypes: true });
        const completions = entries
          .filter((e) => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
          .map((e) => ({
            name: e.name,
            path: (dirPart ? dirPart + '/' : '') + e.name,
            type: e.isDirectory() ? ('dir' as const) : ('file' as const),
          }));
        return { type: 'path_completions', completions };
      } catch {
        return { type: 'path_completions', completions: [] };
      }
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

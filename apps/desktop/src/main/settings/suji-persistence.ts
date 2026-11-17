/** 速记文件存储：保留 settings IPC，正文以 Markdown 为真源，其余状态写 state.json。 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SettingsPersistence } from './settings-manager';

const KEY = 'settings:notebook.state';
const noteSchema = z
  .object({
    id: z.string().min(1),
    notebookId: z.string(),
    title: z.string(),
    content: z.string(),
  })
  .passthrough();
const stateSchema = z
  .object({
    notebooks: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    notes: z.array(noteSchema),
  })
  .passthrough();
const diskSchema = stateSchema.extend({
  notes: z.array(noteSchema.omit({ content: true }).extend({ file: z.string() })),
});

/** Windows 文件名收敛；目录与文件冲突另以稳定 ID 哈希消歧。 */
function safeName(name: string, fallback: string): string {
  const safe = name
    // Windows 不允许控制字符出现在文件名中。
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 70);
  if (!safe || safe === '.' || safe === '..') return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

function suffix(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

/** 仅替换速记键的存储，其他设置继续委托原 SQLite。旧记录保留作迁移备份。 */
export class SujiPersistence implements SettingsPersistence {
  readonly root: string;

  constructor(
    private readonly base: SettingsPersistence,
    dataDir: string,
  ) {
    this.root = join(dataDir, 'documents', 'suji');
  }

  private notePath(file: string): string {
    const root = resolve(this.root, 'nootbook');
    const path = resolve(this.root, file);
    if (!path.startsWith(root + sep) || !path.endsWith('.md')) {
      throw new Error('Invalid suji note path');
    }
    return path;
  }

  get<T>(key: string): T | null {
    if (key !== KEY) return this.base.get<T>(key);
    const snapshot = join(this.root, 'state.json');
    if (existsSync(snapshot)) {
      // 损坏或缺失正文时直接报错，禁止用旧库或空正文覆盖现有文件。
      const stored = diskSchema.parse(JSON.parse(readFileSync(snapshot, 'utf8')));
      return {
        ...stored,
        notes: stored.notes.map(({ file, ...note }) => ({
          ...note,
          content: readFileSync(this.notePath(file), 'utf8'),
        })),
      } as T;
    }
    const legacy = this.base.get<unknown>(key);
    if (legacy !== null && legacy !== undefined) {
      mkdirSync(this.root, { recursive: true });
      const backup = join(this.root, 'legacy-backup.json');
      if (!existsSync(backup)) atomicWrite(backup, JSON.stringify(legacy, null, 2));
      this.set(key, legacy);
    }
    return legacy as T | null;
  }

  set<T>(key: string, value: T): void {
    if (key !== KEY) return this.base.set(key, value);
    const state = stateSchema.parse(value);
    const snapshot = join(this.root, 'state.json');
    const previous = existsSync(snapshot)
      ? diskSchema.parse(JSON.parse(readFileSync(snapshot, 'utf8')))
      : null;
    const folders = new Map<string, string>();
    const used = new Set<string>();
    for (const notebook of state.notebooks) {
      let name = safeName(notebook.name, '未命名笔记本');
      if (used.has(name.toLowerCase())) name += `--${suffix(notebook.id)}`;
      used.add(name.toLowerCase());
      folders.set(notebook.id, name);
      mkdirSync(join(this.root, 'nootbook', name), { recursive: true });
    }
    const notes = state.notes.map(({ content, ...note }) => {
      const folder = folders.get(note.notebookId);
      if (!folder) throw new Error('Unknown suji notebook');
      const file = join(
        'nootbook',
        folder,
        `${safeName(note.title, '无标题笔记')}--${suffix(note.id)}.md`,
      );
      const path = this.notePath(file);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) atomicWrite(path, content);
      return { ...note, file };
    });
    // 先提交完整索引，再归档已删除或改名的旧文件；只处理原索引记录的文件。
    atomicWrite(snapshot, JSON.stringify({ ...state, notes }, null, 2));
    const active = new Set(notes.map((note) => note.file.toLowerCase()));
    for (const old of previous?.notes ?? []) {
      if (active.has(old.file.toLowerCase())) continue;
      const path = this.notePath(old.file);
      if (existsSync(path)) {
        const archive = join(this.root, '.trash', `${randomUUID()}.md`);
        mkdirSync(dirname(archive), { recursive: true });
        renameSync(path, archive);
      }
    }
  }

  delete(key: string): void {
    if (key === KEY) throw new Error('Suji state must be cleared through the notebook UI');
    this.base.delete?.(key);
  }
}

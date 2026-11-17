// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SujiPersistence } from '../../src/main/settings/suji-persistence';
import {
  SettingsManager,
  type SettingsPersistence,
} from '../../src/main/settings/settings-manager';

const KEY = 'settings:notebook.state';
const original = {
  version: 1,
  notebooks: [{ id: 'nb1', name: '工作' }],
  notes: [{ id: 'n1', notebookId: 'nb1', title: '计划', content: '# 正文\n测试', updatedAt: 1 }],
  tasks: [{ id: 'task1', text: '任务' }],
  stickies: [{ id: 'sticky1', text: '便利贴' }],
  layout: { left: 0.2, middle: 0.4, right: 0.4 },
};

describe('SujiPersistence', () => {
  let dir: string;
  let entries: Map<string, unknown>;
  let base: SettingsPersistence;
  let store: SujiPersistence;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'suji-test-'));
    entries = new Map();
    base = {
      get: <T>(key: string) => (entries.get(key) ?? null) as T | null,
      set: (key, value) => {
        entries.set(key, value);
      },
      delete: (key) => {
        entries.delete(key);
      },
    };
    store = new SujiPersistence(base, dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function snapshot() {
    return JSON.parse(readFileSync(join(store.root, 'state.json'), 'utf8')) as {
      notes: { file: string; content?: string }[];
    };
  }

  it('migrates SQLite once, preserves backup, and reloads Markdown as the source', () => {
    entries.set(KEY, original);
    expect(store.get(KEY)).toEqual(original);
    expect(JSON.parse(readFileSync(join(store.root, 'legacy-backup.json'), 'utf8'))).toEqual(
      original,
    );
    expect(entries.get(KEY)).toEqual(original);
    const note = snapshot().notes[0]!;
    expect(note.content).toBeUndefined();
    expect(note.file).toContain(join('nootbook', '工作'));
    writeFileSync(join(store.root, note.file), '外部编辑', 'utf8');
    const loaded = new SujiPersistence(base, dir).get<typeof original>(KEY)!;
    expect(loaded.notes[0]!.content).toBe('外部编辑');
    expect(loaded.tasks).toEqual(original.tasks);
    expect(loaded.stickies).toEqual(original.stickies);
    expect(loaded.layout).toEqual(original.layout);
  });

  it('keeps identical titles separate and sanitizes notebook and file names', () => {
    store.set(KEY, {
      ...original,
      notebooks: [
        { id: 'nb1', name: '../CON' },
        { id: 'nb2', name: '../CON' },
      ],
      notes: [original.notes[0], { ...original.notes[0], id: 'n2', title: '../nul' }],
    });
    const files = snapshot().notes.map((note) => note.file);
    expect(new Set(files).size).toBe(2);
    for (const file of files)
      expect(readFileSync(join(store.root, file), 'utf8')).toBe('# 正文\n测试');
    expect(readdirSync(join(store.root, 'nootbook'))).toHaveLength(2);
  });

  it('archives old managed files after rename and deletion without touching other files', () => {
    store.set(KEY, original);
    writeFileSync(join(store.root, 'nootbook', '工作', '个人文件.md'), '保留');
    store.set(KEY, { ...original, notebooks: [{ id: 'nb1', name: '生活' }] });
    expect(readdirSync(join(store.root, '.trash'))).toHaveLength(1);
    store.set(KEY, { ...original, notes: [] });
    expect(readdirSync(join(store.root, '.trash'))).toHaveLength(2);
    expect(readFileSync(join(store.root, 'nootbook', '工作', '个人文件.md'), 'utf8')).toBe('保留');
  });

  it('rejects corrupt snapshots and path traversal instead of silently replacing notes', () => {
    store.set(KEY, original);
    const disk = snapshot();
    disk.notes[0]!.file = '../outside.md';
    writeFileSync(join(store.root, 'state.json'), JSON.stringify(disk));
    expect(() => store.get(KEY)).toThrow('Invalid suji note path');
    writeFileSync(join(store.root, 'state.json'), '{broken');
    expect(() => store.get(KEY)).toThrow();
  });

  it('delegates unrelated settings and propagates failed notebook saves', () => {
    store.set('settings:theme', 'dark');
    expect(store.get('settings:theme')).toBe('dark');
    store.delete('settings:theme');
    expect(store.get('settings:theme')).toBeNull();
    const manager = new SettingsManager(store);
    expect(() => manager.set('notebook.state', {})).toThrow();
    expect(manager.get('notebook.state')).toBeNull();
  });
});

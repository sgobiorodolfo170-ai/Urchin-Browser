/**
 * Import 域 · Firefox profile 检测与 places.sqlite 解析
 *
 * 依据：Firefox 用户目录结构（Windows）
 *   %APPDATA%\Mozilla\Firefox\profiles.ini
 *     [Profile0] Name=... Path=... IsRelative=1 Default=1
 *   <profile>\places.sqlite
 *     moz_bookmarks(id, parent, type, title, fk, guid)
 *       type=1 文件夹 / type=2 书签（fk→moz_places.id）
 *       根 root（parent=0, id=1）的子节点为 menu/toolbar/unfiled/tags/mobile（guid 固定）
 *     moz_places(id, url)
 *
 * 设计理由（AGENTS.md §六 可测试性 + §七.2）：
 * - detect：纯 I/O（existsSync + readFileSync INI），DI 注入 fs 便于单测
 * - buildFirefoxTreeFromRows：纯函数，输入行集输出 ImportTreeNode，便于单测
 * - readPlacesSqlite：I/O（复制临时文件 + better-sqlite3 readonly），避开运行锁
 * - 按 guid 跳过 tags 子树（标签根含大量标签条目，非用户书签结构）
 *
 * 锁与安全：
 * - Firefox 运行时对 places.sqlite 持有排它锁；复制到 temp 后只读打开，原文件不动
 * - temp 文件用后即删（rmSync force）；读取失败抛错由调用方捕获展示
 */
import { existsSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ImportedBrowser } from '@urchin/ipc-contract';
import type { ImportTreeNode } from './types';

/** tags 根的 guid（跳过其子树，避免导入标签集合）。 */
const TAGS_ROOT_GUID = 'tags________';
/** 已知书签根 guid（places root 的直接子节点为这几个根文件夹）。 */
const KNOWN_ROOT_GUIDS = new Set(['menu________', 'toolbar_____', 'unfiled_____', 'mobile______']);

/** fs 依赖注入接口。 */
export interface FirefoxFsDeps {
  readonly existsSync?: typeof existsSync;
  readonly readFileSync?: typeof readFileSync;
  readonly copyFileSync?: typeof copyFileSync;
  readonly rmSync?: typeof rmSync;
}

/** better-sqlite3 工厂注入（生产用 better-sqlite3，单测注入 mock 或跳过 DB 测试）。 */
export type SqliteReadonlyFactory = (path: string) => {
  prepare(sql: string): { all(...params: readonly unknown[]): unknown[] };
  close(): void;
};

/** moz_bookmarks 行。 */
export interface MozBookmarkRow {
  readonly id: number;
  readonly parent: number;
  readonly type: number; // 1=folder, 2=bookmark
  readonly title: string | null;
  readonly fk: number | null;
  readonly guid: string | null;
}

/** moz_places 行。 */
export interface MozPlaceRow {
  readonly id: number;
  readonly url: string | null;
}

/**
 * 检测本机已安装的 Firefox profile。
 *
 * 解析 profiles.ini：[ProfileN] 段含 Name / Path / IsRelative / Default。
 * Path 相对时相对于 profiles.ini 所在目录（%APPDATA%\Mozilla\Firefox）。
 *
 * @param deps fs 注入
 * @returns 可导入 profile 列表（仅含 places.sqlite 的 profile）
 */
export function detectFirefoxBrowsers(deps: FirefoxFsDeps = {}): ImportedBrowser[] {
  const exists = deps.existsSync ?? existsSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const appData = process.env.APPDATA;
  if (!appData) return [];

  const firefoxDir = join(appData, 'Mozilla', 'Firefox');
  const iniPath = join(firefoxDir, 'profiles.ini');
  if (!exists(iniPath)) return [];

  let iniText: string;
  try {
    iniText = readFile(iniPath, 'utf-8');
  } catch {
    return [];
  }
  const profiles = parseProfilesIni(iniText);

  const results: ImportedBrowser[] = [];
  for (const p of profiles) {
    const profileDir = p.isRelative ? join(firefoxDir, p.path) : p.path;
    if (!exists(join(profileDir, 'places.sqlite'))) continue;
    results.push({
      id: `firefox:${profileDir}`,
      kind: 'firefox',
      displayName: 'Mozilla Firefox',
      profileName: p.name || p.path,
      profileDir,
      bookmarksSource: 'firefox-places',
    });
  }
  return results;
}

/** profiles.ini 解析结果。 */
interface ParsedProfile {
  readonly name: string;
  readonly path: string;
  readonly isRelative: boolean;
  readonly isDefault: boolean;
}

/** 可变累积器（INI 解析期间原地赋值，避免 readonly 阻塞）。 */
interface ProfileAccumulator {
  name?: string;
  path?: string;
  isRelative?: boolean;
  isDefault?: boolean;
}

/** 容错 INI 解析器（[ProfileN] 段 + Name/Path/IsRelative/Default 键）。 */
function parseProfilesIni(text: string): ParsedProfile[] {
  const profiles: ParsedProfile[] = [];
  let current: ProfileAccumulator | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      // 新段：仅 [Profile*] 段含 profile（[General] 段跳过）
      if (current?.path) {
        profiles.push({
          name: current.name ?? current.path,
          path: current.path,
          isRelative: current.isRelative ?? false,
          isDefault: current.isDefault ?? false,
        });
      }
      current = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !current) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Name') current.name = value;
    else if (key === 'Path') current.path = value;
    else if (key === 'IsRelative') current.isRelative = value === '1';
    else if (key === 'Default') current.isDefault = value === '1';
  }
  if (current?.path) {
    profiles.push({
      name: current.name ?? current.path,
      path: current.path,
      isRelative: current.isRelative ?? false,
      isDefault: current.isDefault ?? false,
    });
  }
  // 默认 profile 排前（用户更可能想导入默认 profile）
  return profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * 从 moz_bookmarks/moz_places 行集构建 ImportTreeNode 树。
 *
 * 策略：合成根节点，其 children 为 places root（parent=0 → id=1）的直接子节点中
 * guid 属于 KNOWN_ROOT_GUIDS 的根文件夹（menu/toolbar/unfiled/mobile），
 * 跳过 tags 根（guid=tags________）——标签条目非用户书签结构。
 *
 * @param bookmarkRows moz_bookmarks 全部行
 * @param placeRows moz_places 全部行
 * @returns 根节点（children 为各书签根文件夹）
 */
export function buildFirefoxTreeFromRows(
  bookmarkRows: readonly MozBookmarkRow[],
  placeRows: readonly MozPlaceRow[],
): ImportTreeNode {
  const placesById = new Map<number, string>();
  for (const p of placeRows) {
    if (p.url) placesById.set(p.id, p.url);
  }
  const bookmarkById = new Map<number, MozBookmarkRow>();
  for (const b of bookmarkRows) bookmarkById.set(b.id, b);

  const root: ImportTreeNode & { children: ImportTreeNode[] } = {
    title: '导入的书签',
    children: [],
  };

  // places root（parent=0）的直接子节点为各根文件夹
  const placeRootId = bookmarkRows.find((b) => b.parent === 0)?.id;
  if (placeRootId === undefined) return root;

  const topLevelFolders = bookmarkRows.filter((b) => b.parent === placeRootId && b.type === 1);
  for (const folder of topLevelFolders) {
    // 跳过 tags 根
    if (folder.guid === TAGS_ROOT_GUID) continue;
    // 仅取已知书签根（避免导入未知根），但容错：guid 为 null 时也尝试
    if (folder.guid !== null && !KNOWN_ROOT_GUIDS.has(folder.guid)) continue;
    root.children.push(convertFirefoxNode(folder, bookmarkRows, placesById));
  }
  return root;
}

/** 递归转换 Firefox bookmark 行为 ImportTreeNode。 */
function convertFirefoxNode(
  node: MozBookmarkRow,
  allRows: readonly MozBookmarkRow[],
  placesById: Map<number, string>,
): ImportTreeNode {
  if (node.type === 2) {
    const url = node.fk !== null ? (placesById.get(node.fk) ?? '') : '';
    const title = node.title ?? '';
    return { title: title || url, url: url || undefined };
  }
  // folder
  const children = allRows
    .filter((b) => b.parent === node.id)
    .sort(() => 0) // moz_bookmarks 无 position；保持查询顺序
    .map((b) => convertFirefoxNode(b, allRows, placesById));
  return { title: node.title ?? '未命名文件夹', children };
}

/**
 * 从 profile 目录读取并解析 Firefox places.sqlite。
 *
 * 流程：复制临时文件（避开 Firefox 运行锁）→ better-sqlite3 只读打开 →
 * 查询 moz_bookmarks/moz_places → buildFirefoxTreeFromRows → 关闭 + 删除临时文件。
 *
 * @param profileDir profile 绝对路径（含 places.sqlite）
 * @param deps fs 注入
 * @param dbFactory better-sqlite3 工厂注入（生产默认 better-sqlite3 readonly）
 */
export function parseFirefoxPlacesFromProfile(
  profileDir: string,
  deps: FirefoxFsDeps = {},
  dbFactory?: SqliteReadonlyFactory,
): ImportTreeNode {
  const copyFile = deps.copyFileSync ?? copyFileSync;
  const rm = deps.rmSync ?? rmSync;
  const placesPath = join(profileDir, 'places.sqlite');
  const tmpPath = join(tmpdir(), `urchin-places-${randomUUID()}.sqlite`);
  copyFile(placesPath, tmpPath);
  try {
    const factory = dbFactory ?? defaultReadonlyFactory;
    const db = factory(tmpPath);
    try {
      const bookmarkRows = db
        .prepare('SELECT id, parent, type, title, fk, guid FROM moz_bookmarks')
        .all() as MozBookmarkRow[];
      const placeRows = db.prepare('SELECT id, url FROM moz_places').all() as MozPlaceRow[];
      return buildFirefoxTreeFromRows(bookmarkRows, placeRows);
    } finally {
      db.close();
    }
  } finally {
    rm(tmpPath, { force: true });
  }
}

/** 生产默认 better-sqlite3 只读工厂（与 sqlite-factory 同款 native 模块；静态导入）。 */
function defaultReadonlyFactory(path: string): {
  prepare(sql: string): { all(...params: readonly unknown[]): unknown[] };
  close(): void;
} {
  const db = new Database(path, { readonly: true });
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return { all: (...params: readonly unknown[]) => stmt.all(...params) };
    },
    close: () => db.close(),
  };
}

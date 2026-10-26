/**
 * Import 域 · Chromium 系列（Chrome / Edge）profile 检测与收藏夹解析
 *
 * 依据：Chrome/Edge UserData 目录结构（Windows）
 *   %LOCALAPPDATA%\<Vendor>\<Browser>\User Data\
 *     Local State        — JSON，profile.info_cache 含 profile 名
 *     <Profile>\Bookmarks — JSON，roots.{bookmark_bar,other,synced}.children 树
 *
 * 设计理由（AGENTS.md §六 可测试性 + §七.2）：
 * - detect：纯 I/O（existsSync + readFileSync + JSON.parse），DI 注入 fs 便于单测
 * - parseBookmarksJson：纯函数，输入 JSON 对象输出 ImportTreeNode，便于单测
 * - 解析器容忍字段缺失（synced/other 可不存在）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportedBrowser } from '@urchin/ipc-contract';
import type { ImportTreeNode } from './types';

/** 候选浏览器（vendor 目录名 + 显示名）。 */
interface ChromiumCandidate {
  readonly kind: 'chrome' | 'edge';
  readonly displayName: string;
  /** 相对 %LOCALAPPDATA% 的 User Data 目录（反斜杠分隔） */
  readonly userDataSubPath: string;
}

const CANDIDATES: readonly ChromiumCandidate[] = [
  { kind: 'chrome', displayName: 'Google Chrome', userDataSubPath: 'Google\\Chrome\\User Data' },
  { kind: 'edge', displayName: 'Microsoft Edge', userDataSubPath: 'Microsoft\\Edge\\User Data' },
];

/** Local State 中 profile.info_cache 的最小结构。 */
interface LocalStateInfoCacheEntry {
  readonly name?: string;
}
interface LocalStateProfile {
  readonly info_cache?: Record<string, LocalStateInfoCacheEntry>;
}

/** fs 依赖注入接口（生产用 node:fs，单测注入 mock）。 */
export interface ChromiumFsDeps {
  readonly existsSync?: typeof existsSync;
  readonly readFileSync?: typeof readFileSync;
}

/**
 * 检测本机已安装的 Chromium 系浏览器 profile（Chrome / Edge）。
 *
 * @param deps fs 注入（单测 mock）
 * @returns 可导入 profile 列表（仅含存在 Bookmarks 文件的 profile）
 */
export function detectChromiumBrowsers(deps: ChromiumFsDeps = {}): ImportedBrowser[] {
  const exists = deps.existsSync ?? existsSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];

  const results: ImportedBrowser[] = [];
  for (const c of CANDIDATES) {
    const userDataDir = join(localAppData, c.userDataSubPath);
    if (!exists(userDataDir)) continue;

    // 读 Local State 取 profile 名（失败回退到 Default）
    let profiles: { dir: string; name: string }[] = [];
    const localStatePath = join(userDataDir, 'Local State');
    try {
      const raw = readFile(localStatePath, 'utf-8');
      const localState = JSON.parse(raw) as LocalStateProfile;
      const cache = localState.info_cache ?? {};
      profiles = Object.entries(cache).map(([dir, info]) => ({
        dir,
        name: info?.name ?? dir,
      }));
    } catch {
      /* Local State 解析失败：回退到 Default profile */
    }
    if (profiles.length === 0) {
      profiles = [{ dir: 'Default', name: 'Default' }];
    }

    for (const p of profiles) {
      const profileDir = join(userDataDir, p.dir);
      const bookmarksPath = join(profileDir, 'Bookmarks');
      if (!exists(bookmarksPath)) continue;
      results.push({
        id: `${c.kind}:${profileDir}`,
        kind: c.kind,
        displayName: c.displayName,
        profileName: p.name,
        profileDir,
        bookmarksSource: 'chromium-json',
      });
    }
  }
  return results;
}

/** Bookmarks JSON roots 节点（bookmark_bar / other / synced）。 */
interface ChromiumBookmarkNode {
  readonly type?: string;
  readonly name?: string;
  readonly url?: string;
  readonly children?: readonly ChromiumBookmarkNode[];
}
interface ChromiumBookmarksJson {
  readonly roots?: {
    readonly bookmark_bar?: ChromiumBookmarkNode;
    readonly other?: ChromiumBookmarkNode;
    readonly synced?: ChromiumBookmarkNode;
  };
}

/**
 * 解析 Chromium Bookmarks JSON 为 ImportTreeNode 树。
 *
 * 合并 bookmark_bar / other / synced 三个根为顶级子节点（保留各根名作为文件夹）。
 *
 * @param json Chromium Bookmarks JSON 对象
 * @returns 根节点（children 为三个根文件夹）
 */
export function parseChromiumBookmarksJson(json: ChromiumBookmarksJson): ImportTreeNode {
  const root: ImportTreeNode & { children: ImportTreeNode[] } = {
    title: '导入的书签',
    children: [],
  };
  const roots = json.roots ?? {};
  for (const rootNode of [roots.bookmark_bar, roots.other, roots.synced]) {
    if (!rootNode) continue;
    root.children.push(convertChromiumNode(rootNode));
  }
  return root;
}

/** 递归转换 Chromium 节点为 ImportTreeNode。 */
function convertChromiumNode(node: ChromiumBookmarkNode): ImportTreeNode {
  const name = node.name ?? '';
  if (node.type === 'url' && node.url) {
    return { title: name || node.url, url: node.url };
  }
  // folder（含 type=undefined 但有 children 的根节点）
  const children = (node.children ?? []).map(convertChromiumNode);
  return { title: name || '未命名文件夹', children };
}

/**
 * 从 profile 目录读取并解析 Chromium Bookmarks JSON。
 *
 * @param profileDir profile 绝对路径（含 Bookmarks 文件）
 * @param deps fs 注入
 */
export function parseChromiumBookmarksFromProfile(
  profileDir: string,
  deps: ChromiumFsDeps = {},
): ImportTreeNode {
  const readFile = deps.readFileSync ?? readFileSync;
  const raw = readFile(join(profileDir, 'Bookmarks'), 'utf-8');
  return parseChromiumBookmarksJson(JSON.parse(raw) as ChromiumBookmarksJson);
}

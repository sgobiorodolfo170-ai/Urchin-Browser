/**
 * GenOffice Home 本地状态存储（阶段 4.6）
 *
 * 背景：GenOffice 原项目 shell Home 的「最近/星标/默认保存目录/语言」由
 * 上游主进程的 app-settings 维护；嵌入 Urchin 后这些状态由宿主代管，
 * 落在 `<数据目录>/genoffice-home.json`（与 ai-settings.json 同级思路）。
 *
 * 设计：单文件 JSON + 内存缓存；写失败不抛（降级为会话内状态），
 * 读失败回落空状态——Home 属于入口页，任何存储异常都不应阻断打开文件。
 */
import { readFile, writeFile } from 'node:fs/promises';

export interface GenOfficeHomeState {
  /** 最近打开的文件绝对路径（最新在前，上限 RECENT_LIMIT）。 */
  recent: string[];
  /** 星标文件绝对路径（最新在前）。 */
  starred: string[];
  /** 默认保存目录（Home「文件夹」面板根 + 新文件落点）。 */
  defaultSaveDir?: string;
  /** GenOffice UI 语言（默认 zh）。 */
  language?: string;
}

/** 最近文件上限（与上游 recents 分页上限同量级，超出即淘汰最旧）。 */
export const RECENT_LIMIT = 100;

const EMPTY_STATE: GenOfficeHomeState = { recent: [], starred: [] };

/** 规范化磁盘数据（防手改/半写导致类型漂移）。 */
function normalize(raw: unknown): GenOfficeHomeState {
  const value = (raw ?? {}) as Record<string, unknown>;
  const paths = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
  return {
    recent: paths(value.recent).slice(0, RECENT_LIMIT),
    starred: paths(value.starred),
    ...(typeof value.defaultSaveDir === 'string' && value.defaultSaveDir.length > 0
      ? { defaultSaveDir: value.defaultSaveDir }
      : {}),
    ...(typeof value.language === 'string' && value.language.length > 0
      ? { language: value.language }
      : {}),
  };
}

export class GenOfficeHomeStore {
  private state: GenOfficeHomeState = { ...EMPTY_STATE };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /** 读取磁盘状态（首次调用加载；失败回落空状态，不抛）。 */
  async load(): Promise<GenOfficeHomeState> {
    if (this.loaded) return this.state;
    try {
      this.state = normalize(JSON.parse(await readFile(this.filePath, 'utf-8')));
    } catch {
      this.state = { ...EMPTY_STATE };
    }
    this.loaded = true;
    return this.state;
  }

  /** 当前内存状态（需先 load）。 */
  get(): GenOfficeHomeState {
    return this.state;
  }

  /** 持久化（失败仅告警，内存状态仍生效）。 */
  private async persist(): Promise<void> {
    try {
      await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[genoffice-home] persist failed:', e);
    }
  }

  /** 记录最近打开（去重后置顶 + 截断）。 */
  async recordRecent(filePath: string): Promise<void> {
    await this.load();
    this.state.recent = [filePath, ...this.state.recent.filter((p) => p !== filePath)].slice(
      0,
      RECENT_LIMIT,
    );
    await this.persist();
  }

  /** 从最近列表移除。 */
  async removeRecent(paths: readonly string[]): Promise<void> {
    await this.load();
    const drop = new Set(paths);
    this.state.recent = this.state.recent.filter((p) => !drop.has(p));
    await this.persist();
  }

  /** 星标开关。 */
  async toggleStar(filePath: string): Promise<void> {
    await this.load();
    this.state.starred = this.state.starred.includes(filePath)
      ? this.state.starred.filter((p) => p !== filePath)
      : [filePath, ...this.state.starred];
    await this.persist();
  }

  /** 路径重命名/移动后同步所有引用（文件与目录前缀）。 */
  async rebindPath(oldPath: string, newPath: string): Promise<void> {
    await this.load();
    const rebind = (p: string): string => {
      if (p === oldPath) return newPath;
      if (p.startsWith(`${oldPath}\\`) || p.startsWith(`${oldPath}/`)) {
        return newPath + p.slice(oldPath.length);
      }
      return p;
    };
    this.state.recent = this.state.recent.map(rebind);
    this.state.starred = this.state.starred.map(rebind);
    await this.persist();
  }

  /** 移除路径及其子路径（删除文件/目录后）。 */
  async forgetPaths(paths: readonly string[]): Promise<void> {
    await this.load();
    const prefixes = paths.map((p) => [p, `${p}\\`, `${p}/`]).flat();
    const keep = (p: string): boolean => !prefixes.some((prefix) => p.startsWith(prefix));
    this.state.recent = this.state.recent.filter(keep);
    this.state.starred = this.state.starred.filter(keep);
    await this.persist();
  }

  /** 设置默认保存目录。 */
  async setDefaultSaveDir(dir: string): Promise<void> {
    await this.load();
    this.state.defaultSaveDir = dir;
    await this.persist();
  }

  /** 设置 GenOffice UI 语言。 */
  async setLanguage(lang: string): Promise<void> {
    await this.load();
    this.state.language = lang;
    await this.persist();
  }
}

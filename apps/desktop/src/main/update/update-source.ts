/**
 * M20 更新源选择（2026-11-18 用户指令）· 国内优先 AtomGit、GitHub 兜底
 *
 * 依据：用户明确要求「国内自动更新时优先使用国内源，github 源兜底」。
 * ADR-024 双库发布：AtomGit 为国内只读镜像与下载入口，Release 资产与
 * GitHub 同组（exe + blockmap + latest.yml / dev.yml）。
 *
 * 设计理由（AGENTS.md §七）：
 * - 本文件只做「选择哪个 feed」的纯逻辑，不 import electron、不直接触网以外
 *   的事情，便于单测；真实更新仍由 electron-updater 执行。
 * - AtomGit 的 Release 下载地址是版本相关的
 *   （`/releases/download/<tag>/<file>`），而 generic 更新源要求固定目录，
 *   因此先查 Release 列表拿到 tag，再把该 tag 的下载目录作为 feed URL。
 * - 只挑「资产已齐全」的 Release：缺少 `latest.yml` / `dev.yml` 时更新器会
 *   404，选中它只会白白多一次失败请求，直接跳过并交给 GitHub 兜底。
 * - 镜像可能落后于 GitHub（Pull 镜像同步不及时）：这里不做版本大小判断，
 *   由 electron-updater 判定「无更新」后回退 GitHub 再查一次，避免自己实现
 *   SemVer 比较造成与更新器语义漂移。
 * - 匿名读取公开仓库 Release（不带令牌）：客户端无法安全持有发布令牌。
 *
 * 第三方依赖：无（Node 18+ 全局 fetch；Electron 主进程可用）。
 */

/** AtomGit 国内镜像仓库坐标（与 ADR-024 一致）。 */
export const ATOMGIT_OWNER = 'daichuanmu';
export const ATOMGIT_REPO = 'Urchin-Browser';

/** 中国大陆常用时区：系统语言非中文但时区在国内时也应优先国内源。 */
const DOMESTIC_TIMEZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
]);

/** AtomGit Release 列表项的结构子集（只取选择 feed 所需字段）。 */
export interface AtomGitRelease {
  tag_name?: string;
  name?: string;
  prerelease?: boolean;
  created_at?: string;
  assets?: { name?: string }[];
}

/** 选中的国内更新源。 */
export interface DomesticFeed {
  /** Release 标签（如 v0.3.0 / v0.3.1-dev.2）。 */
  tag: string;
  /** 通道清单文件名（latest.yml / dev.yml）。 */
  channelFile: string;
  /** generic 更新源目录（该 tag 的 release 下载目录）。 */
  feedUrl: string;
}

/**
 * 是否应优先使用国内源。
 * 判定依据：系统语言 `zh*`，或时区为中国大陆常用时区。
 * 任一命中即视为国内用户；其余走 GitHub 默认源。
 */
export function isDomesticLocale(locale: string | undefined, timeZone?: string): boolean {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (/^zh(?:[-_]|$)/.test(normalized)) return true;
  return timeZone != null && DOMESTIC_TIMEZONES.has(timeZone);
}

/** 通道对应的清单文件名：stable = latest.yml；预发布 = <channel>.yml。 */
export function channelFileName(channel: string): string {
  return channel === 'latest' ? 'latest.yml' : `${channel}.yml`;
}

/** AtomGit 公开 Release 列表 API（降序取最近若干条）。 */
export function atomgitReleasesApiUrl(perPage = 20): string {
  const query = new URLSearchParams({ direction: 'desc', per_page: String(perPage) });
  return `https://api.atomgit.com/api/v5/repos/${ATOMGIT_OWNER}/${ATOMGIT_REPO}/releases?${query.toString()}`;
}

/** AtomGit Release 资产目录（作为 electron-updater generic feed）。 */
export function atomgitFeedUrl(tag: string): string {
  return `https://atomgit.com/${ATOMGIT_OWNER}/${ATOMGIT_REPO}/releases/download/${encodeURIComponent(tag)}`;
}

/** 按创建时间倒序（API 已降序，这里再排一次，避免平台忽略 direction）。 */
function byCreatedAtDesc(a: AtomGitRelease, b: AtomGitRelease): number {
  const at = Date.parse(a.created_at ?? '');
  const bt = Date.parse(b.created_at ?? '');
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

/**
 * 从 Release 列表里挑出当前通道可用的国内 feed。
 * - latest 通道只认正式版（prerelease !== true）；dev 通道只认预发布版；
 * - 必须带对应通道清单资产（latest.yml / dev.yml）；
 * - 多条命中取创建时间最新的一条。
 * 返回 null 表示国内无可用 feed，调用方应直接走 GitHub。
 */
export function pickDomesticFeed(
  releases: readonly AtomGitRelease[],
  channel: string,
): DomesticFeed | null {
  const channelFile = channelFileName(channel);
  const wantPrerelease = channel !== 'latest';
  const candidate = releases
    .filter((release) => typeof release.tag_name === 'string' && release.tag_name.length > 0)
    .filter((release) => (release.prerelease === true) === wantPrerelease)
    .filter((release) => (release.assets ?? []).some((asset) => asset.name === channelFile))
    .sort(byCreatedAtDesc)[0];
  if (!candidate?.tag_name) return null;
  return {
    tag: candidate.tag_name,
    channelFile,
    feedUrl: atomgitFeedUrl(candidate.tag_name),
  };
}

/**
 * 拉取 AtomGit Release 列表（匿名、短超时）。
 * 失败向上抛出，由调用方降级到 GitHub；超时 4s，避免拖慢用户点击「检查更新」。
 */
export async function fetchAtomGitReleases(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<AtomGitRelease[]> {
  const response = await fetchImpl(atomgitReleasesApiUrl(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`AtomGit releases API 返回 ${response.status}`);
  }
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as AtomGitRelease[]) : [];
}

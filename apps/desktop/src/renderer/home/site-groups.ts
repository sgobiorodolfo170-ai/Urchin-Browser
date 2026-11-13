/** 网站归集采用主机名（忽略 www 和协议，保留子域与端口），不改写网页地址。 */
export interface SitePage {
  readonly url: string;
  readonly title: string;
  readonly time: number;
  readonly favicon?: string;
}
export interface SiteGroup {
  key: string;
  url: string;
  title: string;
  favicon?: string;
  pages: SitePage[];
}
export function groupSitePages(entries: readonly SitePage[]): SiteGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, SiteGroup>();
  for (const entry of [...entries].sort((a, b) => b.time - a.time)) {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    const key = url.host.replace(/^www\./, '');
    let group = groups.get(key);
    if (!group) {
      group = { key, url: url.origin, title: key, favicon: entry.favicon, pages: [] };
      groups.set(key, group);
    }
    if (!group.favicon && entry.favicon) group.favicon = entry.favicon;
    group.pages.push(entry);
  }
  return [...groups.values()];
}

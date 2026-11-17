import { parse } from 'tldts';
import { bareDomainOf, lookupBuiltinSite } from './site-directory-lookup';

/** 网站归集使用目录别名或可注册域；保留端口与完整网页地址。 */
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
    const hostname = url.hostname.replace(/\.$/, '');
    const parsed = parse(hostname, { allowPrivateDomains: true });
    const builtin = lookupBuiltinSite(url.href);
    // 未知后缀、IP 和本地服务保留主机名，跨顶级域只按显式目录别名合并。
    const domain = builtin
      ? bareDomainOf(builtin.domains[0]!)
      : parsed.isIcann || parsed.isPrivate
        ? (parsed.domain ?? hostname)
        : bareDomainOf(url.href);
    const key = `${domain}${url.port ? `:${url.port}` : ''}`;
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

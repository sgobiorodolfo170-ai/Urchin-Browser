/**
 * 内置站点目录查找函数（独立文件）
 *
 * 2026-08-15：site-directory.ts 由用户持续扩充站点清单（当前 ~1000 站），
 * 查找函数单独放本文件，避免与清单编辑冲突。基于 SITE_DIRECTORY 建域名索引，
 * 供主页（NewTabPage）比对图标与名称。
 */
import { SITE_DIRECTORY, type BuiltinSite } from './site-directory';
import { getDomain } from 'tldts';

/** 域名 → 站点索引（去 www 后的裸域名映射到条目） */
const DOMAIN_INDEX: ReadonlyMap<string, BuiltinSite> = new Map(
  SITE_DIRECTORY.flatMap((site) =>
    site.domains.map((domain) => [bareDomainOf(domain), site] as const),
  ),
);

/** 提取 URL 的裸域名（去 www 前缀，统一小写）；无效返回空串。
 *  兼容无协议裸域名（如目录里登记的 'baidu.com'）：new URL 需带协议，先补 https://。 */
export function bareDomainOf(url: string): string {
  try {
    const withProtocol = url.includes('://') ? url : `https://${url}`;
    const hostname = new URL(withProtocol).hostname.toLowerCase().replace(/\.$/, '');
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 最具体的目录域名优先；仅在可注册域范围内继承，避免公共托管平台租户串站。 */
export function lookupBuiltinSite(url: string): BuiltinSite | undefined {
  let host = bareDomainOf(url);
  const domain = getDomain(host, { allowPrivateDomains: true });
  while (host) {
    const site = DOMAIN_INDEX.get(host);
    if (site) return site;
    if (!domain || host === domain) break;
    host = host.slice(host.indexOf('.') + 1);
  }
  return undefined;
}

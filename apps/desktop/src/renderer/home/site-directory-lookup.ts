/**
 * 内置站点目录查找函数（独立文件）
 *
 * 2026-08-15：site-directory.ts 由用户持续扩充站点清单（当前 ~1000 站），
 * 查找函数单独放本文件，避免与清单编辑冲突。基于 SITE_DIRECTORY 建域名索引，
 * 供主页（NewTabPage）比对图标与名称。
 */
import { SITE_DIRECTORY, type BuiltinSite } from './site-directory';

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
    const hostname = new URL(withProtocol).hostname.toLowerCase();
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 在目录中查找站点（按裸域名比对）；未命中返回 undefined */
export function lookupBuiltinSite(url: string): BuiltinSite | undefined {
  const bare = bareDomainOf(url);
  if (!bare) return undefined;
  return DOMAIN_INDEX.get(bare);
}

/** 内置站点图标 URL（public/sites/<key>.png；无则该站点无内置图标） */
export function builtinIconUrl(site: BuiltinSite): string {
  return `/sites/${site.key}.png`;
}

/**
 * dsh 服务地址匹配工具（§7.1 生命周期缺陷修复 · ADR-016 关联）
 *
 * 为什么需要本模块（AGENTS.md §七.2）：
 * dsh web 认证 URL（`http://127.0.0.1:<port>/?token=<43chars>`）首访后会被
 * 303 重定向为不带 token 的干净 URL（vendor …/browser-auth.ts:279-293
 * `writeHead(303, { location: './' })`），Electron 标签的 tab.url 随之变为
 * 干净 URL。任何以「认证 URL 前缀 startsWith」做的匹配在重定向后必然落空：
 * 关标签不停后端（tab-lifecycle）、再次点击入口重复开标签（renderer）。
 * 因此匹配基准从「完整认证 URL 前缀」改为「服务 origin」——与 pinner
 * （bootstrap/handlers.ts 的 piIconPinner）已愈路径同型（用户裁决记录见
 * docs/DSH-遗留规划.md §一）。
 *
 * 边界：origin = scheme + host + port。dsh/pi-web 服务都是 127.0.0.1 随机
 * 端口，随机端口本身已是有效隔离（跨端口即不同服务）。
 */

/**
 * 判定两个 URL 是否指向同一本地服务（origin 相等）。
 *
 * @returns origin 相等返回 true；任一 URL 非法（new URL 抛出）返回 false
 */
export function sameServiceOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    // 非 URL 字符串（空串/页面内 url 缺省/内部协议外的残缺值）→ 视为不匹配
    return false;
  }
}

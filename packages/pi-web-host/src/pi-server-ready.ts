/**
 * pi-server 集成入口的 stdout 就绪行契约。
 *
 * 与 `auth.ts` 的 `HOST_READY_PREFIX`（轻量壳 pi-web-host）同构：父进程（Electron
 * 主进程的 launcher）从 utilityProcess 的 stdout 里解析这一行，拿到「实际监听端口
 * + 访问 token」后拼装入库 URL。之所以单独放一个模块：入口 `pi-server-entry.ts`
 * 会被打成 bundle，父进程无法 import bundle 内的常量，必须从包入口拿同一份定义。
 */

/** 就绪行前缀（后面紧跟完整 URL，token 存在时形如 ...?token=xxx） */
export const PI_SERVER_READY_PREFIX = 'pi-server ready: ';

/**
 * 就绪行正则。与 HOST_READY_LINE_RE 同样的坑：URL 可能跨 chunk 到达，因此 token
 * 之后必须已出现终止符（空白或 ANSI 转义）才接受匹配，不能用 `$` 锚定行尾。
 */
export const PI_SERVER_READY_LINE_RE =
  // eslint-disable-next-line no-control-regex -- \x1b（ANSI ESC）是刻意作为 token 终止符
  /pi-server ready: (http:\/\/[^\s\x1b]+)(?=[\s\x1b])/;

/** 拼装访问 URL：带 token 时以 query 形式给出（pi-server 会换发 HttpOnly Cookie）。 */
export function buildPiServerUrl(port: number, host: string, token: string): string {
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

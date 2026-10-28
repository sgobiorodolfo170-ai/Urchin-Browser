/**
 * pi 阶段 2 托管服务 · 鉴权与会话凭据
 *
 * 对齐 docs/pi-web-评估.md 阶段 2 决策：自研服务端内置随机 token 鉴权（有别于
 * pi-web-ui 的无鉴权端口）。M2A 实现 32 字节随机 token：
 *
 * - 入口 URL 携带 `?token=<43chars base64url>`（capability URL，与 dsh web 同构）
 * - HTTP 请求校验：query token 或同名 Cookie，两者其一命中即放行
 * - WebSocket 握手做同样校验（upgrade 前拒绝 401），杜绝无关进程连接
 *
 * 注意：token 只存在于服务端内存与 URL/Cookie 中，不落盘（阶段 2 服务重启即换新）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 服务端就绪行 stdout 前缀（desktop 侧 PiWebHostLauncher 据此解析 URL） */
export const HOST_READY_PREFIX = 'pi-web-host ready: ';

/**
 * stdout 就绪行正则。token 字符集为 base64url（[A-Za-z0-9_-]），URL 行可能跨 chunk
 * 到达——与 dsh 同教训：token 之后必须已出现终止符（空白或 ANSI 转义，两者都不属于
 * token 字符集）才接受匹配；不能用 `$`（缓冲末尾锚点）作终止符（会因截断误判）。
 */
export const HOST_READY_LINE_RE =
  // eslint-disable-next-line no-control-regex -- \x1b（ANSI ESC）是刻意的 token 终止符
  /pi-web-host ready: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?=[\s\x1b])/;

/** Cookie 名（HttpOnly + SameSite=Strict） */
export const HOST_TOKEN_COOKIE = 'ub_pi_host_token';

/** 生成会话 token：32 字节随机 → base64url（43 字符） */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 构造带 token 的入口 URL */
export function buildHostUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

/** 从 query 中解析 token（无则返回 undefined） */
export function tokenFromQuery(search: string): string | undefined {
  if (!search) return undefined;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const t = params.get('token');
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/** 从 Cookie 头中解析 host token */
export function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === HOST_TOKEN_COOKIE) {
      const value = rest.join('=');
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/** 生成 Cookie 头（供 HTTP 响应 set） */
export function buildTokenCookie(token: string): string {
  return `${HOST_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/** 常量时间字符串比较（避免时序侧信道；token 比对用） */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 校验 token 是否与服务端会话 token 一致 */
export function isTokenValid(expected: string | undefined, candidate: string | undefined): boolean {
  if (!expected || !candidate) return false;
  return safeEqual(expected, candidate);
}

/**
 * 归一化 HTTP 请求的鉴权判定：query token 或 Cookie 任一命中即通过。
 *
 * @returns 通过时回写 true；同时（可选）把 query url 重写为 `/`（消除 token 泄漏到
 *   引用头/日志的可能性）
 */
export function isAuthorizedRequest(
  expected: string | undefined,
  search: string | undefined,
  cookieHeader: string | undefined,
): boolean {
  return (
    isTokenValid(expected, tokenFromQuery(search ?? '')) ||
    isTokenValid(expected, tokenFromCookie(cookieHeader))
  );
}

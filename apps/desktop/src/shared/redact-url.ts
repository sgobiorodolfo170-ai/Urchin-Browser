/**
 * URL 查询参数脱敏（§7.3「token 写入日志」修复 · AGENTS.md §六
 * 「日志不得含凭据」项目特化审查点）
 *
 * 为什么需要本模块（AGENTS.md §七.2）：
 * `packages/logger` 的 sanitizeMeta 按 **meta 键名**（key|token|secret|
 * password|credential）脱敏，而泄漏点的凭据藏在 **`url` 键的字符串值**里
 * （`{ url: 'http://127.0.0.1:<p>/?token=<43chars>' }`）——键名 `url` 不命中
 * 脱敏正则，token 明文穿透进 JSON 化 console 输出。dsh token 可换取 30 天
 * 签名 cookie（vendor …/browser-auth.ts:251-286），属凭据，必须打码。
 *
 * 2026-11-06 用户裁决：修复面 = 本工具 + 3 处调用点显式接入；
 * logger emitter 级全局兜底打码**不加**（否决：共享包全局隐性正则对调试
 * 不透明，登记 docs/DSH-遗留规划.md §二 待下轮规范治理评估）。
 *
 * 设计取舍：只打码 `token` 查询参数（dsh / pi-web 两条集成链的唯一凭据参数），
 * 保留路径与其它参数——日志现场仍可还原「哪个端口 / 哪条路径」的调试价值，
 * 满足 §7.3 修复的同时不影响日志排障用途。
 */

/** token 参数打码后的占位值 */
const REDACTED_TOKEN = '***';

/**
 * 将 URL 查询串中的 `token` 参数值替换为 `***`。
 *
 * @param url 原始 URL 字符串（可为任意文本——非法 URL 原样返回）
 * @returns 打码后的 URL；若不含 token 参数则原样返回（避免无谓的重新编码）
 */
export function redactUrlToken(url: string): string {
  // 快路径：绝大多数日志 URL 不含 token=，原样返回避免 URL 重编码副作用
  if (!url.includes('token=')) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('token')) return url;
    // set 会替换同名参数并去重：多个 token= 折叠为单个打码值
    parsed.searchParams.set('token', REDACTED_TOKEN);
    return parsed.toString();
  } catch {
    // new URL 对非 http(s)/残缺值抛出 → 无 token 参数语义，原样返回
    return url;
  }
}

/**
 * pi auth.json 空白占位注入（dev.43）· 隐藏「下载 pi agent」误导性引导
 *
 * 背景：pi-web-ui 在 auth.json 无任何凭据时（isPiConfigured=false）显示
 * 「下载 pi agent」引导，其按钮执行 `npm i -g @earendil-works/pi-coding-agent`
 * ——面向独立用户的安装路径，在 Urchin 嵌入场景既无必要又易被误点（已发生过一次）。
 *
 * 方案（不改第三方包源码，避免破坏后续更新对接）：启动器 spawn 前检查
 * <agentDir>/auth.json，**仅当文件不存在或为空对象 {} 时**注入一条空白占位
 * 凭据，使 isPiConfigured() 判定已配置、引导不再出现。
 *
 * 兼容性依据（vendor/pi 1.4.0 + pi-web-ui 0.110.0 源码核验；auth.json 形状自 0.84.2 起未变）：
 * - auth.json 官方形状 = Record<provider, Credential>；ApiKeyCredential 的
 *   `key` 字段本就可空（pi-ai auth/types.ts），`{ type: "api_key" }` 合法；
 * - 凭据按 providerId 按需读取，未知 provider 的条目永不被使用；
 * - pi-web-ui 保存真实 Key 时合并写入（setProviderApiKey），占位条目原样保留；
 * - 占位是纯数据：pi-web-ui 自更新 / vendor/pi 升级均不改写 userData 的
 *   auth.json，不存在更新报错面。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-web-auth-placeholder');

/** 占位 provider id：下划线前缀标记内部用途，与任何真实 provider 无碰撞 */
const PLACEHOLDER_PROVIDER = '_urchin_bootstrap';

/** 与 pi 官方 auth.json 写入保持一致的文件权限（0600，仅所有者可读写） */
const AUTH_FILE_MODE = 0o600;

/**
 * 确保 auth.json 存在一条空白占位凭据（仅当无任何凭据时）。
 *
 * 行为：
 * - 文件不存在 → 写入 `{ "_urchin_bootstrap": { "type": "api_key" } }`
 * - 文件为 `{}`（pi SDK 会自动创建空文件）→ 同上
 * - 已有任何凭据条目 / JSON 损坏 → 不动（绝不覆盖用户真实配置）
 *
 * @param agentDir pi agent 目录（PI_CODING_AGENT_DIR，auth.json 所在）
 */
export function ensureAuthPlaceholder(agentDir: string): Promise<void> {
  const authPath = join(agentDir, 'auth.json');
  let seed = false;
  if (!existsSync(authPath)) {
    seed = true;
  } else {
    try {
      const data: unknown = JSON.parse(readFileSync(authPath, 'utf-8'));
      // 空对象（或非对象值视为异常场景，不处理）→ 需要占位
      seed = typeof data === 'object' && data !== null && Object.keys(data).length === 0;
    } catch {
      // JSON 损坏：留给 pi 自己处理，不覆盖
      log.warn('auth.json unparsable, skip placeholder seeding', { authPath });
      return Promise.resolve();
    }
  }

  if (!seed) return Promise.resolve();

  const content = JSON.stringify({ [PLACEHOLDER_PROVIDER]: { type: 'api_key' } }, null, 2) + '\n';
  writeFileSync(authPath, content, 'utf-8');
  try {
    chmodSync(authPath, AUTH_FILE_MODE);
  } catch {
    // Windows 上 chmod 语义有限，失败不致命
  }
  log.info('auth placeholder seeded (download-onboarding suppressed)', { authPath });
  return Promise.resolve();
}

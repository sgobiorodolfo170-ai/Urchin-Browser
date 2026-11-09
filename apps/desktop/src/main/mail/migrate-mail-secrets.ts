/**
 * M25 邮箱模块 · 密码密文迁移（pi 根 → 数据目录根）
 *
 * 依据：2026-11-10「账户密码缺失」排查——mail 密码此前复用 pi 根 SecretStore
 * （固定 userData/pi/secrets，不随数据目录变动），而 mail_accounts 行随数据目录
 * （urchin.db）走；卸载重装 / 数据目录切换后两侧失配，账户在、密文丢。
 * 修复：mail 密码根迁至 <dataDir>/secrets，启动时把旧位置的 mail-account/* 一次性
 * 搬到新位置（目标已存在的不覆盖——重授权后的新密文总是更新）。
 *
 * 同机同用户下 safeStorage（Windows DPAPI）密文与文件路径无关，字节级复制即可解密。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';

const log = createLogger('mail-migrate');

/** 旧根下 mail-account 子目录名（SecretStore 键首段，ST6 白名单内） */
const MAIL_ACCOUNT_DIR = 'mail-account';

/**
 * 把旧密码根（userData/pi/secrets）下的 mail-account/* 复制到新根（dataDir/secrets）。
 *
 * 规则：
 * - 只处理 mail-account 子树（pi provider 密钥不受影响）
 * - 目标同名目录已存在 → 跳过（不覆盖：新根可能是重授权后的新密文）
 * - 任一账户复制失败不中断整体（记日志继续，缺失账户走 UI 重授权兜底）
 *
 * @returns 迁移的账户目录数
 */
export function migrateMailSecrets(legacyRoot: string, newRoot: string): number {
  const legacyAccountDir = join(legacyRoot, MAIL_ACCOUNT_DIR);
  const newAccountDir = join(newRoot, MAIL_ACCOUNT_DIR);
  if (!existsSync(legacyAccountDir)) return 0;

  let entries: string[];
  try {
    entries = readdirSync(legacyAccountDir);
  } catch (err) {
    log.warn('read legacy mail secrets failed', { error: String(err) });
    return 0;
  }

  mkdirSync(newAccountDir, { recursive: true });
  let moved = 0;
  for (const entry of entries) {
    const from = join(legacyAccountDir, entry);
    const to = join(newAccountDir, entry);
    if (existsSync(to)) continue;
    try {
      cpSync(from, to, { recursive: true });
      moved += 1;
      log.info('mail secret migrated', { entry });
    } catch (err) {
      log.warn('mail secret migrate failed', { entry, error: String(err) });
    }
  }
  return moved;
}

/**
 * 打包前清理脚本：删除 apps/desktop 下所有 release-* 目录
 *
 * 每次打包都会生成新的 release-vN 目录，旧的目录会占用磁盘空间
 * 且容易混淆（用户可能误运行旧版本）。此脚本在 electron-builder
 * 运行前清理所有 release-* 目录，确保每次打包都是干净的。
 *
 * 容错策略：Windows 上 .exe / app.asar 常被杀毒软件或文件系统延迟释放
 * 锁定，rmSync 会抛 EPERM。单个目录删除失败时只警告并继续，不阻止打包
 *（electron-builder 会输出到新的 release-vN 目录，旧目录残留不影响）。
 */
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..', 'apps', 'desktop');

if (!existsSync(desktopDir)) {
  console.error('[clean-release] desktop dir not found:', desktopDir);
  process.exit(0);
}

const entries = readdirSync(desktopDir);
const releaseDirs = entries.filter((name) => name.startsWith('release-'));

if (releaseDirs.length === 0) {
  console.log('[clean-release] no release-* directories to clean');
} else {
  let cleaned = 0;
  let failed = 0;
  for (const dir of releaseDirs) {
    const fullPath = join(desktopDir, dir);
    console.log('[clean-release] removing:', fullPath);
    try {
      rmSync(fullPath, { recursive: true, force: true });
      cleaned++;
    } catch (err) {
      // EPERM / EBUSY：文件被占用，无法删除。警告并继续，不阻止打包。
      failed++;
      console.warn(
        `[clean-release] WARNING: failed to remove ${dir} (${err.code ?? err.message}). ` +
          'It may be locked by antivirus or another process. Skipping; electron-builder will output to a new directory.',
      );
    }
  }
  console.log(
    `[clean-release] cleaned ${cleaned} director${cleaned === 1 ? 'y' : 'ies'}` +
      (failed > 0 ? `, ${failed} skipped` : ''),
  );
}

/**
 * 更新前 MAX_PATH 自卫 · 清除安装目录内会让 NSIS 卸载器原子改名失败的超长路径
 *
 * 背景（2026-11-10 dev.175 自动更新失败事故，实测取证）：electron-builder 的
 * NSIS 卸载器在 `--updated` 语义下不直接删文件，而是把 $INSTDIR 内每个文件
 * 逐个 Rename 到暂存区 `$PLUGINSDIR\old-install\...`（uninstaller.nsh 的
 * un.atomicRMDir，事务式卸载：失败即整体还原 + Abort → 卸载器退出码 2 →
 * 安装器弹「Failed to uninstall old application files ... : 2」）。
 * NSIS 未声明 longPathAware，MoveFile 超过 MAX_PATH(260) 必败——源路径 ≤259
 * 时安装没问题，但暂存区前缀（%TEMP%\nsX.tmp\old-install ≈ 比安装目录前缀长
 * 11 字符）会把 250~259 区间的源文件顶过 260，被误报为 "File is busy"。
 * dev.159/175 树里 @deepseek-ai/dsh-experimental-inspector 的 Chromium
 * DevTools issue 描述文档（文件名普遍 60+ 字符）即踩中此雷。
 *
 * 为什么放在 update-service（而不是只靠打包侧剪除）：已发布安装树的雷无法
 * 追溯修复——dev.175→176 的更新执行的是 dev.175 的旧卸载器。应用在
 * quitAndInstall 前对自己的安装目录做一次就地短名改名（不删文件、零数据
 * 损失），可让任何已发布树安全渡过下一次更新。
 *
 * 设计要点：
 * - 纯 node:fs + node:path，不 import electron（延续 update-service 的
 *   全量注入风格，单测无需 mock electron 运行时）；
 * - 迭代栈遍历（54k 文件树避免递归深度问题），单文件失败跳过不阻断更新
 *   （best-effort：改名失败只记录，更新照常进行——打包侧 afterPack 的
 *   源头剪除才是硬门禁）；
 * - 阈值按本机 %TEMP% 实长计算（卸载器运行时的 $PLUGINSDIR 与应用同用户
 *   同 TEMP），不猜常数。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const logScope = 'long-path-guard';

/**
 * 卸载器暂存区相对 %TEMP% 的后缀：nsXXXXXX.tmp 为 NSIS 插件目录实测形态
 * （8 随机字符），old-install 为 uninstaller.nsh 硬编码目录名。
 * 长度 23；此处按真实字符串拼接计算，不硬编码长度。
 */
const STAGING_SUFFIX = path.win32.join('\\nsXXXXXX.tmp', '\\old-install');

/** Win32 MAX_PATH；路径字符串长度可达 259（含结尾 NUL 共 260）。 */
const MAX_PATH_CHARS = 259;

/** 就地改名后的短名长度上限（lp-<序号><.ext>，确保改名后远低于阈值）。 */
const SHORT_NAME_LIMIT = 16;

export interface LongPathPrecleanResult {
  /** 成功就地短名改名的文件（原相对路径）。 */
  renamed: string[];
  /** 尝试改名但失败的文件（原相对路径）——best-effort，不阻断更新。 */
  skipped: string[];
  /** 非 Windows 平台直接跳过（NSIS 原子改名仅存在于 Windows 卸载器）。 */
  skippedPlatform?: boolean;
}

/** 计算某文件在卸载器暂存区的目标路径长度（不依赖文件系统，纯函数）。 */
export function stagingTargetLength(tmpDir: string, relWithLeadingSep: string): number {
  return tmpDir.length + STAGING_SUFFIX.length + relWithLeadingSep.length;
}

/**
 * 更新安装前的超长路径自卫：遍历 instDir，把「卸载器暂存目标超 MAX_PATH」
 * 的文件就地改名为短名。
 *
 * @param instDir 应用安装目录（打包态 = path.dirname(execPath)）
 * @param tmpDir  本机 TEMP 目录（默认 os.tmpdir()，与卸载器 $PLUGINSDIR 同源）
 * @param platform 平台注入（默认 process.platform；单测可固定 'win32'）
 */
export function precleanLongPaths(
  instDir: string,
  tmpDir: string = os.tmpdir(),
  platform: NodeJS.Platform = process.platform,
): LongPathPrecleanResult {
  if (platform !== 'win32') return { renamed: [], skipped: [], skippedPlatform: true };
  const result: LongPathPrecleanResult = { renamed: [], skipped: [] };

  // 迭代栈遍历：54k+ 文件的 node_modules 树，避免深递归
  const stack: string[] = [instDir];
  let seq = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不可读：跳过（best-effort）
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue; // 符号链接等不动
      // 相对路径含前导分隔符，与卸载器 "$INSTDIR$R0\$R2" 拼接形态一致
      const rel = '\\' + path.win32.join(...path.relative(instDir, full).split(path.sep));
      if (stagingTargetLength(tmpDir, rel) <= MAX_PATH_CHARS) continue;

      const ext = path.win32.extname(entry.name);
      let shortName = `lp-${seq}${ext}`;
      seq += 1;
      if (shortName.length > SHORT_NAME_LIMIT) shortName = shortName.slice(0, SHORT_NAME_LIMIT);
      try {
        fs.renameSync(full, path.join(dir, shortName));
        result.renamed.push(rel);
      } catch {
        result.skipped.push(rel);
      }
    }
  }
  if (result.renamed.length > 0 || result.skipped.length > 0) {
    // 无 logger 依赖（保持纯模块）；调用方负责结构化落日志
    console.info(
      `[${logScope}] preclean renamed=${result.renamed.length} skipped=${result.skipped.length}`,
    );
  }
  return result;
}

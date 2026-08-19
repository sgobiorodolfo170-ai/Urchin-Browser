/**
 * 便携版（Portable）模式检测
 *
 * 设计理由（DD 决策，2026-08-19）：
 * - 在 exe 同级放置 portable.dat 标记文件即进入便携模式：userData 重定向到
 *   exe 旁的 userdata 目录，设置 / 历史 / cookies / pi 数据全部跟随软件目录，
 *   zip 分发到任意机器 / 位置都是全新档案，不污染、不读取本机既有用户数据。
 * - 用标记文件而非命令行参数：用户双击 exe 即可生效，无需带参启动。
 * - 无标记时保持默认行为（%APPDATA% 下 userData），不影响正常安装版与开发模式。
 *
 * 注意：调用必须在任何 app.getPath('userData') 之前，否则重定向不生效
 * （见 main/index.ts 顶层调用顺序）。
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 便携模式标记文件名（exe 同级） */
export const PORTABLE_MARKER = 'portable.dat';

/** 便携模式下 userData 目录名（相对 exe 目录） */
export const PORTABLE_USER_DATA_DIR = 'userdata';

/** 便携标记文件路径：exe 同级 <PORTABLE_MARKER> */
export function portableMarkerPath(execPath: string): string {
  return join(dirname(execPath), PORTABLE_MARKER);
}

/**
 * 解析便携模式 userData 路径。
 *
 * exe 同级存在 portable.dat 时返回 <exeDir>/userdata，否则返回 null（非便携模式）。
 * 返回后调用方应在任何 userData 读取前 app.setPath('userData', ...)。
 */
export function resolvePortableUserData(execPath: string): string | null {
  return existsSync(portableMarkerPath(execPath))
    ? join(dirname(execPath), PORTABLE_USER_DATA_DIR)
    : null;
}

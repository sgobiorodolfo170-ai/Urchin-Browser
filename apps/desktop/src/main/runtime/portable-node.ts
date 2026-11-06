/**
 * 便携 Node 运行时探测（设置-关于 · 运行时信息）
 *
 * 背景（X4，2026-10-16）：打包态 dsh 启动器不能用 Electron 内置 Node——
 * dsh 依赖 node-addon-require-builtin 校验运行时指纹，拒绝 Electron V8。
 * 安装包随附纯 Node 运行时（scripts/fetch-node.mjs 下载单文件 node.exe，
 * extraResources 打包为 resources/node/node.exe）。
 *
 * 本模块把「便携 node.exe 期望路径」收口为单一真源，供两处共用：
 * - dsh 启动器接线（bootstrap/handlers.ts，原两处内联 join 易漂移）；
 * - runtime.portableNode IPC 通道（设置-关于页展示是否装上且可运行）。
 *
 * 可运行判定：spawn `node.exe --version`——文件存在不等于可运行
 * （文件损坏 / 被杀软拦截 / 架构不符都在 spawn 期暴露），5s 超时快速失败。
 *
 * 注意：本模块保持纯函数（不 import electron 值）——isPackaged /
 * resourcesPath / appPath 由调用方（bootstrap/handlers.ts）注入，
 * 单测无需 mock Electron。
 */
import { execFile } from 'node:child_process';
import { existsSync as defaultExistsSync } from 'node:fs';
import { join } from 'node:path';

/** 路径解析输入（调用方从 Electron app 取值注入） */
export interface PortableNodePathInput {
  readonly isPackaged: boolean;
  /** 打包态 resources 目录（process.resourcesPath） */
  readonly resourcesPath: string;
  /** 应用根目录（app.getAppPath()；开发态为 apps/desktop） */
  readonly appPath: string;
}

/**
 * 便携 node.exe 期望路径（单一真源）。
 * - 打包态：<resources>/node/node.exe（extraResources，随 NSIS 安装）
 * - 开发态：<appPath>/build/node/node.exe（scripts/fetch-node.mjs 前置生成）
 */
export function resolvePortableNodeExePath(input: PortableNodePathInput): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'node', 'node.exe')
    : join(input.appPath, 'build', 'node', 'node.exe');
}

/** execFile 可注入子集（单测 mock 用；默认实现为 promisify(execFile) 薄封装） */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

/** 探测结果（与 ipc-contract runtimePortableNodeResSchema 对齐） */
export interface PortableNodeProbe {
  /** 便携 node.exe 期望路径（无论是否实际存在，支持诊断用） */
  readonly path: string;
  /** 文件存在 */
  readonly installed: boolean;
  /** --version 探测成功（installed=false 时恒为 false） */
  readonly runnable: boolean;
  /** 探测到的版本（如 v24.22.0；runnable=false 时缺失） */
  readonly version?: string;
  /** 探测失败原因（runnable=false 时存在，人类可读） */
  readonly error?: string;
}

/** --version 探测超时：正常 <300ms，杀软首扫可能秒级，5s 快速失败 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** 默认进程工厂：execFile 薄封装（显式封装避免 promisify 重载类型不兼容） */
function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout) => {
      // execFile 失败一律装箱 Error（满足 prefer-promise-reject-errors；message
      // 取属性而非 String(err)，避免 no-base-to-string 的对象字符串化）
      if (err) reject(new Error(err.message));
      else resolve({ stdout: String(stdout) });
    });
  });
}

/**
 * 探测便携 Node 状态。
 *
 * @param deps.exePath 期望路径（resolvePortableNodeExePath 产物）
 * @param deps.existsSync / deps.execFileFn 可注入依赖（单测用，缺省用真实实现）
 */
export async function probePortableNode(deps: {
  exePath: string;
  existsSync?: (path: string) => boolean;
  execFileFn?: ExecFileFn;
}): Promise<PortableNodeProbe> {
  const { exePath } = deps;
  const exists = (deps.existsSync ?? defaultExistsSync)(exePath);
  if (!exists) {
    return { path: exePath, installed: false, runnable: false };
  }
  const run = deps.execFileFn ?? defaultExecFile;
  try {
    const { stdout } = await run(exePath, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = stdout.trim();
    if (!version) {
      return { path: exePath, installed: true, runnable: false, error: '--version 输出为空' };
    }
    return { path: exePath, installed: true, runnable: true, version };
  } catch (e) {
    return {
      path: exePath,
      installed: true,
      runnable: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

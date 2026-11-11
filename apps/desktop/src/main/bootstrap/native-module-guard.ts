/**
 * 原生模块加载失败 · 启动兜底提示（dev.185）
 *
 * 背景（2026-11-11 dev.184 事故）：自动更新在「7z 解压完成后拷贝到安装目录」
 * 阶段被中断，app.asar 已是新版而 app.asar.unpacked/node_modules 只拷了一部分。
 * 当时主进程共享 chunk 顶层 require('better-sqlite3') 失败，用户看到的是
 * "A JavaScript error occurred in the main process / Uncaught Exception:
 * Cannot find module 'better-sqlite3'"，既无日志也无修复指引，只能反复双击图标。
 *
 * 现在 better-sqlite3 改为按需加载（storage/sqlite-factory.ts），启动点可以
 * 捕获加载失败并用本模块给出**可操作**的修复路径，然后以退出码 1 结束，避免
 * 带着半死状态继续做窗口初始化。
 *
 * 选型说明：用 dialog.showErrorBox 而不是 showMessageBox——前者不依赖 app ready
 * 之后的任何状态、同步返回、不要求 owner 窗口，是启动最早期唯一可靠的 UI 通道。
 */
import { app, dialog } from 'electron';

/** 对话框标题（排障时可直接按此串搜索日志 / issue）。 */
export const MISSING_NATIVE_MODULE_TITLE = '顽童浏览器无法启动：安装文件不完整';

/**
 * 显示「原生模块缺失」错误框。
 *
 * @param moduleName 缺失/加载失败的模块名（写入标题正文，便于用户回报）
 * @param detail 原始错误信息（保留 Cannot find module / NODE_MODULE_VERSION 等原文）
 */
export function showMissingNativeModuleError(moduleName: string, detail: string): void {
  dialog.showErrorBox(
    MISSING_NATIVE_MODULE_TITLE,
    [
      `主进程原生模块 ${moduleName} 未能加载，应用无法读取本地数据。`,
      '',
      '最常见原因：上一次自动更新没有装完——安装向导在解压/拷贝阶段被中断',
      '（安装途中手动启动应用、点了取消，或被杀软/断电打断），导致 app.asar',
      '已更新而 app.asar.unpacked\\node_modules 残缺。',
      '',
      '修复：重新运行最新安装包做覆盖安装即可；浏览器数据存放在数据目录，',
      '不在安装目录内，覆盖安装不会丢失。',
      '',
      `版本：${app.getVersion()}`,
      `安装位置：${process.resourcesPath}`,
      `错误详情：${detail}`,
    ].join('\n'),
  );
}

/**
 * better-sqlite3 加载失败的处理：提示 + 以退出码 1 结束。
 *
 * 设计取舍：不尝试降级启动（存储层是主窗口、设置、书签、历史的硬依赖，
 * 空库启动会让用户以为「数据全丢了」，比明确报错更糟）。
 */
export function abortOnSqliteLoadFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  showMissingNativeModuleError('better-sqlite3', detail);
  app.exit(1);
}

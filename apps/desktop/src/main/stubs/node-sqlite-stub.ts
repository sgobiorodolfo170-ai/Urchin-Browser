/**
 * node:sqlite 桩模块（兼容 Electron 32 / Node.js 20）
 *
 * 背景：
 * undici 的 SqliteCacheStore 模块在顶层执行 `require("node:sqlite")`，
 * 而 `node:sqlite` 是 Node.js 22.5+ 才加入的内置模块。
 * Urchin 使用 Electron 32.3.3（Node.js 20.x），没有该模块，导致主进程启动即崩溃。
 *
 * 方案：
 * 通过 vite alias 将 `node:sqlite` 指向本桩模块，使顶层 require 成功。
 * `DatabaseSync` 导出为抛出类，仅在真正实例化时才报错（Urchin 不使用 SqliteCacheStore，
 * 因此永远不会触发）。这样既不影响 undici 其他功能，也不阻塞主进程启动。
 */

export class DatabaseSync {
  constructor() {
    throw new Error(
      'node:sqlite is not available in this Electron runtime (Node.js 20.x). ' +
        'SqliteCacheStore is not supported. Use MemoryCacheStore instead.',
    );
  }
}

export type SQLInputValue = string | number | bigint | Uint8Array | null;

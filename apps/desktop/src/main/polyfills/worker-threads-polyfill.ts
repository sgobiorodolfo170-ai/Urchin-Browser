/**
 * node:worker_threads polyfill（兼容 Electron 32 / Node.js 20）
 *
 * 背景：
 * undici 的 webidl-converters 模块在加载时执行
 *   const { markAsUncloneable } = require("node:worker_threads");
 * 而 `markAsUncloneable` 是 Node.js 22.3+ 才加入的函数，Urchin 的
 * Electron 32.3.3（Node.js 20.x）没有该函数，解构得到 undefined，
 * 后续调用 `markAsUncloneable(value)` 时抛出 TypeError：
 *   "e.util.markAsUncloneable is not a function"
 * 导致主进程启动即崩溃。
 *
 * 方案：
 * 在主进程入口最顶部（早于 undici 加载）注入本 polyfill，
 * 当 `worker_threads.markAsUncloneable` 不存在时补上一个 no-op。
 * no-op 实现是安全的：该函数仅用于标记对象不可克隆以在
 * postMessage 时抛出 DataCloneError，Urchin 不通过 worker_threads
 * 传输不可克隆对象，因此跳过标记不会影响功能。
 *
 * 必须在所有其他模块（特别是 pi-ai/undici 间接依赖）之前 import。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerThreads = require('node:worker_threads') as {
  markAsUncloneable?: (value: unknown) => void;
  [key: string]: unknown;
};

if (typeof workerThreads.markAsUncloneable !== 'function') {
  workerThreads.markAsUncloneable = function markAsUncloneable(value: unknown): void {
    // no-op: Electron 32 / Node 20 不支持该 API，Urchin 不依赖其行为
    void value;
  };
}

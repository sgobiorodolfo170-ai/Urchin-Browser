/**
 * 渲染层 Logger（P1-11 修复）。
 *
 * 替换渲染层 26 处裸 console.error，提供结构化日志：
 * - dev 模式：pretty console（✗/⚠ + module + message + error）
 * - prod 模式：JSON console.error（Electron 主进程自动捕获渲染层 console 输出）
 *
 * 不 import @urchin/logger（Node 端用 process.pid/process.env，渲染层 bundling
 * 需额外 polyfill；渲染层只需 error/warn 两级 + error 对象，不需完整 LogEntry）。
 *
 * 未来扩展：prod 模式可经 IPC 转发至主进程统一日志（需新增 log.forward 通道），
 * 当前以 console.error 落地——Electron 自动将渲染层 console 输出汇聚到主进程日志。
 *
 * 接口设计为 error(msg, error?) 而非 error(msg, meta?)：
 * 现有代码全是 console.error('msg:', e) 模式，直接 replaceAll console.error→log.error
 * 即可迁移，无需逐个改参数（error 自动装箱为 { error: message } 结构）。
 */

/** 渲染层 Logger 接口（@urchin/logger 的子集）。 */
export interface RendererLogger {
  error(msg: string, error?: unknown): void;
  warn(msg: string, error?: unknown): void;
}

/*
 * Vite 构建期常量 import.meta.env.DEV 的最小类型声明。
 * tsconfig types 只有 "node"（无 vite/client），主/渲染/测试共用同一 tsconfig；
 * 渲染层代码由 Vite 构建，DEV 在 dev 构建静态替换为 true、prod 为 false。
 * `import.meta` 的类型是全局 ImportMeta，模块内 interface 不会作用于它，
 * 必须经 declare global 合并（与 vite/client 自身的声明模式一致）；
 * 若未来引入 vite/client 全量类型，此子集声明与其兼容合并，可安全移除。
 */
declare global {
  interface ImportMetaEnv {
    readonly DEV?: boolean;
  }
  interface ImportMeta {
    readonly env?: ImportMetaEnv;
  }
}

/** Vite 注入的 dev/prod 标志（构建期替换，非运行期判断）。 */
const isDev = Boolean(import.meta.env?.DEV);

/** error 对象归一为字符串：Error→message；string 原样；对象 JSON 序列化（避免 '[object Object]'）。 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'unknown';
  } catch {
    // 循环引用等不可序列化对象：JSON.stringify 抛错时兜底
    return '[unserializable]';
  }
}

/**
 * 创建渲染层 Logger 实例。
 *
 * @param module 模块名（如 'app' / 'status-bar' / 'omnibox'），用于日志定位
 */
export function createLogger(module: string): RendererLogger {
  function emit(level: 'ERROR' | 'WARN', msg: string, error?: unknown): void {
    const errorStr = error === undefined ? undefined : toErrorMessage(error);

    if (isDev) {
      // dev：人类可读，带图标和颜色
      const tag = level === 'ERROR' ? '✗' : '⚠';
      const errPart = errorStr ? ` → ${errorStr}` : '';
      const line = `${tag} [${module}] ${msg}${errPart}`;
      if (level === 'ERROR') {
        console.error(line);
      } else {
        console.warn(line);
      }
    } else {
      // prod：JSON 结构化，Electron 主进程捕获
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        module,
        message: msg,
        error: errorStr,
      });
      if (level === 'ERROR') {
        console.error(entry);
      } else {
        console.warn(entry);
      }
    }
  }

  return {
    error: (msg, error) => emit('ERROR', msg, error),
    warn: (msg, error) => emit('WARN', msg, error),
  };
}

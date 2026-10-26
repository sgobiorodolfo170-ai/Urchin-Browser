/**
 * 启动耗时打点（启动优化 B5，配套诊断设施）
 *
 * 背景：10/18 冷启动 84s 复盘依赖外部计时脚本（以窗口出现为观测点），主进程内部
 * 各阶段耗时无法归因。本模块把关键节点以 JSONL 追加到 `<userData>/logs/startup.log`，
 * 让「窗口先出」优化前后可用同一份确定性数据对比（AGENTS.md §一 独立验证）。
 *
 * 设计理由：
 * - 零依赖、同步 append：启动期单测级写入 ~0.1ms；初始化/写入失败一律静默
 *  （诊断设施绝不影响启动，符合「启动绝不阻塞」验收策略）。
 * - 只记固定标签与时间戳，不含 URL/标题/内容（隐私：docs/02-架构设计 §7.4）。
 * - 时间基准：t0 = 本模块加载时刻（index.ts 顶部早期 import，等价进程启动后尽早）；
 *   elapsedMs 相对 t0，uptimeMs（process.uptime()）供与外部进程计时对齐。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 时间基准：模块加载时刻（主进程启动后尽早）。 */
const t0 = Date.now();

/** 落盘路径（initStartupLog 前为 null，调用静默跳过）。 */
let logPath: string | null = null;

/**
 * 初始化打点日志（index.ts 顶层尽早调用一次，须在 userData 重定向之后）。
 *
 * @param userDataPath app.getPath('userData')
 */
export function initStartupLog(userDataPath: string): void {
  try {
    const path = join(userDataPath, 'logs', 'startup.log');
    mkdirSync(dirname(path), { recursive: true });
    logPath = path;
  } catch {
    logPath = null; // 初始化失败整体降级为静默，不 throw
  }
}

/** 打点（未初始化或写入失败时静默；仅固定标签 + 时间戳，无隐私数据）。 */
export function markStartup(mark: string): void {
  if (!logPath) return;
  try {
    const line = `${JSON.stringify({
      mark,
      elapsedMs: Date.now() - t0,
      uptimeMs: Math.round(process.uptime() * 1000),
      pid: process.pid,
    })}\n`;
    appendFileSync(logPath, line, 'utf8');
  } catch {
    /* 诊断静默 */
  }
}

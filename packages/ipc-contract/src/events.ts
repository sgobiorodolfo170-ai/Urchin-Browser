/**
 * @urchin/ipc-contract · 单向事件通道常量与 payload 类型
 *
 * 依据：契约 B §7 单向事件推送协议。
 * 主进程 `webContents.send(channel, payload)` 推送，渲染进程经 preload
 * `window.urchin.on(channel, cb)` 订阅。
 *
 * 设计理由（agents.md §七.2）：把事件通道名与 payload 类型收口在共享包内，
 * 主进程与渲染层共用同一常量与类型，消除既有「主进程导出常量、渲染层硬编码
 * 字符串」的字面量漂移风险。事件 payload 不走 ipcSchema（send-only，无
 * req/res 双向校验），主进程推送前按 IP6 一致性应做一次 zod parse；
 * 既有实现（translate:progress）为性能跳过 parse，本期 devtools 沿用该
 * 惯例——payload 由主进程 manager 按既定类型构造，渲染层按类型消费。
 */
import type {
  NetworkEntry,
  ConsoleEntry,
  DevtoolsState,
  DevtoolsUnavailableReason,
  DevtoolsTarget,
} from './schemas/ipc-schema';

/** M15 DevTools 数据批事件：state 变更 / network 批 / console 追加 / cleared。
 *  判别联合——渲染层按 `type` 字段分支处理。 */
export type DevtoolsEventPayload =
  | {
      type: 'state';
      tabId: number;
      state: DevtoolsState;
      reason?: DevtoolsUnavailableReason;
      target?: DevtoolsTarget;
    }
  | { type: 'network.batch'; tabId: number; entries: NetworkEntry[] }
  | { type: 'console.append'; tabId: number; entries: ConsoleEntry[] }
  | { type: 'cleared'; tabId: number; scope: 'network' | 'console' };

/** M15 DevTools 数据批事件通道。 */
export const DEVTOOLS_EVENT_CHANNEL = 'devtools:event';

/** M15 DevTools F12 开/关通知（主进程键盘拦截 → 渲染层唯一状态源）。无 payload。 */
export const DEVTOOLS_TOGGLE_CHANNEL = 'devtools:toggle';

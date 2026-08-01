/**
 * @urchin/provider-sdk · 模块入口
 *
 * 依据：04-模块全景 M11/M12 / 契约 A-提供方接口
 *
 * 第三方 Provider 开发者使用本 SDK 在 utility process 中运行 Provider：
 *
 * ```ts
 * import { runProvider } from '@urchin/provider-sdk';
 * import type { UrchinAIProvider } from '@urchin/ai-provider-contract';
 *
 * class MyProvider implements UrchinAIProvider { ... }
 *
 * void runProvider(() => new MyProvider(), { parentPort: process.parentPort! });
 * ```
 */
export { runProvider } from './runner';
export type { ProviderSdkOptions, ProviderSdkHandle } from './runner';
export { buildProviderContext } from './context';
export type {
  MessagePortLike,
  ParentPortLike,
  ParentPortMessageEvent,
  TimerProvider,
} from './types';
export { DEFAULT_TIMERS } from './types';

/**
 * 测试侧 ambient 声明补充（仅类型，不影响运行时）。
 *
 * 背景：`src/pi-server/tool-guards.ts` 与 `tool-overrides.ts` 从
 * `@earendil-works/pi-coding-agent` 取 `ToolDefinition` / 写入与编辑工具工厂。
 * 该包是 vendored 依赖（构建期由 esbuild 别名解析），仓库内既无 node_modules
 * 实体也无完整 ambient 声明；`src/pi-shims.d.ts` 只声明了少数工厂。
 *
 * 一旦测试引用上述模块，tsc 会连带检查它们，缺少导出即报 TS2305、并让相关
 * 类型退化成 error 类型（eslint 会连锁报 no-unsafe-*）。这里只补齐测试实际
 * 触达的导出，形状按源码用法最小化，不改变任何运行时行为。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- vendored pi 边界 ambient shim（与 src/pi-shims.d.ts 同款） */
declare module '@earendil-works/pi-coding-agent' {
  export interface ToolDefinition<TParams = unknown, TDetails = unknown, TExtra = unknown> {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    /**
     * 五参签名与真实 SDK 对齐：实现方按位置解构 `signal` / `ctx`，
     * 若只声明 `(...args: unknown[])`，参数会退化成 unknown，
     * 导致 `signal?.throwIfAborted()` 无法通过类型检查。
     */
    execute(
      id: string,
      params: TParams,
      signal?: AbortSignal,
      onUpdate?: (update: TDetails) => void,
      ctx?: any,
    ): Promise<any>;
    /** 仅用于消费泛型参数（与真实 SDK 的泛型形参对齐），运行时不存在。 */
    readonly __genericParams?: [TParams, TDetails, TExtra];
  }

  export const createWriteToolDefinition: (
    cwd: string,
    options?: { operations?: unknown },
  ) => ToolDefinition;

  export const createEditToolDefinition: (
    cwd: string,
    options?: { operations?: unknown },
  ) => ToolDefinition;
}

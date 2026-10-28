/* eslint-disable @typescript-eslint/no-explicit-any -- vendored pi 边界 ambient shim，宽松类型合理 */
/**
 * vendored pi 包的 ambient 类型 shim（typecheck 用；esbuild 经 build-pi-web.mjs
 * 别名打真实源码）。
 *
 * 为何不用 tsconfig paths 指向 vendor src：pi 源码用 `.ts` 扩展导入 +
 * 自有 strict 设置，与本项目 tsconfig.base 不兼容。ambient shim 让 typecheck
 * 通过；运行时由 esbuild 别名解析到真实 vendor src（已验证可打包）。
 *
 * 类型宽松（any）：这是 vendored 代码边界，M2B-1 只需 typecheck 通过 +
 * esbuild 打真实源码；M2B-3+ 接入完整会话/模型目录时收紧。
 */
declare module '@earendil-works/pi-agent-core' {
  export const Agent: new (opts: any) => {
    subscribe(listener: (event: any) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): void;
  };

  export type AgentEvent = any;

  export type AgentTool = any;

  export type StreamFn = any;
}

declare module '@earendil-works/pi-ai/compat' {
  export const streamSimple: any;

  export const getModel: any;

  export const getProviders: any;

  export type Model = any;

  export type Context = any;

  export type SimpleStreamOptions = any;

  export type AssistantMessageEvent = any;
}

declare module '@earendil-works/pi-ai' {
  export type Model = any;

  export type AssistantMessageEvent = any;
}

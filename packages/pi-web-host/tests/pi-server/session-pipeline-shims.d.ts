/**
 * 测试侧 ambient 声明补充（仅类型，不改变运行时）
 *
 * 背景：`src/pi-server/**` 在 tsconfig 中被 exclude，但一旦测试引用它们（会话流水线
 * 单测：session-parser / session-scan / session-list-scan / session-search /
 * session-branch / session-open / wait-subscription-scan / message-window /
 * message-deletion），tsc 会连带检查整条 import 闭包，而 vendored 包
 * `@earendil-works/pi-coding-agent` 在仓库内既无 node_modules 实体、`src/pi-shims.d.ts`
 * 也只声明了少数工厂函数，于是报 TS2305 并让相关类型退化成 error 类型
 * （eslint 连锁报 no-unsafe-*）。
 *
 * 这里只补齐上述测试实际触达的导出，形状按源码用法最小化：
 * - SessionInfo：会话列表条目（session-parser / session-search / session-list-scan）
 * - SessionEntry：会话条目（session-branch / message-deletion 的角色 / 工具调用判定）
 * - SessionManager：session-open 的构造器直灌与 session-parser 的 create().getSessionDir()
 *
 * 接口使用 `interface` 声明，便于与其他测试侧声明文件合并（同名 interface 会自动合并）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- vendored pi 边界 ambient shim，工具调用块形状因 provider 而异 */
declare module '@earendil-works/pi-coding-agent' {
  export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    parentSessionPath?: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText?: string;
  }

  export interface SessionEntry {
    type: string;
    id: string;
    parentId?: string | null;
    timestamp?: string | number;
    customType?: string;
    /** context_edit 记录的目标条目（源码在 type === "context_edit" 分支读取） */
    targetId: string;
    replacement?: unknown;
    message: {
      role: string;
      // 工具调用块结构因 provider 而异，源码按 block.type / block.id 访问，故用 any[] 兜底
      content: any[];
      toolCallId?: string;
      customType?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export interface SessionManager {
    getSessionDir(): string;
    getSessionFile(): string | null;
    setSessionFile(path: string): void;
    getSessionId(): string;
    getCwd(): string;
    getLeafId(): string | null;
    getBranch(): SessionEntry[];
    getEntries(): SessionEntry[];
    getHeader(): Record<string, unknown>;
    isPersisted(): boolean;
    appendMessage(message: unknown): SessionEntry;
    appendSessionInfo(name: string): void;
    appendCustomEntry(customType: string, data?: unknown): SessionEntry;
    appendContextEdit(targetId: string, replacement: unknown): SessionEntry;
    buildContextEntries(): SessionEntry[];
    branch(id: string): void;
  }

  export const SessionManager: {
    create(cwd: string, sessionDir?: string): SessionManager;
    open(path: string): SessionManager;
    inMemory(): SessionManager;
    new (
      cwd: string,
      sessionDir: string,
      sessionFile: string,
      persist: boolean,
      newSessionOptions: undefined,
      preloadedFileEntries: unknown[],
    ): SessionManager;
  };
}

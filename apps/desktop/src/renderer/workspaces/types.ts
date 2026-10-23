/**
 * Workspace（工作区）渲染层类型定义（TP7）。
 * 与主进程契约 @urchin/ipc-contract 的 workspaceSchema 对齐。
 */

export type WorkspaceColor = 'blue' | 'green' | 'amber' | 'rose' | 'violet' | 'cyan';

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly color: WorkspaceColor;
  readonly isDefault: boolean;
  readonly createdAt: number;
}

export const DEFAULT_WORKSPACE_ID = 'default';

/** IPC 调用错误解包：typedInvoke 以 `[CODE] message` 形式抛出。 */
export function extractIpcMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^\[[A-Z_]+\]\s*/, '');
}

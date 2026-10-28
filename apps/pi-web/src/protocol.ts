/** 前端协议类型镜像（与 packages/pi-web-host/src/types.ts 对齐） */

export type HostClientMessage =
  | { readonly type: 'hello'; readonly client?: string }
  | { readonly type: 'ping' }
  | { readonly type: 'prompt'; readonly text: string; readonly sessionId?: string }
  | { readonly type: 'abort' }
  | { readonly type: 'list_models' }
  | { readonly type: 'get_state' }
  | { readonly type: 'new_session' }
  | { readonly type: 'list_sessions' }
  | { readonly type: 'switch_session'; readonly sessionId: string };

export interface SessionSummary {
  readonly id: string;
  readonly firstMessage: string;
  readonly messageCount: number;
}

export type HostServerMessage =
  | {
      readonly type: 'hello_ok';
      readonly service: string;
      readonly version: string;
      readonly status: string;
      readonly provider?: string;
      readonly model?: string;
    }
  | { readonly type: 'pong'; readonly ts: number }
  | { readonly type: 'stream.chunk'; readonly content: string }
  | {
      readonly type: 'stream.end';
      readonly finishReason: string;
      readonly usage?: { promptTokens: number; completionTokens: number };
    }
  | {
      readonly type: 'tool_call';
      readonly toolName: string;
      readonly status: 'start' | 'end' | 'error';
    }
  | { readonly type: 'models'; readonly providers: readonly string[] }
  | { readonly type: 'state'; readonly streaming: boolean; readonly messageCount: number }
  | { readonly type: 'session_list'; readonly sessions: readonly SessionSummary[] }
  | { readonly type: 'session_created'; readonly sessionId: string }
  | {
      readonly type: 'session_switched';
      readonly sessionId: string;
      readonly messages: readonly {
        readonly role: 'user' | 'assistant';
        readonly content: string;
      }[];
    }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

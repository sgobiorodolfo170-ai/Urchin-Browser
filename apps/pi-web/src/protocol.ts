/** 前端协议类型镜像（与 packages/pi-web-host/src/types.ts 对齐） */

export type HostClientMessage =
  | { readonly type: 'hello'; readonly client?: string }
  | { readonly type: 'ping' }
  | { readonly type: 'prompt'; readonly text: string; readonly sessionId?: string }
  | { readonly type: 'abort' }
  | { readonly type: 'list_models' }
  | { readonly type: 'get_state' };

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
  | { readonly type: 'models'; readonly providers: readonly string[] }
  | { readonly type: 'state'; readonly streaming: boolean; readonly messageCount: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

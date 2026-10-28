/**
 * pi 阶段 2 托管服务 · WebSocket 消息处理（协议 v0）
 *
 * M2A 只实现 hello/hello_ok、ping/pong 与 error 归一化。M2B 将在此注入
 * AgentSession 事件流（text_delta / tool_execution_* 等），并扩展命令集。
 * 约定：单条消息 JSON 解析失败回 error(code='bad_message')；未知 type 回
 * error(code='unknown_type')。处理函数保持纯逻辑，便于单测。
 */
import type { WebSocket } from 'ws';
import type { HostClientMessage, HostServerMessage } from './types';

export interface WsMessageContext {
  readonly version: string;
  readonly provider?: string;
  readonly model?: string;
}

/** 归一化输出 JSON 消息到 WS（异常不上抛，记录后发送 error） */
export function sendJson(ws: WebSocket, message: HostServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* send 失败由连接生命周期处理 */
  }
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  sendJson(ws, { type: 'error', code, message });
}

/** 处理一条客户端消息（保持无状态，便于单测注入 fake ws） */
export function handleClientMessage(ws: WebSocket, raw: string, ctx: WsMessageContext): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(ws, 'bad_message', 'invalid JSON');
    return;
  }
  const msg = parsed as Partial<HostClientMessage>;
  switch (msg?.type) {
    case 'hello':
      sendJson(ws, {
        type: 'hello_ok',
        service: 'pi-web-host',
        version: ctx.version,
        status: 'ok',
        provider: ctx.provider,
        model: ctx.model,
      });
      break;
    case 'ping':
      sendJson(ws, { type: 'pong', ts: Date.now() });
      break;
    default:
      sendError(ws, 'unknown_type', `unsupported message type: ${String(msg?.type)}`);
      break;
  }
}

import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleClientMessage, sendJson, sendError } from '../src/ws-handler';

/** 捕获 send 的最小 fake ws */
function fakeWs(): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    send: vi.fn((payload: string | Buffer) => {
      sent.push(Buffer.isBuffer(payload) ? payload.toString() : String(payload));
    }),
  } as unknown as WebSocket;
  return { ws, sent };
}

function last(sent: string[]): Record<string, unknown> {
  return JSON.parse(sent.at(-1)! ?? '{}') as Record<string, unknown>;
}

const ctx = { version: '0.1.0-test' };

describe('handleClientMessage · hello', () => {
  it('replies hello_ok with service/version', () => {
    const { ws, sent } = fakeWs();
    handleClientMessage(ws, JSON.stringify({ type: 'hello', client: 'test' }), ctx);
    expect(last(sent)).toMatchObject({
      type: 'hello_ok',
      service: 'pi-web-host',
      version: '0.1.0-test',
      status: 'ok',
    });
  });
});

describe('handleClientMessage · ping', () => {
  it('replies pong with numeric ts', () => {
    const { ws, sent } = fakeWs();
    handleClientMessage(ws, JSON.stringify({ type: 'ping' }), ctx);
    const msg = last(sent);
    expect(msg.type).toBe('pong');
    expect(typeof msg.ts).toBe('number');
  });
});

describe('handleClientMessage · errors', () => {
  it('rejects invalid JSON with bad_message', () => {
    const { ws, sent } = fakeWs();
    handleClientMessage(ws, 'not json', ctx);
    expect(last(sent)).toMatchObject({ type: 'error', code: 'bad_message' });
  });
  it('rejects binary via caller (no binary path here); unknown type -> unknown_type', () => {
    const { ws, sent } = fakeWs();
    handleClientMessage(ws, JSON.stringify({ type: 'nope' }), ctx);
    expect(last(sent)).toMatchObject({ type: 'error', code: 'unknown_type' });
  });
});

describe('sendJson / sendError', () => {
  it('sendJson writes serialized message', () => {
    const { ws, sent } = fakeWs();
    sendJson(ws, { type: 'pong', ts: 1 });
    expect(sent).toEqual([JSON.stringify({ type: 'pong', ts: 1 })]);
  });
  it('sendError writes error envelope', () => {
    const { ws, sent } = fakeWs();
    sendError(ws, 'boom', 'nope');
    expect(last(sent)).toMatchObject({ type: 'error', code: 'boom', message: 'nope' });
  });
  it('sendJson swallows send exceptions', () => {
    const ws = {
      send: () => {
        throw new Error('closed');
      },
    } as unknown as WebSocket;
    expect(() => sendJson(ws, { type: 'pong', ts: 1 })).not.toThrow();
  });
});

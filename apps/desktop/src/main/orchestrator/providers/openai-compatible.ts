/**
 * OpenAI 兼容 Provider · 子进程入口
 *
 * 通过 config.baseUrl + config.apiKey 调用 /v1/chat/completions 端点，
 * 支持流式（SSE）和非流式响应。兼容 OpenAI / Azure OpenAI / Ollama / vLLM 等。
 *
 * 构建后由 utilityProcess.fork 加载，通过 MessagePort 与 Orchestrator 通信。
 *
 * 消息协议（与 orchestrator/types.ts 对齐）：
 * - 接收 init / stream / complete / abort / dispose
 * - 发送 ready / heartbeat / stream.chunk / stream.end / complete.response / error
 */
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

interface ProviderConfig {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

interface ChatRequest {
  readonly model?: string;
  readonly messages: readonly { role: string; content: string }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

interface OrchMessage {
  readonly kind: string;
  readonly providerId?: string;
  readonly config?: unknown;
  readonly conversationId?: string;
  readonly req?: ChatRequest;
}

interface MessagePortLike {
  postMessage(msg: unknown): void;
  start(): void;
  close(): void;
  on(event: 'message', listener: (msg: unknown) => void): void;
}

interface ParentPortEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePortLike[];
}

const manifest = {
  id: 'openai-compatible',
  name: 'OpenAI Compatible',
  version: '1.0.0',
  apiVersion: 'urchin-ai-provider/v1',
  capabilities: ['chat.completion', 'chat.completion.streaming'],
  authMethod: 'api_key',
  rateLimit: { requestsPerMin: 60 },
};

let orchPort: MessagePortLike | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let providerConfig: ProviderConfig = {};

const parentPort = (
  process as unknown as {
    parentPort: { on(event: 'message', listener: (e: ParentPortEvent) => void): void };
  }
).parentPort;

parentPort.on('message', (event: ParentPortEvent) => {
  const data = event.data as { kind?: string };
  if (data?.kind !== 'orch.init') return;
  orchPort = event.ports[0]!;
  orchPort.on('message', (msg: unknown) => {
    void handleMessage(msg as OrchMessage).catch((err: unknown) => {
      console.error('[openai-compatible] handler error', err);
    });
  });
  orchPort.start();
});

async function handleMessage(raw: OrchMessage): Promise<void> {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') return;
  switch (raw.kind) {
    case 'init':
      providerConfig = raw.config && typeof raw.config === 'object' ? raw.config : {};
      send({ kind: 'ready', manifest });
      startHeartbeat();
      console.log('[openai-compatible] ready, providerId=' + raw.providerId);
      break;
    case 'stream':
      await handleStream(raw);
      break;
    case 'complete':
      await handleComplete(raw);
      break;
    case 'abort':
      console.log('[openai-compatible] abort received, conv=' + raw.conversationId);
      break;
    case 'dispose':
      stopHeartbeat();
      if (orchPort && typeof orchPort.close === 'function') orchPort.close();
      process.exit(0);
      break;
  }
}

function getEndpoint(path: string): string {
  const baseUrl = (providerConfig.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
  return baseUrl + path;
}

function getApiKey(): string {
  return providerConfig.apiKey ?? '';
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers.Authorization = 'Bearer ' + key;
  return headers;
}

interface RequestOptions {
  readonly url: string;
  readonly body?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

interface RequestResult {
  readonly statusCode: number | undefined;
  readonly body: string;
}

/** 非流式请求硬超时（批次 5.1 子项）。 */
const REQUEST_TIMEOUT_MS = 120_000;

function request(options: RequestOptions): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    // AbortController 硬超时：上游挂死时 abort 触发 req 'error'（AbortError），
    // 否则 utility 子进程内的 HTTP 请求会永久悬挂——心跳超时（15s）只杀整个
    // provider 进程，不给单请求失败出口；120s 给足 LLM 长生成余量但有界。
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('request timeout after ' + REQUEST_TIMEOUT_MS + 'ms'));
    }, REQUEST_TIMEOUT_MS);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method ?? 'POST',
      headers: options.headers ?? getHeaders(),
      signal: controller.signal,
    };
    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        clearTimeout(timeout);
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        } else {
          resolve({ statusCode: res.statusCode, body });
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestStream(options: RequestOptions, onChunk: (parsed: unknown) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: options.headers ?? getHeaders(),
    };
    const req = lib.request(reqOptions, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c: Buffer) => {
          errBody += c.toString();
        });
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + errBody)));
        return;
      }
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            resolve();
            return;
          }
          try {
            onChunk(JSON.parse(data));
          } catch {
            // 忽略解析错误
          }
        }
      });
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function handleStream(msg: OrchMessage): Promise<void> {
  const conversationId = msg.conversationId;
  const req = msg.req;
  if (!req) return;
  const model = req.model ?? providerConfig.model ?? 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    messages: req.messages,
    stream: true,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  });

  try {
    await requestStream({ url: getEndpoint('/v1/chat/completions'), body }, (parsed) => {
      const delta = (parsed as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
        ?.delta;
      if (delta?.content) {
        send({ kind: 'stream.chunk', conversationId, chunk: { content: delta.content } });
      }
    });
    send({ kind: 'stream.end', conversationId, finishReason: 'stop' });
  } catch (err) {
    send({
      kind: 'error',
      conversationId,
      error: { message: String((err as Error).message ?? err), code: 'PROVIDER_ERROR' },
    });
  }
}

async function handleComplete(msg: OrchMessage): Promise<void> {
  const conversationId = msg.conversationId;
  const req = msg.req;
  if (!req) return;
  const model = req.model ?? providerConfig.model ?? 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    messages: req.messages,
    stream: false,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  });

  try {
    const result = await request({ url: getEndpoint('/v1/chat/completions'), body });
    const parsed = JSON.parse(result.body) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = parsed.choices?.[0]?.message?.content ?? '';
    send({
      kind: 'complete.response',
      conversationId,
      response: { content, role: 'assistant', finishReason: 'stop' },
    });
  } catch (err) {
    send({
      kind: 'error',
      conversationId,
      error: { message: String((err as Error).message ?? err), code: 'PROVIDER_ERROR' },
    });
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({
      kind: 'heartbeat',
      timestamp: Date.now(),
      stats: { activeStreams: 0, totalRequests: 0 },
    });
  }, 5000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function send(msg: unknown): void {
  if (!orchPort) return;
  try {
    orchPort.postMessage(msg);
  } catch (err) {
    console.error('[openai-compatible] postMessage failed', err);
  }
}

process.on('exit', () => {
  stopHeartbeat();
});

/**
 * mock-echo Provider · 参考实现（W5-D3）
 *
 * 这是 Urchin Browser 的内置示例 Provider，用于：
 * 1. 端到端验证 Orchestrator ↔ Provider Child 协议
 * 2. 作为第三方 Provider 开发者的参考实现
 *
 * 行为：
 * - 流式：把最后一条 user 消息反转，加 "Echo: " 前缀，按字符 chunk 输出
 * - 非流式：返回完整反转字符串
 *
 * 实现说明：
 * - 本文件是 CJS（utility process 加载 .js）
 * - 直接使用 Node.js process.parentPort（Electron utility process 提供）
 * - 不依赖外部包，自包含消息协议处理
 *
 * 第三方 Provider 可选择使用 @urchin/provider-sdk 简化开发。
 */

'use strict';

/** @type {ReturnType<typeof setInterval> | undefined} */
let heartbeatTimer;

/** @type {unknown} */
let orchPort = null;

/** Provider manifest（与 manifest.json 一致） */
const manifest = {
  id: 'mock-echo',
  name: 'Mock Echo Provider',
  version: '1.0.0',
  apiVersion: 'urchin-ai-provider/v1',
  capabilities: ['chat.completion', 'chat.completion.streaming'],
  authMethod: 'none',
  rateLimit: { requestsPerMin: 120 },
};

// ── 监听 parentPort：等待 orch.init 消息（含 transferred port） ──
process.parentPort.on('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.kind !== 'orch.init') return;

  const port = event.ports[0];
  if (!port) {
    console.error('[mock-echo] orch.init received but no port transferred');
    return;
  }
  orchPort = port;
  port.on('message', (msg) => {
    handleMessage(msg).catch((err) => {
      console.error('[mock-echo] message handler error', err);
    });
  });
  port.start();
  console.log('[mock-echo] port received, waiting for init');
});

/**
 * 处理 Orchestrator → Provider 消息。
 * @param {unknown} raw
 */
async function handleMessage(raw) {
  const msg = raw;
  if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;

  switch (msg.kind) {
    case 'init':
      await handleInit(msg);
      break;
    case 'stream':
      await handleStream(msg);
      break;
    case 'complete':
      await handleComplete(msg);
      break;
    case 'abort':
      handleAbort(msg);
      break;
    case 'dispose':
      await handleDispose();
      break;
  }
}

/**
 * 处理 init：发送 ready + 启动心跳。
 */
async function handleInit(msg) {
  // mock-echo 不需要真实初始化，直接发送 ready
  send({ kind: 'ready', manifest });
  startHeartbeat();
  console.log('[mock-echo] ready, providerId=' + msg.providerId);
}

/**
 * 处理 stream：流式返回反转内容。
 */
async function handleStream(msg) {
  const conversationId = msg.conversationId;
  const req = msg.req;
  const lastUser = getLastUserContent(req.messages);
  const reversed = reverseString(lastUser);
  const output = 'Echo: ' + reversed;

  try {
    // 按字符 chunk 输出
    for (let i = 0; i < output.length; i++) {
      send({
        kind: 'stream.chunk',
        conversationId,
        chunk: { content: output[i] },
      });
      // 模拟延迟
      await sleep(10);
    }
    send({
      kind: 'stream.end',
      conversationId,
      finishReason: 'stop',
      usage: { promptTokens: lastUser.length, completionTokens: output.length },
    });
  } catch (err) {
    send({
      kind: 'error',
      conversationId,
      error: { message: String(err), code: 'PROVIDER_ERROR' },
    });
  }
}

/**
 * 处理 complete：非流式返回反转内容。
 */
async function handleComplete(msg) {
  const conversationId = msg.conversationId;
  const req = msg.req;
  const lastUser = getLastUserContent(req.messages);
  const reversed = reverseString(lastUser);
  const output = 'Echo: ' + reversed;

  send({
    kind: 'complete.response',
    conversationId,
    response: {
      content: output,
      role: 'assistant',
      finishReason: 'stop',
      usage: { promptTokens: lastUser.length, completionTokens: output.length },
    },
  });
}

/**
 * 处理 abort：mock-echo 简化实现，仅记录日志。
 * 真实 Provider 应该在 stream 迭代中检查 abort 信号。
 */
function handleAbort(msg) {
  console.log('[mock-echo] abort received, conversationId=' + msg.conversationId);
}

/**
 * 处理 dispose：清理资源并退出。
 */
async function handleDispose() {
  console.log('[mock-echo] dispose received');
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (orchPort && typeof orchPort.close === 'function') {
    orchPort.close();
  }
  process.exit(0);
}

/**
 * 启动心跳定时器。
 */
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    send({
      kind: 'heartbeat',
      timestamp: Date.now(),
      stats: { activeStreams: 0, totalRequests: 0 },
    });
  }, 5000);
}

/**
 * 发送消息给 Orchestrator。
 * @param {unknown} msg
 */
function send(msg) {
  if (!orchPort) {
    console.warn('[mock-echo] cannot send message, port not ready');
    return;
  }
  try {
    orchPort.postMessage(msg);
  } catch (err) {
    console.error('[mock-echo] postMessage failed', err);
  }
}

// ─── 工具函数 ───

/**
 * 获取对话中最后一条 user 消息内容。
 * @param {unknown} messages
 */
function getLastUserContent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return m.content;
    }
  }
  return '';
}

/**
 * 反转字符串（保留 Unicode）。
 * @param {string} s
 */
function reverseString(s) {
  return Array.from(s).reverse().join('');
}

/**
 * sleep 工具。
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

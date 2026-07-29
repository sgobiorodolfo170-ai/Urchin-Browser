# 契约 I · M11 AI Orchestrator 内部契约

> 状态：Draft  · 日期：2026-07-27  · 关联决策：OR1-OR9
> 模块归属：utility process（官方代码）  · 关联模块：M8 / M12 / M17
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

Orchestrator 是 Main ↔ Provider Child 之间的「交通指挥」——自身**不跑第三方代码**，只做：
- 调度用户请求到对应 Provider Child
- 限流（按 Provider 自报 `manifest.rateLimit` 做令牌桶）
- 错误重试（NETWORK_ERROR / RATE_LIMITED 指数退避）
- 协议转译（Main 的 zod IPC → ProviderChild 的 MessagePort 流式）
- Provider Child 心跳监控与 crash 恢复

OR1 决策落地：1 主 Orchestrator + N Provider 子进程的两级 utility fork 拓扑。

## 2. 子进程生命周期

```typescript
// packages/ai-orchestrator/src/provider-host.ts
import { utilityProcess, MessageChannelMain, MessagePortMain } from 'electron';
import type { ProviderManifest } from '@urchin/ai-provider-contract';

interface ProviderHost {
  providerId: string;
  process: Electron.UtilityProcess;
  port: MessagePortMain;             // 与 Provider Child 的 port
  lastHeartbeat: number;
  state: 'initializing' | 'ready' | 'crashed' | 'disposed';
  manifest: ProviderManifest;
  rateLimiter: TokenBucket;
  heartbeatChecker?: NodeJS.Timeout;
  idleRecycler?: NodeJS.Timeout;
}

const HOSTS = new Map<string, ProviderHost>();
const HEARTBEAT_TIMEOUT_MS = 15_000;     // OR3 决策
const HEARTBEAT_INTERVAL_MS = 5_000;
const IDLE_RECYCLE_MS = 5 * 60_000;      // OR6 决策

class Orchestrator {
  /** OR2 决策：按需 spawn，首次调用时启动 */
  async ensureProviderLoaded(providerId: string): Promise<ProviderHost> {
    let host = HOSTS.get(providerId);
    if (host?.state === 'ready') {
      this.resetIdleRecycle(host);
      return host;
    }
    if (host?.state === 'crashed') {
      await this.disposeHost(providerId);   // OR7 决策：crash 后下次调用时重建
    }
    return this.spawnProvider(providerId);
  }

  private async spawnProvider(providerId: string): Promise<ProviderHost> {
    const manifest = await loadProviderManifest(providerId);
    const { port1, port2 } = new MessageChannelMain();

    const proc = utilityProcess.fork(
      require.resolve('./provider-child-entry.js'),
      [`--provider-id=${providerId}`],
      {
        serviceName: `urchin-ai-provider-${providerId}`,
        stdio: 'pipe',
      },
    );

    // 把 port2 传给子进程，port1 留给 Orchestrator
    proc.postMessage({ kind: 'init', providerId, port: port2 }, [port2]);

    const host: ProviderHost = {
      providerId,
      process: proc,
      port: port1,
      lastHeartbeat: Date.now(),
      state: 'initializing',
      manifest,
      rateLimiter: new TokenBucket(                          // OR4 决策
        manifest.rateLimit?.requestsPerMin ?? 60,
        manifest.rateLimit?.tokensPerMin,
      ),
    };

    port1.on('message', (msg) => this.handleProviderMessage(host, msg));
    port1.start();

    // OR3 决策：心跳超时检测
    host.heartbeatChecker = setInterval(() => {
      if (Date.now() - host.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.markCrashed(host, 'heartbeat timeout');
      }
    }, HEARTBEAT_INTERVAL_MS);

    // OR6 决策：空闲回收
    this.resetIdleRecycle(host);

    // 进程退出监听
    proc.on('exit', (code) => {
      if (host.state !== 'disposed') {
        this.markCrashed(host, `unexpected exit code=${code}`);
      }
    });

    HOSTS.set(providerId, host);
    return host;
  }

  private resetIdleRecycle(host: ProviderHost): void {
    if (host.idleRecycler) clearTimeout(host.idleRecycler);
    host.idleRecycler = setTimeout(() => {
      if (host.state === 'ready') {
        this.disposeHost(host.providerId);
      }
    }, IDLE_RECYCLE_MS);
  }

  private markCrashed(host: ProviderHost, reason: string): void {
    host.state = 'crashed';
    log.warn(`Provider ${host.providerId} crashed: ${reason}`);
    mainPort.postMessage({ kind: 'provider.crashed', providerId: host.providerId, reason });
  }
}
```

## 3. 心跳协议（OR3 决策）

```
[Provider Child] ── 每 5s ──► { kind: 'heartbeat', timestamp, stats: { active_streams, total_requests } }
[Orchestrator]   ── 收到 ──►  host.lastHeartbeat = Date.now()
[Orchestrator]   ── 15s 内未收 ──► markCrashed
```

Provider Child 实现必须每 5s 发心跳——这是契约**强制要求**，第三方 Provider 不发心跳会被 Orchestrator 视为 crashed 自动杀掉。契约测试覆盖（详见 [A-provider-api §8](./A-提供方接口.md#8-集成测试约定)）。

## 4. 令牌桶限流（OR4 决策）

```typescript
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacityPerMin: number,
    private tokenCapacityPerMin?: number,
  ) {
    this.tokens = capacityPerMin;
    this.lastRefill = Date.now();
  }

  /** 取 1 个请求 token，阻塞等待直到有可用 */
  async acquireRequestToken(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(100);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60_000;
    this.tokens = Math.min(this.capacityPerMin, this.tokens + elapsedMin * this.capacityPerMin);
    this.lastRefill = now;
  }
}
```

**OR4 决策落地**：每 Provider 独立桶，按 `manifest.rateLimit` 自报。否决全局共享桶——会与 Provider 自限速失配，可能造成 Provider 被 429。

## 5. 重试策略（OR5 决策）

```typescript
async function callWithRetry<T>(
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const host = await orchestrator.ensureProviderLoaded(providerId);
  const maxRetries = 3;       // OR5 决策：最多 3 次
  let attempt = 0;

  while (true) {
    try {
      await host.rateLimiter.acquireRequestToken();
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError && e.retryable && attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000;   // 1s, 2s, 4s 指数退避
        log.warn(`Provider ${providerId} attempt ${attempt + 1} failed, retrying in ${backoff}ms: ${e.message}`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw e;
    }
  }
}
```

## 6. 流式调用链路

```typescript
/**
 * 用户 invoke('ai.chat.start', { providerId, conversationId, messages, stream: true })
 * → Main 转发到 Orchestrator
 * → Orchestrator 调 host.port.postMessage({ kind: 'chat.start', ... })
 * → 同时创建一对 port 给 Main 中转回 Renderer
 * → Provider Child 收到 → provider.stream(req) → 流式 token 通过 port 回传
 */
async function startStream(
  req: CompletionRequest,
  rendererPort: MessagePortMain,
): Promise<void> {
  const host = await this.ensureProviderLoaded(req.providerId);

  // 把 renderer Port 与 Provider Child port 之间做双向桥接
  host.port.on('message', (msg) => {
    const parsed = StreamMessageSchema.safeParse(msg);    // IP6 决策：每条 zod parse
    if (!parsed.success) {
      log.warn(`Invalid stream message from Provider ${host.providerId}`, parsed.error);
      return;
    }
    rendererPort.postMessage(parsed.data);
  });

  // 监听 renderer 端 abort
  rendererPort.on('message', (msg) => {
    if (msg?.kind === 'abort') {
      host.port.postMessage({ kind: 'abort', conversationId: req.conversationId });
    }
  });

  host.port.postMessage({ kind: 'chat.start', req });
  host.port.start();
  rendererPort.start();
}
```

## 7. 与 M8 Storage 的协作

- Orchestrator **不直接访问 M8**——所有存储请求通过 IPC 转发给 Main 进程的 Storage Layer。
- ProviderContext.secrets 与 ProviderContext.storage 的实现是「Provider Child 通过 IPC 反向调用 Main」——见下表。

| Provider Child 请求 | Main 端 handler |
|---|---|
| `secrets.get(name)` | `provider.secrets.get { providerId, name }` → StorageLayer.secrets |
| `secrets.set(name, value)` | `provider.secrets.set { providerId, name, value }` → StorageLayer.secrets |
| `storage.get(key)` | `provider.storage.get { providerId, key }` → StorageLayer.providerStore(providerId) |
| `storage.set(key, value)` | `provider.storage.set { providerId, key, value }` → 同上 |

**安全约束**：Provider Child 只能访问 `providerId === self` 的命名空间——Main 端 handler 校验 `providerId` 与 caller Provider Child 一致，不一致直接抛 `IpcError('PERMISSION_DENIED')`。

## 8. Orchestrator 自身 crash 恢复（OR8 决策）

```typescript
// Main 进程检测 Orchestrator crash
orchestratorProcess.on('exit', (code) => {
  log.error(`AI Orchestrator crashed (code=${code}), restarting...`);
  // 通知所有 Renderer 端：AI 暂不可用
  for (const wc of allWebContents()) {
    wc.send('ai.orchestrator.crashed', { reason: 'restarting' });
  }
  // 重新 fork
  spawnOrchestrator();
  // 用户感知：5s 内 AI 不可用；Provider 状态丢失但 conversation 历史在 SQLite
});
```

**OR8 决策落地**：Main 检测后重新 fork Orchestrator，所有 Provider 状态丢失但用户感知为「AI 暂不可用 5 秒」。conversation 历史、Provider 配置都在 M8 SQLite 持久化，不丢。

否决方案「Orchestrator 持久化 state」：复杂度高，v0.2+ 评估是否需做。

## 9. Model Router（OR9 决策）

v0.1 **不做** Model Router——用户在 UI 手动选 Provider 与模型。

v0.5 引入（资源不足可延至 v0.6-v0.9 窗口，详见 [05-路线图 §4](../05-路线图.md)）：基于用户偏好（成本/速度/质量）+ Provider 能力声明（`capabilities`）+ 模型特征自动路由到最优 Provider。

## 10. 决策记录

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| OR1 | 主 Orchestrator 与 Provider Child 关系 | 1 主 + N Provider 子进程 | 主进程直 fork N Provider 失去调度/限流集中点 |
| OR2 | Provider 子进程冷启动时机 | 按需（首次调用时 spawn） | 应用启动时全 spawn 启动慢、资源占用高 |
| OR3 | 心跳间隔 | 5s 发 / 15s 超时 | 1s 发开销大；30s 超时 crash 检测慢 |
| OR4 | 令牌桶实现 | 每 Provider 独立桶，按 manifest.rateLimit 自报 | 全局共享桶与 Provider 自限速失配 |
| OR5 | 重试退避 | 指数 1s/2s/4s，最多 3 次 | 无重试用户体验差；无退避瞬间打爆 Provider |
| OR6 | 空闲回收 | 5 分钟无调用则 dispose 子进程 | 永久持有资源浪费 |
| OR7 | Provider Child crash 恢复 | 等下次调用 ensureProviderLoaded 时自动 spawn | 立即自动重启可能死循环 |
| OR8 | Orchestrator 自身 crash 恢复 | Main 检测后重新 fork，用户感知「AI 暂不可用 5s」 | 持久化 state 复杂度高，留 v0.2+ 评估 |
| OR9 | Model Router | v0.1 不做；v0.5 引入按能力路由（可延期，详见 05-路线图 §4） | v0.1 做复杂度高，需 Provider 能力 mapping 表 |

## 11. 未来演进

- v0.2: Orchestrator state 持久化（避免重启后丢失 Provider 加载状态）；更细粒度的 crash period 监控
- v0.5: Model Router（OR9）——按用户偏好/Provider 能力自动选模型、成本预估；Multi-region Provider 路由（同一 Provider 不同区域延迟优化）
- v1.0: 离线 fallback——主 Provider 不可用时自动切换到本地 LLM（如 ollama）

# 契约 A · M12 AI Provider Plugin API

> 状态：Draft  · 日期：2026-07-27  · 关联决策：D5 / IP1-IP4 / IP8
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

定义稳定的 Provider 插件契约，使第三方 LLM 提供方（OpenAI/Anthropic/智谱/ollama 等）能以独立进程加载，crash 不影响主浏览器，且 API 演进靠版本号协商而非破坏性变更。

## 2. Provider 接口（核心契约）

```typescript
// packages/ai-provider-contract/src/provider.ts

export interface UrchinAIProvider {
  /** 元数据：能力声明、版本、id */
  readonly manifest: ProviderManifest;

  /** 生命周期 */
  initialize(ctx: ProviderContext): Promise<void>;
  dispose(): Promise<void>;

  /** 核心调用：非流式 */
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** 核心调用：流式（AsyncIterator）— IP1 决策 */
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;

  /** 可选：embedding 向量化（v0.2+ 用） */
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** 可选：工具调用（function calling） */
  tools?(req: ToolCallRequest): Promise<ToolCallResponse>;
}
```

**关键设计理由**：
- 流式用 **AsyncIterable**（IP1 决策）：背压自然、pipeline 简单、跨进程 MessagePort 转译不需新协议层。SDK 内部可以是 SSE/EventSource/ReadableStream 任意实现，边界统一为 async iterator。
- `embed` 与 `tools` 是**可选能力**，由 `manifest.capabilities` 声明，调用前必须先查能力。

## 3. 能力声明（ProviderManifest）

```typescript
export interface ProviderManifest {
  /** 唯一标识，如 "openai" / "anthropic" / "ollama" / "urchin-custom-xxx" */
  id: string;
  /** 展示名 */
  name: string;
  /** Provider 实现自身版本（SemVer） */
  version: string;
  /** 契约版本：'urchin-ai-provider/v1' — IP2 决策，硬匹配 */
  apiVersion: string;
  /** 能力声明列表 */
  capabilities: ProviderCapability[];
  /** 用户配置表单的 schema（zod），单一真源 */
  configSchema: z.ZodSchema<ProviderConfig>;
  /** 鉴权方式 */
  authMethod: 'api_key' | 'oauth' | 'none' | 'local';
  /** 自报速率限制，Orchestrator 据此做令牌桶节流 */
  rateLimit?: { requestsPerMin: number; tokensPerMin: number };
}

export type ProviderCapability =
  | 'chat.completion'
  | 'chat.completion.streaming'
  | 'embedding'
  | 'tool_calling'
  | 'vision'
  | 'function_calling'
  | 'local_inference';
```

**版本协商（IP2 决策）**：Orchestrator 加载 Provider 时检查 `apiVersion` 是否在支持列表内（v0.1 仅 `'urchin-ai-provider/v1'`），不匹配直接拒载并报错给用户。Provider API 演进靠 SemVer 加版本号，旧 Provider 不会被静默破坏。

**`configSchema` 用 zod 的理由**：同一份 schema 既做表单生成（用户在 Settings UI 填 API key）又做运行时校验，避免「表单字段」与「校验规则」两套定义漂移。

## 4. 生命周期与上下文（ProviderContext）

```typescript
export interface ProviderContext {
  /** Provider 自己的配置（已校验过 configSchema） */
  readonly config: ProviderConfig;

  /** API key 安全访问（从 Main 的 safeStorage 取回，仅该 Provider 可见） */
  readonly secrets: SecretStore;

  /** 结构化日志（utility 进程日志，转发到 Main 再落盘） */
  readonly log: Logger;

  /** 取消信号（用户中止生成时触发）— 强制监听 */
  readonly abort: AbortSignal;

  /** Provider 私有 SQLite 命名空间，不与其他 Provider 共享 */
  readonly storage: ProviderStorage;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface ProviderStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  query<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
}
```

**关键设计理由**：
- `secrets` 不直接暴露 Electron `safeStorage`——抽象一层，便于以后切换到 keytar 或自研加密机制。
- `abort` 用标准 `AbortSignal`——`stream()` 内部 Provider 实现必须监听 `abort` 中断 SDK 调用，这是契约**强制要求**。违规实现（不响应 abort）会在集成测试中被拒。
- `storage` 是 Provider 私有命名空间——通过 SQLite 表名前缀 `provider_<providerId>_` 隔离，避免 Provider 之间互相污染。

## 5. 错误协议（结构化错误）

```typescript
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly cause?: unknown,
  ) { super(message); }
}

export type ProviderErrorCode =
  | 'AUTH_INVALID'          // api_key 错或过期
  | 'RATE_LIMITED'          // 429
  | 'NETWORK_ERROR'         // 网络异常
  | 'CONTEXT_TOO_LONG'      // 超出模型窗口
  | 'CONTENT_FILTERED'      // 内容被提供方拒绝
  | 'PROVIDER_ERROR'        // Provider 内部错误
  | 'INVALID_RESPONSE'      // 返回格式不合法
  | 'ABORTED'               // 用户取消
  | 'UNKNOWN';
```

**重试策略**：
- Orchestrator 对 `NETWORK_ERROR` / `RATE_LIMITED` 自动重试，指数退避 1s/2s/4s，最多 3 次（与 [contracts/I-orchestrator OR5](./I-编排器.md) 一致）。
- 对 `AUTH_INVALID` / `CONTEXT_TOO_LONG` / `CONTENT_FILTERED` 直接上报 UI，不重试。
- 未识别的异常统一装箱为 `UNKNOWN`，保留原始 `cause` 用于调试。

## 6. Provider 加载与隔离（IP3 / IP4 / IP8 决策）

### 加载方式（IP3）

```typescript
// Orchestrator 内部
async function loadProvider(providerPath: string): Promise<UrchinAIProvider> {
  const mod = await import(providerPath);   // ESM 动态导入
  const ProviderClass = mod.UrchinAIProvider ?? mod.default;
  if (!ProviderClass) throw new Error('Provider entry not found');
  return new ProviderClass();
}
```

- Provider 以 npm 包形式分发，`package.json` 的 `main` 字段指向实现文件。
- 命名导出 `UrchinAIProvider` 或 default 导出均可，灵活兼容现有 LLM SDK 包装。

### 隔离方式（IP4）

- **v0.1**: per-provider 子进程（每 Provider 一个 utility process fork）。
- 主 Orchestrator 进程不直接 `import` Provider 实现，而是 `utilityProcess.fork()` 启动 Provider Child。
- Provider Child 与 Orchestrator 之间通过 MessagePort 通信，MessagePort 协议见 [contracts/B-ipc-protocol](./B-进程间通信协议.md) §5。
- v0.2+ 若性能瓶颈出现，可考虑 per-provider 内部再 fork worker 处理高 CPU 任务（如本地 LLM 推理）。

### 加载范围（IP8）

- **v0.1**: 允许第三方加载（用户选本地路径或 npm 包名），但 UI 强制 warning：
  > 「第三方 Provider 代码将作为子进程运行，crash 不影响浏览器，但请确认来源可信。v0.1 未做签名校验。」
- 用户必须输入「我确认」才能继续。
- v0.1 不做签名校验；v0.4 引入 Provider manifest 签名 + 公钥 allowlist（与 NFR-SEC-07 对齐，未签名 Provider 加载由 warning 升级为拒绝）。

## 7. Provider 注册位置

```
%APPDATA%/Urchin/providers/<provider-id>/
  ├─ package.json
  ├─ manifest.json        # 序列化的 ProviderManifest，用于 UI 表单生成
  ├─ index.js / dist/     # 实现
  └─ node_modules/        # 依赖（pnpm install 隔离）
```

每个 Provider 独立目录，依赖隔离，避免版本冲突。

## 8. 集成测试约定

Provider 实现必须通过下列测试才能被官方推荐（v0.1 不强制，但写入文档作为推荐准入）：

1. `apiVersion` 协商通过
2. `complete()` 返回符合 schema 的 `CompletionResponse`
3. `stream()` AsyncIterator 正确 yield 多个 `CompletionChunk` 后正常结束
4. 监听 `abort` 信号 100ms 内中断 `stream()`
5. 抛错时必须是 `ProviderError` 实例，`code` 与 `retryable` 字段正确

## 9. 未来演进

- v0.2: 加 `embed` 与 `tools` 完整测试集。
- v0.3: 加 `vision` 能力（图片输入）。
- v0.4: 加 Provider 签名 allowlist（未签名拒载，与 NFR-SEC-07 对齐）。
- v1.0: 加 `local_inference` 能力标准（与本地 LLM 二进制如 ollama/llama.cpp 通信约定）。

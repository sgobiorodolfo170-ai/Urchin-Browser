/**
 * @urchin/provider-sdk · ProviderContext 构建
 *
 * 依据：契约 A §4 / 04-模块全景 M12
 *
 * 在 Provider Child 进程内构建 ProviderContext，传给 Provider.initialize()。
 *
 * v0.1 实现范围：
 * - config：从 init 消息注入（由 Orchestrator configProvider 读取）
 * - log：基于 @urchin/logger，输出到 console（utility process stdout）
 * - abort：每个 stream 调用一个独立 AbortController
 * - secrets：noop（v0.2+ 通过反向 IPC 调用 Main 的 safeStorage）
 * - storage：noop（v0.2+ 通过反向 IPC 调用 Main 的 StorageLayer.providerStore）
 */
import type { Logger } from '@urchin/logger';
import { createLogger } from '@urchin/logger';
import type {
  ProviderConfig,
  ProviderContext,
  ProviderStorage,
  SecretStore,
} from '@urchin/ai-provider-contract';

/** Noop SecretStore（v0.2+ 通过 IPC 实现真实访问） */
function makeNoopSecretStore(): SecretStore {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async
    async get() {
      return null;
    },
    async set() {
      // noop
    },
    async delete() {
      // noop
    },
  };
}

/** Noop ProviderStorage（v0.2+ 通过 IPC 实现真实访问） */
function makeNoopStorage(): ProviderStorage {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async
    async get() {
      return null;
    },
    async set() {
      // noop
    },
    async delete() {
      // noop
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async
    async query() {
      return [];
    },
  };
}

/**
 * 构建 ProviderContext。
 *
 * @param config Provider 配置（已校验过 configSchema）
 * @param abortSignal 当前流式调用的 AbortSignal
 * @param moduleName 日志模块名（默认 'provider'）
 */
export function buildProviderContext(
  config: ProviderConfig,
  abortSignal: AbortSignal,
  moduleName = 'provider',
): ProviderContext {
  const log: Logger = createLogger(moduleName);
  return {
    config,
    secrets: makeNoopSecretStore(),
    storage: makeNoopStorage(),
    log,
    abort: abortSignal,
  };
}

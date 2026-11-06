/**
 * ModelRuntime 懒加载持有器（第五批对接：模型管理域）。
 *
 * model-admin.ts 需要 ModelRuntime 实例（auth.json 凭据读写、getProviders、
 * 官方目录 refresh）。host 原先不持有 ModelRuntime（agent-bridge 直接用
 * Agent/streamSimple），这里按需创建并按 agentDir 缓存：
 *
 * - 懒加载：首次进入模型管理域才动态 import pi SDK 并 create（ADR-015 B1
 *   懒加载精神——空闲常驻进程不多加载重模块）；
 * - 每 agentDir 一实例：测试可对不同临时目录各建一份，互不污染；
 * - 失败不永久缓存：create 抛错（如磁盘/权限问题）时清缓存，下次重试。
 *
 * create 参数与全功能服务端一致（agent-session-services.ts:142）：auth.json /
 * models.json / models-store.json 都落在 agentDir 下。refreshOnCreate 默认
 * 开启但 allowModelNetwork 未传 → create 期只做离线 refresh（读缓存目录），
 * 与全功能服务端行为相同；refresh_builtin_models 在请求期自行带网络刷新。
 */
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type ModelRuntimeFactory = (agentDir: string) => Promise<ModelRuntime>;

export function createLazyModelRuntimeFactory(): ModelRuntimeFactory & { reset(): void } {
  const cache = new Map<string, Promise<ModelRuntime>>();
  const factory = (agentDir: string): Promise<ModelRuntime> => {
    let pending = cache.get(agentDir);
    if (!pending) {
      pending = (async () => {
        const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
        return (await ModelRuntime.create({
          authPath: join(agentDir, 'auth.json'),
          modelsPath: join(agentDir, 'models.json'),
        })) as ModelRuntime;
      })();
      cache.set(agentDir, pending);
      pending.catch(() => {
        // 创建失败（权限/磁盘等）：清缓存允许下次请求重试，不永久持有 rejected promise
        if (cache.get(agentDir) === pending) cache.delete(agentDir);
      });
    }
    return pending;
  };
  return Object.assign(factory, { reset: () => cache.clear() });
}

/**
 * M11 Orchestrator 单元测试
 *
 * 依据：契约 I §2 / OR1-OR7 决策
 *
 * 覆盖：
 * - Provider 生命周期（spawn / ready / dispose）
 * - 心跳协议（OR3：5s 发 / 15s 超时）
 * - 空闲回收（OR6：5 分钟）
 * - crash 恢复（OR7：下次调用时重建）
 * - 限流（OR4：每 Provider 独立桶）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { ProviderRegistry } from '../../src/main/orchestrator/provider-registry';
import { TokenBucket } from '../../src/main/orchestrator/token-bucket';
import {
  MockTimers,
  MockTokenBucket,
  createMockProcessFactory,
} from '../helpers/mock-orchestrator';
import type { ProviderManifest } from '@urchin/ai-provider-contract';

const SAMPLE_MANIFEST: ProviderManifest = {
  id: 'test-provider',
  name: 'Test Provider',
  version: '1.0.0',
  apiVersion: 'urchin-ai-provider/v1',
  capabilities: ['chat.completion', 'chat.completion.streaming'],
  configSchema: {} as never,
  authMethod: 'api_key',
  rateLimit: { requestsPerMin: 100 },
};

/** 创建临时 providers 目录并写入一个测试 Provider manifest */
function setupTempProviderDir(providerId: string, manifest: ProviderManifest): string {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-test-'));
  const providerDir = join(dir, providerId);
  mkdirSync(providerDir, { recursive: true });
  // 序列化 manifest 时排除 zod schema（无法 JSON.stringify）
  const { configSchema: _configSchema, ...serializable } = manifest;
  void _configSchema;
  writeFileSync(
    join(providerDir, 'manifest.json'),
    JSON.stringify({
      ...serializable,
      capabilities: [...manifest.capabilities],
    }),
  );
  writeFileSync(join(providerDir, 'index.js'), '// stub');
  return dir;
}

describe('Orchestrator', () => {
  let tempDir: string;
  let registry: ProviderRegistry;
  let mockFactory: ReturnType<typeof createMockProcessFactory>;
  let timers: MockTimers;
  let stateChanges: { id: string; state: string }[];
  let crashes: { id: string; reason: string }[];

  beforeEach(() => {
    tempDir = setupTempProviderDir('test-provider', SAMPLE_MANIFEST);
    registry = new ProviderRegistry(tempDir);
    registry.scan();
    mockFactory = createMockProcessFactory();
    timers = new MockTimers();
    stateChanges = [];
    crashes = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('ProviderRegistry', () => {
    it('scan 加载合法 Provider', () => {
      expect(registry.scan()).toBe(1);
      expect(registry.has('test-provider')).toBe(true);
    });

    it('list 返回所有注册项', () => {
      registry.scan();
      const list = registry.list();
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe('test-provider');
      expect(list[0]!.entryPath).toBe(join(tempDir, 'test-provider', 'index.js'));
    });

    it('get 返回 undefined 当 Provider 不存在', () => {
      expect(registry.get('non-existent')).toBeUndefined();
    });

    it('跳过非法 manifest', () => {
      // 写一个非法 manifest
      const badDir = join(tempDir, 'bad-provider');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'manifest.json'), '{not valid json');
      expect(registry.scan()).toBe(1); // 仅 test-provider 通过
    });

    it('跳过不支持 apiVersion 的 Provider', () => {
      const badVersionDir = join(tempDir, 'bad-version');
      mkdirSync(badVersionDir, { recursive: true });
      writeFileSync(
        join(badVersionDir, 'manifest.json'),
        JSON.stringify({
          id: 'bad-version',
          name: 'Bad',
          version: '1.0.0',
          apiVersion: 'urchin-ai-provider/v99',
          capabilities: [],
          authMethod: 'api_key',
        }),
      );
      expect(registry.scan()).toBe(1);
    });

    it('list 返回真实 capabilities 和 authMethod', () => {
      registry.scan();
      const reg = registry.list()[0]!;
      expect(reg.capabilities).toEqual(['chat.completion', 'chat.completion.streaming']);
      expect(reg.authMethod).toBe('api_key');
    });

    it('install 从本地路径安装第三方 Provider', () => {
      // 准备源目录
      const sourceDir = mkdtempSync(join(tmpdir(), 'urchin-src-'));
      const manifestPayload = {
        id: 'third-party-echo',
        name: 'Third Party Echo',
        version: '0.2.0',
        apiVersion: 'urchin-ai-provider/v1',
        capabilities: ['chat.completion.streaming'],
        authMethod: 'none',
      };
      writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify(manifestPayload));
      writeFileSync(join(sourceDir, 'index.js'), '// third party provider');

      const result = registry.install(sourceDir);
      expect(result.providerId).toBe('third-party-echo');

      // 注册表中应能查到
      const reg = registry.get('third-party-echo');
      expect(reg).toBeDefined();
      expect(reg!.authMethod).toBe('none');
      expect(reg!.capabilities).toEqual(['chat.completion.streaming']);

      // 清理
      rmSync(sourceDir, { recursive: true, force: true });
    });

    it('install 拒绝非绝对路径', () => {
      expect(() => registry.install('relative/path')).toThrow(/absolute local path/);
    });

    it('install 拒绝不存在的路径', () => {
      expect(() => registry.install(join(tmpdir(), 'non-existent-xyz'))).toThrow(/does not exist/);
    });

    it('install 拒绝 manifest 校验失败', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'urchin-src-'));
      writeFileSync(
        join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'Bad ID',
          name: 'Bad',
          version: 'not-semver',
          apiVersion: 'v1',
          capabilities: [],
          authMethod: 'unknown',
        }),
      );
      writeFileSync(join(sourceDir, 'index.js'), '// stub');
      expect(() => registry.install(sourceDir)).toThrow(/manifest validation failed/);
      rmSync(sourceDir, { recursive: true, force: true });
    });

    it('install 拒绝不支持的 apiVersion', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'urchin-src-'));
      writeFileSync(
        join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'future-provider',
          name: 'Future',
          version: '1.0.0',
          apiVersion: 'urchin-ai-provider/v99',
          capabilities: ['chat.completion'],
          authMethod: 'api_key',
        }),
      );
      writeFileSync(join(sourceDir, 'index.js'), '// stub');
      expect(() => registry.install(sourceDir)).toThrow(/unsupported apiVersion/);
      rmSync(sourceDir, { recursive: true, force: true });
    });

    it('install 拒绝已存在的 providerId', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'urchin-src-'));
      writeFileSync(
        join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'test-provider', // 与 SAMPLE_MANIFEST 相同
          name: 'Dup',
          version: '1.0.0',
          apiVersion: 'urchin-ai-provider/v1',
          capabilities: ['chat.completion'],
          authMethod: 'api_key',
        }),
      );
      writeFileSync(join(sourceDir, 'index.js'), '// stub');
      expect(() => registry.install(sourceDir)).toThrow(/already installed/);
      rmSync(sourceDir, { recursive: true, force: true });
    });

    it('remove 卸载已安装的 Provider', () => {
      registry.scan();
      expect(registry.has('test-provider')).toBe(true);
      registry.remove('test-provider');
      expect(registry.has('test-provider')).toBe(false);
      expect(registry.list()).toHaveLength(0);
    });

    it('remove 拒绝未注册的 providerId', () => {
      expect(() => registry.remove('non-existent')).toThrow(/not registered/);
    });

    it('reload 重新扫描所有 Provider', () => {
      expect(registry.scan()).toBe(1);
      // reload 应返回相同数量
      expect(registry.reload()).toBe(1);
      expect(registry.has('test-provider')).toBe(true);
    });
  });

  describe('ensureProviderLoaded', () => {
    it('首次调用 spawn 新进程', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        events: {
          onProviderStateChanged: (id, state) => stateChanges.push({ id, state }),
          onProviderCrashed: (id, reason) => crashes.push({ id, reason }),
        },
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      expect(host.providerId).toBe('test-provider');
      expect(host.state).toBe('initializing');
      expect(mockFactory.processes.length).toBe(1);
      expect(orchestrator.size).toBe(1);
    });

    it('未注册的 Provider 抛错', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      await expect(orchestrator.ensureProviderLoaded('non-existent')).rejects.toThrow(
        /not registered/,
      );
    });

    it('已 ready 的 Provider 直接返回，不重新 spawn', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      const host1 = await orchestrator.ensureProviderLoaded('test-provider');
      // 模拟 orchestrator 端 port 收到 child 发来的 ready 消息
      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'ready',
        manifest: SAMPLE_MANIFEST,
      });
      expect(host1.state).toBe('ready');

      const host2 = await orchestrator.ensureProviderLoaded('test-provider');
      expect(host2).toBe(host1);
      expect(mockFactory.processes.length).toBe(1); // 没重新 spawn
    });

    it('收到 ready 消息后状态变为 ready', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        events: {
          onProviderStateChanged: (id, state) => stateChanges.push({ id, state }),
        },
      });
      await orchestrator.ensureProviderLoaded('test-provider');

      // 模拟 orchestrator 端 port 收到 child 发来的 ready 消息
      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'ready',
        manifest: SAMPLE_MANIFEST,
      });

      expect(stateChanges).toContainEqual({ id: 'test-provider', state: 'ready' });
    });

    it('收到 heartbeat 更新 lastHeartbeat', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      const host = await orchestrator.ensureProviderLoaded('test-provider');
      const initial = host.lastHeartbeat;

      // 用 fake timers 推进系统时间，使 Date.now() 返回更大的值
      vi.useFakeTimers();
      vi.setSystemTime(initial + 1000);

      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'heartbeat',
        timestamp: Date.now(),
        stats: { activeStreams: 0, totalRequests: 0 },
      });

      expect(host.lastHeartbeat).toBeGreaterThan(initial);
      vi.useRealTimers();
    });
  });

  describe('心跳超时（OR3）', () => {
    it('心跳超时后标记为 crashed', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        events: {
          onProviderCrashed: (id, reason) => crashes.push({ id, reason }),
          onProviderStateChanged: (id, state) => stateChanges.push({ id, state }),
        },
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      const initialHeartbeat = host.lastHeartbeat;

      // 模拟时间过去了 16 秒（超过心跳超时）
      vi.useFakeTimers();
      vi.setSystemTime(initialHeartbeat + 16_000);

      // 触发一次心跳检查
      timers.tickInterval(host.heartbeatChecker);

      expect(host.state).toBe('crashed');
      expect(crashes.length).toBe(1);
      expect(crashes[0]!.id).toBe('test-provider');
      expect(crashes[0]!.reason).toContain('heartbeat timeout');
      expect(stateChanges).toContainEqual({ id: 'test-provider', state: 'crashed' });

      // 清理定时器
      vi.useRealTimers();
    });

    it('crash 后清理定时器', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        heartbeatTimeoutMs: 1,
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      const activeBeforeCrash = timers.activeCount;

      vi.useFakeTimers();
      vi.setSystemTime(host.lastHeartbeat + 2);
      timers.tickInterval(host.heartbeatChecker);

      // crash 后定时器应被清理（heartbeatChecker + idleRecycler 都应被清除）
      expect(timers.activeCount).toBeLessThan(activeBeforeCrash);

      vi.useRealTimers();
    });
  });

  describe('空闲回收（OR6）', () => {
    it('空闲超时后 dispose Provider', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        idleRecycleMs: 5 * 60_000,
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'ready',
        manifest: SAMPLE_MANIFEST,
      });
      expect(host.state).toBe('ready');

      // 触发 idleRecycler
      timers.tickTimeout(host.idleRecycler);
      await Promise.resolve();

      expect(orchestrator.size).toBe(0);
      expect(host.state).toBe('disposed');
    });

    it('ensureProviderLoaded 重置 idleRecycler', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        idleRecycleMs: 5 * 60_000,
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      // 先让 host 进入 ready 状态
      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'ready',
        manifest: SAMPLE_MANIFEST,
      });
      expect(host.state).toBe('ready');

      const firstRecycler = host.idleRecycler;

      // 再次调用，应重置 recycler
      await orchestrator.ensureProviderLoaded('test-provider');
      expect(host.idleRecycler).not.toBe(firstRecycler);
    });
  });

  describe('crash 恢复（OR7）', () => {
    it('crash 后下次调用重建进程', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        heartbeatTimeoutMs: 1,
      });

      const host1 = await orchestrator.ensureProviderLoaded('test-provider');
      expect(mockFactory.processes.length).toBe(1);

      // 触发 crash
      vi.useFakeTimers();
      vi.setSystemTime(host1.lastHeartbeat + 2);
      timers.tickInterval(host1.heartbeatChecker);
      expect(host1.state).toBe('crashed');

      // 再次调用应重建
      vi.useRealTimers();
      const host2 = await orchestrator.ensureProviderLoaded('test-provider');
      expect(mockFactory.processes.length).toBe(2); // 新进程
      expect(host2).not.toBe(host1);
      expect(host2.state).toBe('initializing');
    });

    it('进程异常退出触发 crashed', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        events: {
          onProviderCrashed: (id, reason) => crashes.push({ id, reason }),
        },
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      // 模拟进程异常退出
      mockFactory.processes[0]!.simulateExit(1);

      expect(host.state).toBe('crashed');
      expect(crashes.length).toBe(1);
      expect(crashes[0]!.reason).toContain('exit code=1');
    });
  });

  describe('disposeHost / disposeAll', () => {
    it('disposeHost 清理资源', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });

      const host = await orchestrator.ensureProviderLoaded('test-provider');
      expect(orchestrator.size).toBe(1);

      await orchestrator.disposeHost('test-provider');

      expect(orchestrator.size).toBe(0);
      expect(host.state).toBe('disposed');
      expect(mockFactory.processes[0]!.killed).toBe(true);
      // 所有定时器清理
      expect(timers.activeCount).toBe(0);
    });

    it('disposeHost 不存在的 Provider 不报错', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      await expect(orchestrator.disposeHost('non-existent')).resolves.toBeUndefined();
    });

    it('disposeAll 清理所有 Provider', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });

      await orchestrator.ensureProviderLoaded('test-provider');
      await orchestrator.disposeAll();

      expect(orchestrator.size).toBe(0);
      expect(timers.activeCount).toBe(0);
    });
  });

  describe('限流（OR4）', () => {
    it('使用 manifest.rateLimit.requestsPerMin 初始化桶', async () => {
      const tokenBuckets: MockTokenBucket[] = [];
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
        tokenBucketFactory: (rpm) => {
          const bucket = new MockTokenBucket();
          // 在 bucket 上记录 rpm 便于断言
          (bucket as unknown as { rpm: number }).rpm = rpm;
          tokenBuckets.push(bucket);
          return bucket;
        },
      });

      await orchestrator.ensureProviderLoaded('test-provider');
      expect(tokenBuckets.length).toBe(1);
      // SAMPLE_MANIFEST.rateLimit.requestsPerMin = 100
      expect((tokenBuckets[0]! as unknown as { rpm: number }).rpm).toBe(100);
    });

    it('manifest 未声明 rateLimit 时用默认 60 rpm', async () => {
      // 准备一个无 rateLimit 的 Provider
      const noLimitManifest: ProviderManifest = {
        ...SAMPLE_MANIFEST,
        id: 'no-limit',
        rateLimit: undefined,
      };
      const dir = setupTempProviderDir('no-limit', noLimitManifest);
      const reg = new ProviderRegistry(dir);
      reg.scan();

      const tokenBuckets: MockTokenBucket[] = [];
      const orchestrator = new Orchestrator({
        registry: reg,
        processFactory: mockFactory.factory,
        timers,
        tokenBucketFactory: (rpm) => {
          const bucket = new MockTokenBucket();
          (bucket as unknown as { rpm: number }).rpm = rpm;
          tokenBuckets.push(bucket);
          return bucket;
        },
      });

      await orchestrator.ensureProviderLoaded('no-limit');
      expect((tokenBuckets[0]! as unknown as { rpm: number }).rpm).toBe(60);

      rmSync(dir, { recursive: true, force: true });
    });

    it('默认用 TokenBucket 实现', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      const host = await orchestrator.ensureProviderLoaded('test-provider');
      expect(host.rateLimiter).toBeInstanceOf(TokenBucket);
    });
  });

  describe('getStates', () => {
    it('返回所有 Provider 状态', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      await orchestrator.ensureProviderLoaded('test-provider');

      const states = orchestrator.getStates();
      expect(states.length).toBe(1);
      expect(states[0]!.providerId).toBe('test-provider');
      expect(states[0]!.state).toBe('initializing');
    });
  });

  describe('invalid message', () => {
    it('忽略非对象消息', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      await orchestrator.ensureProviderLoaded('test-provider');
      // 不应抛错
      mockFactory.orchestratorPorts[0]!.emitMessage(null);
      mockFactory.orchestratorPorts[0]!.emitMessage('string');
      mockFactory.orchestratorPorts[0]!.emitMessage(42);
    });

    it('error 消息不触发 crash', async () => {
      const orchestrator = new Orchestrator({
        registry,
        processFactory: mockFactory.factory,
        timers,
      });
      const host = await orchestrator.ensureProviderLoaded('test-provider');
      mockFactory.orchestratorPorts[0]!.emitMessage({
        kind: 'error',
        error: { code: 'PROVIDER_ERROR', message: 'something went wrong' },
      });
      expect(host.state).toBe('initializing'); // 未变成 crashed
    });
  });
});

/**
 * WorkspaceSessionManager 单元测试。
 *
 * 验证：
 * 1. default 工作区 → session.defaultSession（不触发分区配置）
 * 2. 自定义工作区 → persist 分区，分区名符合命名空间约定
 * 3. 配置回调幂等（同一分区只配置一次）
 * 4. 非法工作区 id 拒绝
 * 5. clearData 清理 Cookie/缓存/认证缓存
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockSession {
  partition: string;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
  clearAuthCache: ReturnType<typeof vi.fn>;
}

/** vi.mock 工厂被提升到顶部，共享状态必须经 vi.hoisted 提供。 */
const electronMock = vi.hoisted(() => {
  const partitionRegistry = new Map<string, MockSession>();
  const makeSession = (partition: string): MockSession => ({
    partition,
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearAuthCache: vi.fn().mockResolvedValue(undefined),
  });
  const mockDefaultSession = makeSession('default');
  return { partitionRegistry, makeSession, mockDefaultSession };
});

vi.mock('electron', () => ({
  session: {
    defaultSession: electronMock.mockDefaultSession,
    fromPartition: (partition: string) => {
      let ses = electronMock.partitionRegistry.get(partition);
      if (!ses) {
        ses = electronMock.makeSession(partition);
        electronMock.partitionRegistry.set(partition, ses);
      }
      return ses;
    },
  },
}));

import {
  WorkspaceSessionManager,
  partitionForWorkspace,
} from '../../src/main/workspaces/workspace-sessions';

describe('WorkspaceSessionManager', () => {
  beforeEach(() => {
    electronMock.partitionRegistry.clear();
    vi.clearAllMocks();
  });

  it('should map default workspace to default session', () => {
    const mgr = new WorkspaceSessionManager();
    const ses = mgr.resolve('default');
    expect(ses).toBe(electronMock.mockDefaultSession);
  });

  it('should resolve custom workspace to persist partition with urchin namespace', () => {
    const mgr = new WorkspaceSessionManager();
    const ses = mgr.resolve('abc-123');
    expect(ses).toBe(electronMock.partitionRegistry.get('persist:urchin-workspace-abc-123'));
    expect(partitionForWorkspace('abc-123')).toBe('persist:urchin-workspace-abc-123');
  });

  it('should configure partition session exactly once', () => {
    const mgr = new WorkspaceSessionManager();
    const configure = vi.fn();
    mgr.setSessionConfigure(configure);

    mgr.resolve('work-1');
    mgr.resolve('work-1');
    mgr.resolve('work-1');

    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('should configure each distinct partition separately', () => {
    const mgr = new WorkspaceSessionManager();
    const configure = vi.fn();
    mgr.setSessionConfigure(configure);

    mgr.resolve('work-1');
    mgr.resolve('work-2');
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('should NOT configure the default session', () => {
    const mgr = new WorkspaceSessionManager();
    const configure = vi.fn();
    mgr.setSessionConfigure(configure);

    mgr.resolve('default');
    expect(configure).not.toHaveBeenCalled();
  });

  it('should reject invalid workspace ids', () => {
    const mgr = new WorkspaceSessionManager();
    expect(() => mgr.resolve('BAD!ID')).toThrow();
    expect(() => mgr.resolve('')).toThrow();
  });

  it('should clear storage/cache/auth-cache on clearData', async () => {
    const mgr = new WorkspaceSessionManager();
    mgr.setSessionConfigure(vi.fn());
    await mgr.clearData('work-1');
    const ses = electronMock.partitionRegistry.get('persist:urchin-workspace-work-1');
    expect(ses?.clearStorageData).toHaveBeenCalledTimes(1);
    expect(ses?.clearCache).toHaveBeenCalledTimes(1);
    expect(ses?.clearAuthCache).toHaveBeenCalledTimes(1);
  });
});

/**
 * Workspace（工作区）Session 管理器
 *
 * 依据：契约 D TP7 / 02-架构设计 §4 安全边界 / 03-技术栈（Electron session partition）
 * 职责：
 * 1. 工作区 id → Electron Session 解析
 *    - default 工作区 → session.defaultSession（既有登录态保留）
 *    - 自定义工作区 → session.fromPartition('persist:urchin-workspace-<id>')，
 *      Cookie/localStorage/IndexedDB/Service Worker/缓存 全隔离且自动持久化
 * 2. 对分区 session 幂等安装会话级配置（urchin:// 协议处理器、下载挂钩等）
 * 3. clearData：清空 Cookie/存储/缓存/HTTP 认证缓存
 *
 * 设计理由（AGENTS.md §六「进程隔离」）：
 * - 渲染层只传工作区 id，partition 字符串由本类解析，杜绝越权指定任意分区
 * - 配置回调由 index.ts 注入（依赖下载管理器等实例），本类不直接依赖具体模块
 * - WeakSet 幂等：同一 session 只配置一次，避免重复注册监听
 */
import { session } from 'electron';
import type { Session } from 'electron';
import { DEFAULT_WORKSPACE_ID } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';

const log = createLogger('workspace-sessions');

/** 分区前缀：持久化（persist:）+ 命名空间（urchin-workspace-）。 */
export const WORKSPACE_PARTITION_PREFIX = 'persist:urchin-workspace-';

/**
 * 工作区 → 分区名的纯函数（可单测）。
 */
export function partitionForWorkspace(workspaceId: string): string {
  return `${WORKSPACE_PARTITION_PREFIX}${workspaceId}`;
}

/**
 * Workspace Session 管理器。
 */
export class WorkspaceSessionManager {
  /** 已配置的 session（幂等防重）。 */
  private readonly configured = new WeakSet<Session>();

  /** 会话级配置回调（由 index.ts 注入：注册 urchin 协议 + 下载挂钩）。 */
  private configure?: (ses: Session) => void;

  /**
   * 注入会话配置回调。
   *
   * 回调在分区 session 首次解析（首开该工作区标签）时执行一次。
   * 默认工作区走 session.defaultSession，配置由既有启动路径负责，不在此处理。
   */
  setSessionConfigure(configure: (ses: Session) => void): void {
    this.configure = configure;
  }

  /**
   * 解析工作区对应的 Session。
   *
   * @throws 若自定义工作区 id 非法（防御脏请求；'default' 恒合法）。
   */
  resolve(workspaceId: string): Session {
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
      return session.defaultSession;
    }
    if (!/^[a-z0-9-]{1,64}$/.test(workspaceId)) {
      throw new Error(`非法工作区 id：${workspaceId}`);
    }
    const ses = session.fromPartition(partitionForWorkspace(workspaceId));
    this.configureOnce(ses);
    return ses;
  }

  /**
   * 清空工作区数据（Cookie/存储/缓存/HTTP 认证缓存）。
   *
   * 调用方须先完成「无打开标签」检查（IPC handler 层），避免清掉正在写入的会话。
   */
  async clearData(workspaceId: string): Promise<void> {
    const ses =
      workspaceId === DEFAULT_WORKSPACE_ID ? session.defaultSession : this.resolve(workspaceId);
    await ses.clearStorageData();
    await ses.clearCache();
    try {
      await ses.clearAuthCache();
    } catch (err) {
      // clearAuthCache 在部分 Electron 版本/平台可能不可用，忽略不影响主流程
      log.warn('clearAuthCache 失败', { error: String(err) });
    }
    log.info('workspace data cleared', { workspaceId });
  }

  /** 幂等配置：同一 session 只执行一次。 */
  private configureOnce(ses: Session): void {
    if (!this.configure || this.configured.has(ses)) return;
    this.configured.add(ses);
    this.configure(ses);
    log.info('workspace session configured');
  }
}

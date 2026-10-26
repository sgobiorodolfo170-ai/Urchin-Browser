/**
 * Workspace（工作区）注册表
 *
 * 依据：契约 B §3.1 workspace.* / 契约 D TP7（工作区 = 持久化 session 分区）
 * 职责：
 * 1. 管理工作区元数据集合（默认工作区 'default' 恒在，不可删除）
 * 2. create / update / remove / list / get
 * 3. 持久化到 Settings（workspaces.registry 键，非敏感元数据）
 *
 * 设计理由（AGENTS.md §七.2 + §六「Single Source of Truth」）：
 * - 元数据与 Cookie/存储解耦：Cookie 由 Chromium 分区自动落盘
 *   （<sessionData>/Partitions），本注册表只保存名字/颜色等非敏感元数据，
 *   不把凭据写进 SQLite
 * - 默认工作区映射 session.defaultSession，保证既有登录态升级无感
 * - 「删除/清空前必须无打开标签」的检查由 IPC handler 结合 TabManager 完成
 *   （本类只管元数据，不关心标签生命周期）
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_WORKSPACE_ID, workspaceColorSchema } from '@urchin/ipc-contract';
import type { Workspace, WorkspaceColor, WorkspaceId } from '@urchin/ipc-contract';
import { z } from 'zod';
import { createLogger } from '@urchin/logger';

const log = createLogger('workspace-registry');

/** 持久化存储版本（将来 schema 演进时据此迁移）。 */
const STORAGE_VERSION = 1;

/** 持久化记录形状：{ version, workspaces }。 */
export interface WorkspaceStoredRecord {
  version: number;
  workspaces: Workspace[];
}

/** 持久化契约（注入 SettingsManager 适配）。 */
export interface WorkspacePersistence {
  /** 读取原始存储值（无记录返回 null）。 */
  load(): unknown;
  /** 写入完整记录（调用方组织好 { version, workspaces }）。 */
  save(record: WorkspaceStoredRecord): void;
}

/** 存储记录 zod 校验（读取时防御脏数据）。 */
const storedRecordSchema = z.object({
  version: z.number().int().default(STORAGE_VERSION),
  workspaces: z.array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9-]+$/),
        name: z.string().trim().min(1).max(32),
        color: workspaceColorSchema,
        isDefault: z.boolean().default(false),
        createdAt: z.number().int().nonnegative(),
      })
      .strict(),
  ),
});

/** 默认工作区初始值（首次运行/记录损坏时种子使用）。 */
function defaultWorkspace(): Workspace {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区',
    color: 'blue',
    isDefault: true,
    createdAt: 0,
  };
}

/**
 * 规范化原始存储记录：
 * 丢弃非法条目、保证默认工作区恒在（且恒为唯一 default）。
 */
function normalizeStored(raw: unknown): WorkspaceStoredRecord {
  const parsed = storedRecordSchema.safeParse(raw);
  const input = parsed.success ? parsed.data.workspaces : [];
  if (!parsed.success) {
    log.warn('workspaces.registry 记录非法，按空状态重建', {
      error: parsed.error.message,
    });
  }

  const byId = new Map<string, Workspace>();
  for (const ws of input) {
    if (ws.id === DEFAULT_WORKSPACE_ID) {
      byId.set(DEFAULT_WORKSPACE_ID, { ...ws, isDefault: true });
    } else if (!byId.has(ws.id)) {
      byId.set(ws.id, { ...ws, isDefault: false });
    }
  }
  if (!byId.has(DEFAULT_WORKSPACE_ID)) {
    byId.set(DEFAULT_WORKSPACE_ID, defaultWorkspace());
  }

  return { version: STORAGE_VERSION, workspaces: Array.from(byId.values()) };
}

/**
 * 工作区注册表（元数据单一真源）。
 */
export class WorkspaceRegistry {
  private readonly workspaces: Map<WorkspaceId, Workspace>;

  constructor(private readonly persistence: WorkspacePersistence) {
    const record = normalizeStored(persistence.load());
    this.workspaces = new Map(record.workspaces.map((ws) => [ws.id, ws]));
    // 首次运行种子落盘（无记录时建立默认工作区持久化身份）
    this.save();
  }

  /** 返回全部工作区（默认工作区在首位）。 */
  list(): Workspace[] {
    const all = Array.from(this.workspaces.values());
    all.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    return all.map((ws) => ({ ...ws }));
  }

  /** 按 id 获取工作区副本。 */
  get(id: string): Workspace | undefined {
    const ws = this.workspaces.get(id);
    return ws ? { ...ws } : undefined;
  }

  /** 是否存在（供 session/标签解析器校验）。 */
  has(id: string): boolean {
    return this.workspaces.has(id);
  }

  /**
   * 创建工作区。
   *
   * @throws 若名称在 trim 后为空
   */
  create(input: { name: string; color: WorkspaceColor }): Workspace {
    const name = input.name.trim();
    if (!name) {
      throw new Error('工作区名称不能为空');
    }
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      color: input.color,
      isDefault: false,
      createdAt: Date.now(),
    };
    this.workspaces.set(workspace.id, workspace);
    this.save();
    log.info('workspace created', { id: workspace.id, name });
    return { ...workspace };
  }

  /**
   * 更新工作区（名称/颜色，仅传要改的字段）。
   *
   * @throws 若 id 不存在
   */
  update(id: string, patch: { name?: string; color?: WorkspaceColor }): Workspace {
    const existing = this.workspaces.get(id);
    if (!existing) {
      throw new Error(`工作区不存在：${id}`);
    }
    const next: Workspace = {
      ...existing,
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    };
    if (!next.name) {
      throw new Error('工作区名称不能为空');
    }
    this.workspaces.set(id, next);
    this.save();
    log.info('workspace updated', { id });
    return { ...next };
  }

  /**
   * 删除工作区。
   *
   * @throws 若为默认工作区（不可删除）或 id 不存在。
   * 调用方须先完成「无打开标签」检查（本类不感知标签）。
   */
  remove(id: string): void {
    if (id === DEFAULT_WORKSPACE_ID) {
      throw new Error('默认工作区不可删除');
    }
    if (!this.workspaces.has(id)) {
      throw new Error(`工作区不存在：${id}`);
    }
    this.workspaces.delete(id);
    this.save();
    log.info('workspace removed', { id });
  }

  /** 持久化到 Settings（仅非敏感元数据）。 */
  private save(): void {
    const record: WorkspaceStoredRecord = {
      version: STORAGE_VERSION,
      workspaces: Array.from(this.workspaces.values()),
    };
    this.persistence.save(record);
  }
}

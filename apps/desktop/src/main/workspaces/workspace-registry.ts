/**
 * Workspace（工作区）注册表
 *
 * 依据：契约 B §3.1 workspace.* / 契约 D TP7（工作区 = 持久化 session 分区）
 * 职责：
 * 1. 管理工作区元数据集合（默认工作区 'default' 恒在，不可删除，恒居首位）
 * 2. create / update / remove / list / get / reorder
 * 3. 持久化到 Settings（workspaces.registry 键，非敏感元数据 + 用户自定义顺序）
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

/** 持久化记录形状：{ version, workspaces, order }。order = 非默认工作区的
 *  用户自定义顺序（id 序列；默认工作区恒居首，不入 order）。 */
export interface WorkspaceStoredRecord {
  version: number;
  workspaces: Workspace[];
  order: string[];
}

/** 持久化契约（注入 SettingsManager 适配）。 */
export interface WorkspacePersistence {
  /** 读取原始存储值（无记录返回 null）。 */
  load(): unknown;
  /** 写入完整记录（调用方组织好 { version, workspaces }）。 */
  save(record: WorkspaceStoredRecord): void;
}

/** 存储记录 zod 校验（读取时防御脏数据）。order 为旧版本记录的可缺省字段，
 *  id 形状宽松校验——normalize 阶段会按现存工作区过滤，此处不抛错。 */
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
  order: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
});

/** 默认工作区初始值（首次运行/记录损坏时种子使用）。 */
function defaultWorkspace(): Workspace {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区',
    color: 'amber',
    isDefault: true,
    createdAt: 0,
  };
}

/**
 * 规范化原始存储记录：
 * 丢弃非法条目、保证默认工作区恒在（且恒为唯一 default）、应用用户自定义顺序。
 *
 * 顺序迁移策略（2026-11-15 拖拽重排引入 order 字段）：
 * - 旧记录无 order → 按 createdAt 升序生成（与既有 list() 排序完全一致，升级无感）
 * - 新记录有 order → 过滤掉已不存在/重复/默认工作区的条目后应用，
 *   缺失的工作区按 createdAt 排在末尾（防手改存储或降级升级丢顺序）
 */
function normalizeStored(raw: unknown): WorkspaceStoredRecord {
  // null / undefined = 尚无记录（首次运行，或键在 DEFAULT_SETTINGS 中默认为 null），
  // 按空状态种子默认工作区，不告警——否则每次首启都会刷一条假的「记录非法」。
  // 只有「确有记录但形状非法」才算真实脏数据，需要告警。
  const parsed = raw == null ? null : storedRecordSchema.safeParse(raw);
  const input = parsed?.success ? parsed.data.workspaces : [];
  const storedOrder = parsed?.success ? (parsed.data.order ?? null) : null;
  if (parsed && !parsed.success) {
    log.warn('workspaces.registry 记录非法，按空状态重建', {
      error: parsed.error.message,
    });
  }

  const byId = new Map<string, Workspace>();
  for (const ws of input) {
    if (ws.id === DEFAULT_WORKSPACE_ID) {
      byId.set(DEFAULT_WORKSPACE_ID, { ...ws, isDefault: true, color: 'amber' });
    } else if (!byId.has(ws.id)) {
      byId.set(ws.id, { ...ws, isDefault: false });
    }
  }
  if (!byId.has(DEFAULT_WORKSPACE_ID)) {
    byId.set(DEFAULT_WORKSPACE_ID, defaultWorkspace());
  }

  // 非默认工作区顺序：优先用户自定义 order，缺失时按 createdAt 升序（迁移兜底）。
  // pushById 统一去重/过滤：重复 id、已删除 id、默认工作区一律跳过。
  const nonDefault = input.filter((ws) => ws.id !== DEFAULT_WORKSPACE_ID);
  const seen = new Set<string>();
  const ordered: Workspace[] = [];
  const pushById = (id: string): void => {
    if (id === DEFAULT_WORKSPACE_ID || seen.has(id)) return;
    const ws = byId.get(id);
    if (!ws) return;
    seen.add(id);
    ordered.push(ws);
  };
  if (storedOrder) {
    for (const id of storedOrder) pushById(id);
  }
  for (const ws of [...nonDefault].sort((a, b) => a.createdAt - b.createdAt)) {
    pushById(ws.id);
  }

  // Map 插入序 = 展示序：默认工作区恒在首位，list() 无需再排序
  const workspaces = [byId.get(DEFAULT_WORKSPACE_ID)!, ...ordered];
  return { version: STORAGE_VERSION, workspaces, order: ordered.map((ws) => ws.id) };
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

  /** 返回全部工作区（默认工作区恒在首位；其后按用户自定义顺序，未自定义按创建序）。 */
  list(): Workspace[] {
    // 顺序由 normalizeStored / reorder / create 维护在 Map 插入序中，此处不再排序
    return Array.from(this.workspaces.values()).map((ws) => ({ ...ws }));
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

  /**
   * 重排非默认工作区（总览页拖拽，2026-11-15 用户指令）。
   *
   * @param orderedIds 非默认工作区的新顺序（默认工作区不入列、恒居首）
   * @throws 顺序与现存非默认工作区集合不一致（漏/重/多）或含默认工作区时——
   *         集合校验保证渲染层乐观更新与持久化真源不漂移
   */
  reorder(orderedIds: readonly string[]): void {
    const nonDefault = Array.from(this.workspaces.values()).filter((ws) => !ws.isDefault);
    const expected = new Set(nonDefault.map((ws) => ws.id));
    const received = new Set<string>();
    for (const id of orderedIds) {
      if (id === DEFAULT_WORKSPACE_ID) {
        throw new Error('默认工作区恒居首，不接受重排');
      }
      if (received.has(id)) {
        throw new Error(`工作区顺序重复：${id}`);
      }
      if (!expected.has(id)) {
        throw new Error(`工作区不存在：${id}`);
      }
      received.add(id);
    }
    if (received.size !== expected.size) {
      throw new Error('工作区顺序缺少部分工作区');
    }

    // 重建 Map 插入序：默认工作区在首位，其余按新顺序（条目引用原样保留；
    // 集合校验后条目必然存在，! 断言安全）
    const previous = new Map(this.workspaces);
    this.workspaces.clear();
    this.workspaces.set(DEFAULT_WORKSPACE_ID, previous.get(DEFAULT_WORKSPACE_ID)!);
    for (const id of orderedIds) {
      this.workspaces.set(id, previous.get(id)!);
    }
    this.save();
    log.info('workspace reordered', { order: orderedIds });
  }

  /** 持久化到 Settings（仅非敏感元数据 + 用户自定义顺序）。 */
  private save(): void {
    const values = Array.from(this.workspaces.values());
    const record: WorkspaceStoredRecord = {
      version: STORAGE_VERSION,
      workspaces: values,
      order: values.filter((ws) => !ws.isDefault).map((ws) => ws.id),
    };
    this.persistence.save(record);
  }
}

/**
 * WorkspaceRegistry 单元测试。
 *
 * 验证：
 * 1. 首次运行种子默认工作区并落盘
 * 2. 非法/损坏的持久化记录被规范化（默认工作区恒在、唯一）
 * 3. create / update / list / get / remove 语义
 * 4. 默认工作区保护（不可删除；可改名/换色）
 * 5. 名称 trim + 非空校验
 */
import { describe, it, expect } from 'vitest';
import { WorkspaceRegistry } from '../../src/main/workspaces/workspace-registry';
import type { WorkspacePersistence } from '../../src/main/workspaces/workspace-registry';
import { DEFAULT_WORKSPACE_ID } from '@urchin/ipc-contract';

function createPersistence(initial: unknown = null): WorkspacePersistence & {
  saved: unknown[];
} {
  const saved: unknown[] = [];
  return {
    load: () => initial,
    save: (record) => {
      saved.push(record);
    },
    saved,
  };
}

describe('WorkspaceRegistry', () => {
  it('should seed default workspace on first run and persist', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: DEFAULT_WORKSPACE_ID,
      isDefault: true,
      name: '默认工作区',
    });
    expect(persistence.saved.length).toBeGreaterThan(0);
  });

  it('should normalize corrupted stored records (guarantee default workspace)', () => {
    const persistence = createPersistence({
      version: 1,
      workspaces: [
        { id: 'bad-id!invalid', name: '非法 id', color: 'blue', isDefault: false, createdAt: 1 },
        null,
        'garbage',
      ],
    });
    const registry = new WorkspaceRegistry(persistence);

    const list = registry.list();
    expect(list.some((w) => w.id === DEFAULT_WORKSPACE_ID)).toBe(true);
    expect(list.filter((w) => w.id === 'bad-id!invalid')).toHaveLength(0);
  });

  it('should enforce single default workspace (default wins)', () => {
    const persistence = createPersistence({
      version: 1,
      workspaces: [
        { id: DEFAULT_WORKSPACE_ID, name: '默认', color: 'blue', isDefault: false, createdAt: 10 },
      ],
    });
    const registry = new WorkspaceRegistry(persistence);

    const def = registry.get(DEFAULT_WORKSPACE_ID);
    expect(def?.isDefault).toBe(true);
    expect(registry.list()[0]?.id).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('should create and list workspaces (default first)', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);

    registry.create({ name: '  工作甲  ', color: 'green' });
    registry.create({ name: '工作乙', color: 'rose' });

    const list = registry.list();
    expect(list[0]?.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(list).toHaveLength(3);
    expect(list[1]?.name).toBe('工作甲'); // trim
    expect(list[1]?.isDefault).toBe(false);
  });

  it('should update name and color', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    const ws = registry.create({ name: '待改', color: 'green' });

    const updated = registry.update(ws.id, { name: ' 改名  ', color: 'cyan' });
    expect(updated.name).toBe('改名');
    expect(updated.color).toBe('cyan');
    expect(registry.get(ws.id)?.color).toBe('cyan');
  });

  it('should allow renaming default workspace but reject blank name', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);

    registry.update(DEFAULT_WORKSPACE_ID, { name: '主要账号' });
    expect(registry.get(DEFAULT_WORKSPACE_ID)?.name).toBe('主要账号');

    expect(() => registry.update(DEFAULT_WORKSPACE_ID, { name: '   ' })).toThrow(
      '工作区名称不能为空',
    );
  });

  it('should reject blank names on create', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    expect(() => registry.create({ name: '   ', color: 'blue' })).toThrow('工作区名称不能为空');
  });

  it('should remove workspace and persist', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    const ws = registry.create({ name: '临时', color: 'amber' });

    registry.remove(ws.id);
    expect(registry.get(ws.id)).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('should reject removing the default workspace', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    expect(() => registry.remove(DEFAULT_WORKSPACE_ID)).toThrow('默认工作区不可删除');
  });

  it('should reject removing unknown workspace', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    expect(() => registry.remove('nope')).toThrow('工作区不存在');
  });

  it('should persist full record shape on mutation', () => {
    const persistence = createPersistence();
    const registry = new WorkspaceRegistry(persistence);
    registry.create({ name: '工作', color: 'violet' });

    const last = persistence.saved.at(-1) as { version: number; workspaces: unknown[] };
    expect(last.version).toBe(1);
    expect(last.workspaces.length).toBe(2);
  });
});

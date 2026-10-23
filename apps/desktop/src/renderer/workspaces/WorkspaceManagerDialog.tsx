/**
 * 工作区管理对话框（TP7）：重命名 / 更换颜色 / 清空数据 / 删除。
 * 由右键工作区选项卡触发；删除默认工作区被禁用。
 */
import { useState } from 'react';
import { Check, Trash2, Eraser } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Workspace, WorkspaceColor } from './types';
import { WORKSPACE_COLORS, WORKSPACE_COLOR_KEYS, workspaceInitial } from './workspace-colors';
import { extractIpcMessage } from './types';

export interface WorkspaceManagerDialogProps {
  readonly workspace: Workspace;
  readonly onClose: () => void;
  readonly onSave: (id: string, patch: { name?: string; color?: WorkspaceColor }) => Promise<void>;
  readonly onClearData: (id: string) => Promise<void>;
  readonly onRemove: (id: string) => Promise<void>;
}

export function WorkspaceManagerDialog({
  workspace,
  onClose,
  onSave,
  onClearData,
  onRemove,
}: WorkspaceManagerDialogProps): React.JSX.Element {
  const [name, setName] = useState(workspace.name);
  const [color, setColor] = useState<WorkspaceColor>(workspace.color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dirty = name.trim() !== workspace.name || color !== workspace.color;

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) {
      setError('工作区名称不能为空');
      return;
    }
    setSaving(true);
    try {
      await onSave(workspace.id, { name, color });
      onClose();
    } catch (err) {
      setError(extractIpcMessage(err));
      setSaving(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    if (
      !window.confirm(
        `确定清空「${workspace.name}」的 Cookie / 本地存储 / 缓存？\n该工作区需先无打开的标签，操作不可撤销。`,
      )
    ) {
      return;
    }
    try {
      await onClearData(workspace.id);
      onClose();
    } catch (err) {
      setError(extractIpcMessage(err));
    }
  };

  const handleRemove = async (): Promise<void> => {
    if (
      !window.confirm(
        `确定删除工作区「${workspace.name}」？\n将清除其 Cookie / 本地存储，且不可撤销。`,
      )
    ) {
      return;
    }
    try {
      await onRemove(workspace.id);
      onClose();
    } catch (err) {
      setError(extractIpcMessage(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-lg border border-border bg-surface p-4 shadow-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`管理工作区 ${workspace.name}`}
      >
        <div className="mb-3 flex items-center gap-2">
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold text-white',
              WORKSPACE_COLORS[workspace.color].avatar,
            )}
          >
            {workspaceInitial(workspace.name)}
          </span>
          <span className="text-sm font-medium text-text">管理工作区</span>
        </div>

        <label className="mb-1 block text-xs text-text-secondary">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          className="w-full rounded-md border border-border bg-surface-secondary px-2 py-1.5 text-sm text-text outline-none focus:border-primary/50"
        />

        <label className="mb-1 mt-3 block text-xs text-text-secondary">颜色</label>
        <div className="flex items-center gap-1.5">
          {WORKSPACE_COLOR_KEYS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`颜色 ${c}`}
              onClick={() => setColor(c)}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full transition-transform',
                WORKSPACE_COLORS[c].avatar,
                color === c ? 'scale-110 ring-2 ring-primary/60' : 'opacity-80 hover:opacity-100',
              )}
            >
              {color === c && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>

        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1">
            {!workspace.isDefault && (
              <button
                type="button"
                onClick={() => void handleRemove()}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-error hover:bg-error/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleClear()}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-warning hover:bg-warning/10"
            >
              <Eraser className="h-3.5 w-3.5" />
              清空数据
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-secondary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

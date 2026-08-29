/**
 * 通用确认弹窗（ConfirmDialog）
 *
 * 照 PiSettingsDialog 模板（fixed inset-0 z-50 + bg-black/50 遮罩 + 面板）。
 * 动作按钮数组驱动（2-4 键），Esc / 点击遮罩触发 onDismiss（不传则仅按钮可关）。
 * 供编辑器离开守卫（保存/放弃/取消）与其他确认场景复用。
 */
import { useEffect } from 'react';
import { Button, type ButtonVariant } from './button';

export interface ConfirmAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly autoFocus?: boolean;
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message?: string;
  readonly actions: readonly ConfirmAction[];
  readonly onDismiss?: () => void;
}

export function ConfirmDialog({ open, title, message, actions, onDismiss }: ConfirmDialogProps) {
  useEffect(() => {
    if (!open || !onDismiss) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
        </div>
        {message !== undefined && (
          <div className="px-4 py-3 text-sm text-text-secondary">{message}</div>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.variant ?? 'secondary'}
              size="sm"
              autoFocus={a.autoFocus}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

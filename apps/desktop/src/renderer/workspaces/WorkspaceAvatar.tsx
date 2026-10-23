/**
 * 工作区首字头像（TP7）：色块 + 名称首字，用于选项卡条/折叠态切换器。
 */
import { cn } from '../lib/utils';
import type { Workspace } from './types';
import { WORKSPACE_COLORS, workspaceInitial } from './workspace-colors';

export function WorkspaceAvatar({
  workspace,
  className,
}: {
  workspace: Workspace;
  className?: string;
}): React.JSX.Element {
  const color = WORKSPACE_COLORS[workspace.color]?.avatar ?? 'bg-gray-500';
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
        color,
        className ?? 'h-5 w-5 text-[10px]',
      )}
    >
      {workspaceInitial(workspace.name)}
    </span>
  );
}

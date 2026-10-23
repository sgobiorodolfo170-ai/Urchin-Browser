/**
 * Workspace 主题色板 + 首字头像工具（TP7）。
 * 色值映射必须写在字面量里（Tailwind JIT 静态扫描源码收集类名）。
 */
import type { WorkspaceColor } from './types';

/** 工作区色板：avatar 底色 / 选中态浅底 / 文字强调色。 */
export const WORKSPACE_COLORS: Record<
  WorkspaceColor,
  { readonly avatar: string; readonly activeBg: string; readonly activeText: string }
> = {
  blue: { avatar: 'bg-blue-500', activeBg: 'bg-blue-500/15', activeText: 'text-blue-600' },
  green: {
    avatar: 'bg-emerald-500',
    activeBg: 'bg-emerald-500/15',
    activeText: 'text-emerald-600',
  },
  amber: { avatar: 'bg-amber-500', activeBg: 'bg-amber-500/15', activeText: 'text-amber-600' },
  rose: { avatar: 'bg-rose-500', activeBg: 'bg-rose-500/15', activeText: 'text-rose-600' },
  violet: { avatar: 'bg-violet-500', activeBg: 'bg-violet-500/15', activeText: 'text-violet-600' },
  cyan: { avatar: 'bg-cyan-500', activeBg: 'bg-cyan-500/15', activeText: 'text-cyan-600' },
};

/** 工作区全部色值（新建时色板渲染用）。 */
export const WORKSPACE_COLOR_KEYS: readonly WorkspaceColor[] = [
  'blue',
  'green',
  'amber',
  'rose',
  'violet',
  'cyan',
];

/** 工作区首字：名称 trim 后取第一个字符（中文原样、拉丁/数字大写）；空名兜底「默」。 */
export function workspaceInitial(name: string): string {
  const t = name.trim();
  if (!t) return '默';
  const first = t.charAt(0);
  // 仅对 ASCII 字母大写化，中文/emoji 等 unicode 字符不改变
  return /^[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
}

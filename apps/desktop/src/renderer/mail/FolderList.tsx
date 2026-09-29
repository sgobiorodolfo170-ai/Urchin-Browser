import { Inbox, Loader2, PenSquare } from 'lucide-react';
import { folderDisplayName } from './folder-names';

interface MailFolder {
  path: string;
  name: string;
  flags: string[];
  exists: number;
  unseen: number;
}

export interface FolderListProps {
  folders: MailFolder[];
  selectedFolder: string;
  onSelect: (path: string) => void;
  loading: boolean;
  /** 写邮件回调（v0.2 发信功能入口） */
  onCompose?: () => void;
}

/** 文件夹排序优先级：INBOX 最前 → 特殊用途 → 其他按名称 */
const FOLDER_PRIORITY: Readonly<Record<string, number>> = {
  inbox: 0,
  '\\sent': 1,
  '\\drafts': 2,
  '\\trash': 3,
  '\\junk': 4,
  '\\archive': 5,
};

function folderSortKey(f: MailFolder): number {
  const pathLower = f.path.toLowerCase();
  if (pathLower === 'inbox') return 0;
  for (const flag of f.flags) {
    const p = FOLDER_PRIORITY[flag.toLowerCase()];
    if (p !== undefined) return p;
  }
  const nameMap: Readonly<Record<string, number>> = {
    'sent messages': 1,
    sent: 1,
    'sent items': 1,
    drafts: 2,
    draft: 2,
    'deleted messages': 3,
    trash: 3,
    deleted: 3,
    junk: 4,
    spam: 4,
    archive: 5,
  };
  const nameP = nameMap[f.name.toLowerCase()];
  if (nameP !== undefined) return nameP;
  return 99;
}

export function FolderList({
  folders,
  selectedFolder,
  onSelect,
  loading,
  onCompose,
}: FolderListProps) {
  const sorted = [...folders].sort((a, b) => {
    const pa = folderSortKey(a);
    const pb = folderSortKey(b);
    if (pa !== pb) return pa - pb;
    return folderDisplayName(a).localeCompare(folderDisplayName(b), 'zh-CN');
  });

  return (
    <div className="flex w-48 shrink-0 flex-col border-r border-border">
      {/* 写邮件按钮 */}
      {onCompose && (
        <button
          className="m-2 flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          onClick={onCompose}
        >
          <PenSquare className="h-4 w-4" />
          写邮件
        </button>
      )}
      <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-semibold uppercase text-text-secondary">
        文件夹
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
          </div>
        )}
        {!loading && sorted.length === 0 && (
          <div className="px-3 py-2 text-xs text-text-secondary">无文件夹</div>
        )}
        {sorted.map((f) => (
          <button
            key={f.path}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm ${
              f.path === selectedFolder
                ? 'bg-surface-secondary text-text'
                : 'text-text-secondary hover:bg-surface-secondary/50 hover:text-text'
            }`}
            onClick={() => onSelect(f.path)}
          >
            <Inbox className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate text-left">{folderDisplayName(f)}</span>
            {f.unseen > 0 && (
              <span className="shrink-0 rounded-full bg-blue-500 px-1.5 text-xs text-white">
                {f.unseen}
              </span>
            )}
            {f.unseen === 0 && f.exists > 0 && (
              <span className="shrink-0 text-xs text-text-secondary">{f.exists}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

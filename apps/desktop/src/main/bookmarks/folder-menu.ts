import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import type { BookmarkManager } from './bookmark-manager';

/** 从收藏夹真源按打开时的快照构建原生菜单，避免被网页原生视图遮挡。 */
export function openBookmarkFolderMenu(
  manager: BookmarkManager,
  sender: WebContents,
  req: { folderId: string; x: number; y: number },
): Promise<{ url: string | null }> {
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner) return Promise.resolve({ url: null });
  const all = manager.list();
  if (!all.some((item) => item.id === req.folderId && item.type === 'folder'))
    return Promise.resolve({ url: null });
  return new Promise((resolve) => {
    const build = (parentId: string, ancestors: Set<string>): MenuItemConstructorOptions[] => {
      const children = all.filter((item) => item.parentId === parentId);
      return children.length
        ? children.map((item) => ({
            label: item.title.replace(/&/g, '&&'),
            ...(item.type === 'folder'
              ? {
                  submenu: ancestors.has(item.id)
                    ? [{ label: '无法打开循环文件夹', enabled: false }]
                    : build(item.id, new Set([...ancestors, item.id])),
                }
              : { enabled: !!item.url, click: () => resolve({ url: item.url ?? null }) }),
          }))
        : [{ label: '此文件夹为空', enabled: false }];
    };
    Menu.buildFromTemplate(build(req.folderId, new Set([req.folderId]))).popup({
      window: owner,
      x: req.x,
      y: req.y,
      callback: () => resolve({ url: null }),
    });
  });
}

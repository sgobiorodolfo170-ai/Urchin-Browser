/**
 * Summary Manager · 摘要文档本地存储管理
 *
 * 职责：
 * 1. 管理摘要文档保存目录（summary.saveDirectory 设置）
 * 2. 扫描保存目录生成目录树（供左侧边栏展示）
 * 3. 保存生成的 HTML 文档到本地（按年月分目录）
 * 4. 删除已保存的文档
 *
 * 与 pi 模块隔离：本模块仅负责文件 I/O，不涉及任何 AI 调用。
 * AI 调用由 register-handlers 中的 SummaryAgent 实现（后续开发）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@urchin/logger';
import type { SummaryTreeNode, SummarySaveResult } from '@urchin/summary-agent';

const log = createLogger('summary-manager');

/** 默认保存目录名（相对于数据目录，当用户未配置时使用） */
const DEFAULT_SAVE_DIR_NAME = 'summaries';

/** 文件名非法字符（含 Windows 控制字符 0x00-0x1f），用于净化文档标题 */
// eslint-disable-next-line no-control-regex -- 文件名净化需要剔除控制字符
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export class SummaryManager {
  /** 用户配置的保存目录绝对路径（来自 summary.saveDirectory 设置） */
  private customSaveDirectory: string | null = null;

  /** 用户数据目录（默认保存目录的父目录；DD1 决策：摘要文档属用户个人数据，随数据目录） */
  constructor(private readonly dataDir: string) {}

  /** 设置用户自定义保存目录（空字符串/null 恢复默认） */
  setSaveDirectory(dir: string | null | undefined): void {
    this.customSaveDirectory = dir?.trim() ? path.resolve(dir.trim()) : null;
    log.info('save directory updated', { dir: this.customSaveDirectory ?? '(default)' });
  }

  /** 获取当前生效的保存根目录绝对路径 */
  getSaveDirectory(): string {
    return this.customSaveDirectory ?? path.join(this.dataDir, DEFAULT_SAVE_DIR_NAME);
  }

  /**
   * 扫描保存目录，生成目录树。
   *
   * 目录结构：按年月分组（YYYY-MM/），叶节点为 .html 文件。
   * 目录按名称降序排列（最新月份在前），文件按修改时间降序排列（最新在前）。
   */
  async listTree(): Promise<{ tree: SummaryTreeNode[]; rootPath: string }> {
    const rootPath = this.getSaveDirectory();
    const tree = await this.scanDir(rootPath, '');
    return { tree, rootPath };
  }

  /** 递归扫描目录，构建目录树节点 */
  private async scanDir(dirAbs: string, relPath: string): Promise<SummaryTreeNode[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return []; // 目录不存在或不可读
    }

    const nodes: SummaryTreeNode[] = [];
    for (const entry of entries) {
      const entryAbs = path.join(dirAbs, entry.name);
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        const children = await this.scanDir(entryAbs, entryRel);
        // 只包含有子节点的目录（跳过空目录）
        if (children.length > 0) {
          nodes.push({
            type: 'directory',
            name: entry.name,
            relativePath: `${entryRel}/`,
            children,
          });
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        const stat = await fs.stat(entryAbs).catch(() => null);
        nodes.push({
          type: 'file',
          name: entry.name,
          relativePath: entryRel,
          absolutePath: entryAbs,
          size: stat?.size,
          modifiedAt: stat?.mtimeMs,
        });
      }
    }

    // 排序：目录在前，文件在后；目录降序（最新月份在前），文件按修改时间降序
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      if (a.type === 'directory') return b.name.localeCompare(a.name);
      return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
    });

    return nodes;
  }

  /**
   * 保存 HTML 文档到本地。
   *
   * 文件命名：YYYY-MM-DD_文档标题.html
   * 保存路径：<saveDirectory>/YYYY-MM/YYYY-MM-DD_文档标题.html
   *
   * @param html HTML 内容
   * @param documentTitle 文档标题（用于文件名）
   * @returns 保存结果（含绝对路径与相对路径）
   */
  async saveDocument(html: string, documentTitle: string): Promise<SummarySaveResult> {
    const rootPath = this.getSaveDirectory();
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dateStr = `${yearMonth}-${String(now.getDate()).padStart(2, '0')}`;

    // 清理文件名中的非法字符（含 Windows 控制字符 0x00-0x1f）
    const safeTitle =
      documentTitle.replace(ILLEGAL_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim().slice(0, 80) ||
      'untitled';
    const fileName = `${dateStr}_${safeTitle}.html`;

    const monthDir = path.join(rootPath, yearMonth);
    await fs.mkdir(monthDir, { recursive: true });

    const filePath = path.join(monthDir, fileName);
    await fs.writeFile(filePath, html, 'utf-8');

    const relativePath = `${yearMonth}/${fileName}`;
    log.info('document saved', { filePath, relativePath, documentTitle });

    return { filePath, relativePath, documentTitle };
  }

  /** 删除指定文档 */
  async deleteDocument(absolutePath: string): Promise<void> {
    // 安全检查：确保路径在保存目录内，防止删除任意文件
    const rootPath = path.resolve(this.getSaveDirectory());
    const resolved = path.resolve(absolutePath);
    if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
      throw new Error(`Path outside save directory: ${absolutePath}`);
    }
    await fs.unlink(resolved);
    log.info('document deleted', { absolutePath });
  }
}

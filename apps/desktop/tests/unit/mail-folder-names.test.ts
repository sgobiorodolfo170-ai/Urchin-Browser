/**
 * M25 文件夹中文显示名映射 · 单元测试
 *
 * 验证：
 * 1. 特殊用途标志（\Inbox/\Sent 等）优先
 * 2. 常见英文名映射（大小写不敏感）
 * 3. 未识别名称原样返回（含中文自定义文件夹）
 */
import { describe, it, expect } from 'vitest';
import { folderDisplayName } from '../../src/renderer/mail/folder-names';

describe('folderDisplayName', () => {
  it('should map INBOX by path', () => {
    expect(folderDisplayName({ path: 'INBOX', name: 'INBOX', flags: [] })).toBe('收件箱');
  });

  it('should map by special-use flag first', () => {
    expect(folderDisplayName({ path: 'SomeOddName', name: 'SomeOddName', flags: ['\\Sent'] })).toBe(
      '已发送',
    );
  });

  it('should map common English names case-insensitively', () => {
    expect(folderDisplayName({ path: 'Sent Messages', name: 'Sent Messages', flags: [] })).toBe(
      '已发送',
    );
    expect(folderDisplayName({ path: 'DRAFTS', name: 'DRAFTS', flags: [] })).toBe('草稿箱');
    expect(
      folderDisplayName({ path: 'Deleted Messages', name: 'Deleted Messages', flags: [] }),
    ).toBe('已删除');
    expect(folderDisplayName({ path: 'Junk', name: 'Junk', flags: [] })).toBe('垃圾邮件');
  });

  it('should keep custom folder name as-is', () => {
    expect(folderDisplayName({ path: '工作/项目A', name: '项目A', flags: [] })).toBe('项目A');
  });

  it('should fall back to path when name is empty', () => {
    expect(folderDisplayName({ path: 'INBOX', name: '', flags: [] })).toBe('收件箱');
  });

  it('should handle flags case-insensitively', () => {
    expect(folderDisplayName({ path: 'X', name: 'X', flags: ['\\trash'] })).toBe('已删除');
  });
});

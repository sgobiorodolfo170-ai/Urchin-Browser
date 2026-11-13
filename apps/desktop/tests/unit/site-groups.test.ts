import { describe, it, expect } from 'vitest';
import { groupSitePages } from '../../src/renderer/home/site-groups';

describe('主页网站归集', () => {
  it('跨协议和 www 归集，完整地址保留并按时间倒序，重复页面保留最新', () => {
    const groups = groupSitePages([
      { url: 'https://example.com/old?A=B', title: '旧', time: 1 },
      { url: 'http://www.example.com/new', title: '新', time: 4 },
      { url: 'https://example.com/old?A=B', title: '重新浏览', time: 3 },
      { url: 'https://other.com/a', title: '其他', time: 2 },
      { url: 'javascript:alert(1)', title: '无效', time: 9 },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['example.com', 'other.com']);
    expect(groups[0]!.pages.map((p) => p.title)).toEqual(['新', '重新浏览']);
    expect(groups[0]!.pages[1]!.url).toBe('https://example.com/old?A=B');
  });
  it('空数据、文件夹无网址、子域隔离和图标回退', () => {
    expect(groupSitePages([])).toEqual([]);
    const groups = groupSitePages([
      { url: 'bad', title: '', time: 5 },
      { url: 'https://a.example.com/a', title: '', time: 4 },
      { url: 'https://a.example.com/b', title: '', time: 3, favicon: 'local' },
      { url: 'https://b.example.com/a', title: '', time: 2 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.favicon).toBe('local');
  });
});

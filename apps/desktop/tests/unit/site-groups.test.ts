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
  it('空数据、文件夹无网址、子域归集和图标回退', () => {
    expect(groupSitePages([])).toEqual([]);
    const groups = groupSitePages([
      { url: 'bad', title: '', time: 5 },
      { url: 'https://a.example.com/a', title: '', time: 4 },
      { url: 'https://a.example.com/b', title: '', time: 3, favicon: 'local' },
      { url: 'https://b.example.com/a', title: '', time: 2 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.favicon).toBe('local');
  });
});

const groupUrls = (...urls: string[]) =>
  groupSitePages(urls.map((url, i) => ({ url, title: String(i), time: urls.length - i })));

describe('网站身份边界', () => {
  it('Agnes AI 跨域名和多层子域合并，保留完整网页地址', () => {
    const urls = ['https://agnes-ai.com/', 'https://platform.agnes-ai.cn/login?next=%2Fapp#form'];
    const groups = groupUrls(...urls, 'https://docs.platform.agnes-ai.cn/help');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('agnes-ai.com');
    expect(groups[0]!.pages.slice(0, 2).map((p) => p.url)).toEqual(urls);
    expect(groupUrls(...[...urls].reverse())[0]!.key).toBe('agnes-ai.com');
  });
  it('复用目录跨域别名，最具体的产品归属优先', () => {
    expect(groupUrls('https://x.com/', 'https://twitter.com/home')).toHaveLength(1);
    const groups = groupUrls(
      'https://qq.com/',
      'https://mp.weixin.qq.com/',
      'https://weixin.qq.com/',
    );
    expect(groups.map((g) => g.pages.length)).toEqual([1, 2]);
  });
  it('按公共后缀识别主域，隔离不同网站与托管租户', () => {
    expect(groupUrls('https://a.example.co.uk/', 'https://b.example.co.uk/')).toHaveLength(1);
    expect(groupUrls('https://example.co.uk/', 'https://other.co.uk/')).toHaveLength(2);
    expect(groupUrls('https://alice.github.io/', 'https://bob.github.io/')).toHaveLength(2);
    expect(groupUrls('https://www.github.io/', 'https://github.io/')).toHaveLength(2);
    expect(groupUrls('https://docs.alice.github.io/', 'https://alice.github.io/')).toHaveLength(1);
  });
  it('不按相似名称、标题或域名子串跨站合并', () => {
    expect(
      groupUrls(
        'https://agnes-ai.com/',
        'https://agnes-ai.org/',
        'https://evil-agnes-ai.com/',
        'https://agnes-ai.com.evil.test/',
      ),
    ).toHaveLength(4);
  });
  it('规范化大小写、尾点与默认端口，保留独立服务端口', () => {
    expect(groupUrls('https://AGNES-AI.COM.:443/', 'http://platform.agnes-ai.cn:80/')).toHaveLength(
      1,
    );
    expect(
      groupUrls(
        'https://example.com/',
        'https://example.com:8443/',
        'http://localhost:3000/',
        'http://localhost:4000/',
        'http://127.0.0.1/',
        'http://127.0.0.2/',
        'http://[::1]/',
      ),
    ).toHaveLength(7);
    expect(groupUrls('https://a.internal/', 'https://b.internal/')).toHaveLength(2);
  });
});

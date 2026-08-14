/**
 * 内置常见网站目录（主页站点比对用）
 *
 * 2026-08-14 设计：主页常用/最近书签的图标与名称优先从本目录比对——
 * 命中内置条目则使用本地打包图标（不依赖外部网络），未命中再回退外部 favicon 服务。
 *
 * 图标资源：renderer/public/sites/<key>.png（由 scripts/fetch-site-icons 批量下载打包）。
 * 新增站点：在 SITE_DIRECTORY 登记 { key, domains[], name }，并将图标下载到 public/sites/<key>.png。
 */

/** 内置站点条目 */
export interface BuiltinSite {
  /** 图标文件名（不含扩展名，对应 public/sites/<key>.png） */
  readonly key: string;
  /** 该站点可匹配的域名（含/不含 www，统一小写） */
  readonly domains: readonly string[];
  /** 站点显示名 */
  readonly name: string;
}

/** 内置常见网站目录（按 key 排序） */
export const SITE_DIRECTORY: readonly BuiltinSite[] = [
  { key: 'baidu', domains: ['baidu.com', 'www.baidu.com'], name: '百度' },
  { key: 'bing', domains: ['bing.com', 'www.bing.com', 'cn.bing.com'], name: '必应' },
  { key: 'google', domains: ['google.com', 'www.google.com', 'google.com.hk'], name: 'Google' },
  { key: 'github', domains: ['github.com', 'www.github.com'], name: 'GitHub' },
  { key: 'gitee', domains: ['gitee.com'], name: 'Gitee' },
  { key: 'bilibili', domains: ['bilibili.com', 'www.bilibili.com'], name: '哔哩哔哩' },
  { key: 'douyin', domains: ['douyin.com', 'www.douyin.com'], name: '抖音' },
  { key: 'youtube', domains: ['youtube.com', 'www.youtube.com', 'm.youtube.com'], name: 'YouTube' },
  { key: 'zhihu', domains: ['zhihu.com', 'www.zhihu.com'], name: '知乎' },
  { key: 'weibo', domains: ['weibo.com', 'www.weibo.com'], name: '微博' },
  { key: 'qq', domains: ['qq.com', 'www.qq.com', 'im.qq.com'], name: '腾讯 QQ' },
  { key: 'weixin', domains: ['weixin.qq.com', 'mp.weixin.qq.com'], name: '微信' },
  { key: 'taobao', domains: ['taobao.com', 'www.taobao.com'], name: '淘宝' },
  { key: 'tmall', domains: ['tmall.com', 'www.tmall.com'], name: '天猫' },
  { key: 'jd', domains: ['jd.com', 'www.jd.com'], name: '京东' },
  { key: 'pinduoduo', domains: ['pinduoduo.com', 'yangkeduo.com'], name: '拼多多' },
  { key: 'meituan', domains: ['meituan.com', 'www.meituan.com'], name: '美团' },
  { key: 'eleme', domains: ['ele.me', 'h5.ele.me'], name: '饿了么' },
  {
    key: 'wikipedia',
    domains: ['wikipedia.org', 'zh.wikipedia.org', 'en.wikipedia.org'],
    name: '维基百科',
  },
  { key: 'x', domains: ['x.com', 'twitter.com'], name: 'X (Twitter)' },
  { key: 'facebook', domains: ['facebook.com', 'www.facebook.com'], name: 'Facebook' },
  { key: 'instagram', domains: ['instagram.com', 'www.instagram.com'], name: 'Instagram' },
  { key: 'amazon', domains: ['amazon.com', 'www.amazon.com', 'amazon.cn'], name: 'Amazon' },
  { key: 'reddit', domains: ['reddit.com', 'www.reddit.com'], name: 'Reddit' },
  {
    key: 'stackoverflow',
    domains: ['stackoverflow.com', 'stackexchange.com'],
    name: 'Stack Overflow',
  },
  { key: 'mdn', domains: ['developer.mozilla.org'], name: 'MDN' },
  { key: 'runoob', domains: ['runoob.com', 'www.runoob.com'], name: '菜鸟教程' },
  { key: 'csdn', domains: ['csdn.net', 'blog.csdn.net', 'www.csdn.net'], name: 'CSDN' },
  { key: 'juejin', domains: ['juejin.cn', 'juejin.im'], name: '掘金' },
  { key: 'v2ex', domains: ['v2ex.com', 'www.v2ex.com'], name: 'V2EX' },
  { key: 'hackernews', domains: ['news.ycombinator.com'], name: 'Hacker News' },
  { key: 'npm', domains: ['npmjs.com', 'www.npmjs.com'], name: 'npm' },
  { key: 'leetcode', domains: ['leetcode.cn', 'leetcode.com'], name: 'LeetCode' },
  { key: 'nowcoder', domains: ['nowcoder.com', 'www.nowcoder.com'], name: '牛客' },
  { key: 'netease', domains: ['163.com', 'www.163.com', 'news.163.com'], name: '网易' },
  { key: 'sina', domains: ['sina.com.cn', 'www.sina.com.cn', 'sina.cn'], name: '新浪' },
  { key: 'sohu', domains: ['sohu.com', 'www.sohu.com'], name: '搜狐' },
  { key: 'ifeng', domains: ['ifeng.com', 'www.ifeng.com'], name: '凤凰网' },
  { key: 'thepaper', domains: ['thepaper.cn', 'www.thepaper.cn'], name: '澎湃新闻' },
  { key: 'people', domains: ['people.com.cn', 'www.people.com.cn'], name: '人民网' },
  { key: 'xinhuanet', domains: ['xinhuanet.com', 'www.xinhuanet.com'], name: '新华网' },
  { key: 'cctv', domains: ['cctv.com', 'news.cctv.com', 'www.cctv.com'], name: '央视网' },
  { key: 'douban', domains: ['douban.com', 'www.douban.com'], name: '豆瓣' },
  { key: 'iqiyi', domains: ['iqiyi.com', 'www.iqiyi.com'], name: '爱奇艺' },
  { key: 'youku', domains: ['youku.com', 'www.youku.com'], name: '优酷' },
  { key: 'tencentvideo', domains: ['v.qq.com'], name: '腾讯视频' },
  { key: 'neteasemusic', domains: ['music.163.com'], name: '网易云音乐' },
  { key: 'qqmusic', domains: ['y.qq.com'], name: 'QQ 音乐' },
  { key: 'ximalaya', domains: ['ximalaya.com', 'www.ximalaya.com'], name: '喜马拉雅' },
  { key: 'zhipin', domains: ['zhipin.com', 'www.zhipin.com'], name: 'BOSS直聘' },
  { key: 'zhaopin', domains: ['zhaopin.com', 'www.zhaopin.com'], name: '智联招聘' },
  { key: '51job', domains: ['51job.com', 'www.51job.com'], name: '前程无忧' },
  { key: 'ctrip', domains: ['ctrip.com', 'www.ctrip.com'], name: '携程' },
  { key: '12306', domains: ['12306.cn', 'www.12306.cn'], name: '12306' },
  { key: 'panbaidu', domains: ['pan.baidu.com'], name: '百度网盘' },
  { key: 'aliyundrive', domains: ['aliyundrive.com', 'www.aliyundrive.com'], name: '阿里云盘' },
  { key: 'weiyun', domains: ['weiyun.com', 'www.weiyun.com'], name: '腾讯微云' },
  { key: 'notion', domains: ['notion.so', 'www.notion.so'], name: 'Notion' },
  { key: 'yuque', domains: ['yuque.com', 'www.yuque.com'], name: '语雀' },
  { key: 'tencentdocs', domains: ['docs.qq.com'], name: '腾讯文档' },
  { key: 'figma', domains: ['figma.com', 'www.figma.com'], name: 'Figma' },
  { key: 'dribbble', domains: ['dribbble.com', 'www.dribbble.com'], name: 'Dribbble' },
  { key: 'huaban', domains: ['huaban.com', 'www.huaban.com'], name: '花瓣网' },
  { key: '36kr', domains: ['36kr.com', 'www.36kr.com'], name: '36氪' },
  { key: 'huxiu', domains: ['huxiu.com', 'www.huxiu.com'], name: '虎嗅' },
  { key: 'sspai', domains: ['sspai.com', 'www.sspai.com'], name: '少数派' },
  { key: 'smzdm', domains: ['smzdm.com', 'www.smzdm.com'], name: '什么值得买' },
  { key: 'zhongguancun', domains: ['zol.com.cn', 'www.zol.com.cn'], name: '中关村在线' },
  { key: 'aliyun', domains: ['aliyun.com', 'www.aliyun.com'], name: '阿里云' },
  { key: 'tencentcloud', domains: ['cloud.tencent.com'], name: '腾讯云' },
  { key: 'neteasecloud', domains: ['163yun.com'], name: '网易云' },
  { key: 'microsoft', domains: ['microsoft.com', 'www.microsoft.com'], name: 'Microsoft' },
  { key: 'apple', domains: ['apple.com', 'www.apple.com'], name: 'Apple' },
  { key: 'adobe', domains: ['adobe.com', 'www.adobe.com'], name: 'Adobe' },
  { key: 'chatgpt', domains: ['chatgpt.com', 'openai.com', 'chat.openai.com'], name: 'ChatGPT' },
  { key: 'claude', domains: ['claude.ai', 'anthropic.com'], name: 'Claude' },
  {
    key: 'deepseek',
    domains: ['deepseek.com', 'chat.deepseek.com', 'www.deepseek.com'],
    name: 'DeepSeek',
  },
  { key: 'kimi', domains: ['kimi.com', 'kimi.moonshot.cn'], name: 'Kimi' },
  { key: 'gemini', domains: ['gemini.google.com'], name: 'Gemini' },
  { key: 'huggingface', domains: ['huggingface.co'], name: 'Hugging Face' },
  { key: 'arxiv', domains: ['arxiv.org'], name: 'arXiv' },
  { key: 'zhihu', domains: ['zhuanlan.zhihu.com'], name: '知乎专栏' },
];

/** 域名 → 内置站点（大小写不敏感，供主页比对） */
const DOMAIN_INDEX = new Map<string, BuiltinSite>();
for (const site of SITE_DIRECTORY) {
  for (const domain of site.domains) {
    // 去 www. 前缀后登记，比对时统一去前缀
    DOMAIN_INDEX.set(domain.replace(/^www\./, ''), site);
  }
}

/** 取 URL 的裸域名（去 www，小写） */
export function bareDomainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 按 URL 查内置站点（命中返回条目，未命中返回 undefined） */
export function lookupBuiltinSite(url: string): BuiltinSite | undefined {
  const bare = bareDomainOf(url);
  if (!bare) return undefined;
  return DOMAIN_INDEX.get(bare);
}

/** 内置站点图标 URL（public/sites/<key>.png；无则该站点无内置图标） */
export function builtinIconUrl(site: BuiltinSite): string {
  return `/sites/${site.key}.png`;
}

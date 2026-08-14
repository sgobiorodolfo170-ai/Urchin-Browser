/**
 * 批量下载内置站点图标（site-directory.ts 中登记的站点）
 *
 * 用法：node scripts/fetch-site-icons.mjs
 * 输出：apps/desktop/src/renderer/public/sites/<key>.png
 *
 * 来源优先级：站点 favicon.ico 直连 → Google favicon 服务（64px PNG）。
 * 失败跳过（主页运行时该站点回退外部服务/内置图标）。
 */

/** 仅接受 PNG / ICO 魔数，拒绝站点返回的 HTML 错误页（如 <!doctype 开头） */
function isImage(buf) {
  if (buf.length < 100) return false;
  const hex = buf.slice(0, 4).toString('hex');
  return hex === '89504e47' || hex === '00000100';
}
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'public', 'sites');
mkdirSync(PUBLIC_DIR, { recursive: true });

// 站点清单（key + 主域名）——与 site-directory.ts 对齐
const SITES = [
  ['baidu', 'baidu.com'],
  ['bing', 'bing.com'],
  ['google', 'google.com'],
  ['github', 'github.com'],
  ['gitee', 'gitee.com'],
  ['bilibili', 'bilibili.com'],
  ['douyin', 'douyin.com'],
  ['youtube', 'youtube.com'],
  ['zhihu', 'zhihu.com'],
  ['weibo', 'weibo.com'],
  ['qq', 'qq.com'],
  ['weixin', 'weixin.qq.com'],
  ['taobao', 'taobao.com'],
  ['tmall', 'tmall.com'],
  ['jd', 'jd.com'],
  ['pinduoduo', 'pinduoduo.com'],
  ['meituan', 'meituan.com'],
  ['eleme', 'ele.me'],
  ['wikipedia', 'wikipedia.org'],
  ['x', 'x.com'],
  ['facebook', 'facebook.com'],
  ['instagram', 'instagram.com'],
  ['amazon', 'amazon.com'],
  ['reddit', 'reddit.com'],
  ['stackoverflow', 'stackoverflow.com'],
  ['mdn', 'developer.mozilla.org'],
  ['runoob', 'runoob.com'],
  ['csdn', 'csdn.net'],
  ['juejin', 'juejin.cn'],
  ['v2ex', 'v2ex.com'],
  ['hackernews', 'news.ycombinator.com'],
  ['npm', 'npmjs.com'],
  ['leetcode', 'leetcode.cn'],
  ['nowcoder', 'nowcoder.com'],
  ['netease', '163.com'],
  ['sina', 'sina.com.cn'],
  ['sohu', 'sohu.com'],
  ['ifeng', 'ifeng.com'],
  ['thepaper', 'thepaper.cn'],
  ['people', 'people.com.cn'],
  ['xinhuanet', 'xinhuanet.com'],
  ['cctv', 'cctv.com'],
  ['douban', 'douban.com'],
  ['iqiyi', 'iqiyi.com'],
  ['youku', 'youku.com'],
  ['tencentvideo', 'v.qq.com'],
  ['neteasemusic', 'music.163.com'],
  ['qqmusic', 'y.qq.com'],
  ['ximalaya', 'ximalaya.com'],
  ['zhipin', 'zhipin.com'],
  ['zhaopin', 'zhaopin.com'],
  ['51job', '51job.com'],
  ['ctrip', 'ctrip.com'],
  ['12306', '12306.cn'],
  ['panbaidu', 'pan.baidu.com'],
  ['aliyundrive', 'aliyundrive.com'],
  ['weiyun', 'weiyun.com'],
  ['notion', 'notion.so'],
  ['yuque', 'yuque.com'],
  ['tencentdocs', 'docs.qq.com'],
  ['figma', 'figma.com'],
  ['dribbble', 'dribbble.com'],
  ['huaban', 'huaban.com'],
  ['36kr', '36kr.com'],
  ['huxiu', 'huxiu.com'],
  ['sspai', 'sspai.com'],
  ['smzdm', 'smzdm.com'],
  ['zhongguancun', 'zol.com.cn'],
  ['aliyun', 'aliyun.com'],
  ['tencentcloud', 'cloud.tencent.com'],
  ['neteasecloud', '163yun.com'],
  ['microsoft', 'microsoft.com'],
  ['apple', 'apple.com'],
  ['adobe', 'adobe.com'],
  ['chatgpt', 'chatgpt.com'],
  ['claude', 'claude.ai'],
  ['deepseek', 'deepseek.com'],
  ['kimi', 'kimi.com'],
  ['gemini', 'gemini.google.com'],
  ['huggingface', 'huggingface.co'],
  ['arxiv', 'arxiv.org'],
];

async function fetchIcon(key, domain) {
  const out = join(PUBLIC_DIR, `${key}.png`);
  if (existsSync(out)) return 'skip';

  // 1) 站点 favicon.ico 直连（本环境网络稳定；ico 浏览器可直接显示）
  try {
    const direct = await fetch(`https://${domain}/favicon.ico`, {
      signal: AbortSignal.timeout(8000),
    });
    if (direct.ok) {
      const buf = Buffer.from(await direct.arrayBuffer());
      if (isImage(buf)) {
        writeFileSync(out, buf);
        return 'ok(direct)';
      }
    }
  } catch {
    /* 直连失败忽略 */
  }

  // 2) Google favicon 服务（64px PNG，部分网络不可达）
  try {
    const google = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const res = await fetch(google, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (isImage(buf)) {
        writeFileSync(out, buf);
        return 'ok(google)';
      }
    }
  } catch {
    /* Google 不可达忽略 */
  }
  return 'fail';
}

let ok = 0;
let fail = 0;
for (const [key, domain] of SITES) {
  const r = await fetchIcon(key, domain);
  if (r === 'fail') {
    fail++;
    console.log(`✗ ${key} (${domain})`);
  } else if (r !== 'skip') {
    ok++;
    console.log(`✓ ${key} (${r})`);
  }
}
console.log(`\n完成：成功 ${ok}，失败 ${fail}（已存在跳过不计）`);

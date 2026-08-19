/**
 * 批量下载内置站点图标（site-directory.ts 中登记的站点）
 *
 * 用法：node scripts/fetch-site-icons.mjs
 * 输出：apps/desktop/src/renderer/public/sites/<key>.png
 *
 * 站点清单从 site-directory.ts 自动解析（单一真源），无需另行维护：
 * - 以每条的 key 为图标文件名；
 * - 取 domains 数组第一项作为抓取域名（收录时请把裸域名放最前）。
 *
 * 来源优先级：站点 favicon.ico 直连 → 首页 <link rel="icon"> 解析 →
 * Google favicon 服务（64px PNG）→ favicon.im → DuckDuckGo favicon 服务。
 * 失败跳过（主页运行时该站点回退外部服务/内置图标）；已存在的图标跳过，可增量运行。
 *
 * 代理支持：经 node:https/http 核心模块请求，设置环境变量后自动走代理——
 *   export HTTPS_PROXY=http://127.0.0.1:7890   # 代理软件地址:端口
 *   node scripts/fetch-site-icons.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'public', 'sites');
const DIRECTORY_FILE = join(
  __dirname,
  '..',
  'apps',
  'desktop',
  'src',
  'renderer',
  'home',
  'site-directory.ts',
);
mkdirSync(PUBLIC_DIR, { recursive: true });

/** 并发抓取上限（兼顾速度与对站点的礼貌） */
const CONCURRENCY = 8;
/** 单请求超时（毫秒） */
const TIMEOUT_MS = 8000;

/** 仅接受 PNG / JPEG / ICO 魔数，拒绝站点返回的 HTML 错误页（如 <!doctype 开头） */
function isImage(buf) {
  if (buf.length < 100) return false;
  const hex4 = buf.slice(0, 4).toString('hex');
  const hex3 = buf.slice(0, 3).toString('hex');
  return hex4 === '89504e47' || hex4 === '00000100' || hex3 === 'ffd8ff';
}

/**
 * HTTP(S) GET，跟随重定向（最多 3 跳），返回 { statusCode, buffer }。
 * 经 node:https/http 核心模块请求：设置 HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 * 环境变量后自动走代理（Node 原生支持，无需额外依赖），未设置则直连。
 */
function fetchBuf(url, timeoutMs, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const doRequest = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = doRequest(url, { timeout: timeoutMs }, (res) => {
      const { statusCode, headers } = res;
      const loc = headers.location;
      if (statusCode >= 300 && statusCode < 400 && loc && redirectsLeft > 0) {
        res.resume(); // 释放连接，继续消费响应体
        return resolve(fetchBuf(new URL(loc, url).href, timeoutMs, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: statusCode ?? 0, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 从 site-directory.ts 解析 { key, 主域名 } 清单（按 key 去重，保留首个出现的域名） */
function parseSites() {
  const src = readFileSync(DIRECTORY_FILE, 'utf8');
  const re = /key:\s*'([^']+)'[\s\S]*?domains:\s*\[([^\]]*)\]/g;
  const sites = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    const firstDomain = m[2].match(/'([^']+)'/);
    if (!firstDomain || seen.has(key)) continue;
    seen.add(key);
    sites.push([key, firstDomain[1]]);
  }
  return sites;
}

async function fetchIcon(key, domain) {
  const out = join(PUBLIC_DIR, `${key}.png`);
  if (existsSync(out)) return 'skip';

  // 1) 站点 favicon.ico 直连（ico 浏览器可直接显示）
  const directHosts = domain.startsWith('www.') ? [domain] : [domain, `www.${domain}`];
  for (const host of directHosts) {
    try {
      const direct = await fetchBuf(`https://${host}/favicon.ico`, TIMEOUT_MS);
      if (direct.statusCode >= 200 && direct.statusCode < 300) {
        if (isImage(direct.buffer)) {
          writeFileSync(out, direct.buffer);
          return 'ok(direct)';
        }
      }
    } catch {
      /* 直连失败忽略 */
    }
  }

  // 2) 抓首页解析 <link rel="icon">（很多站点裸 /favicon.ico 返回 404/HTML）
  for (const host of directHosts) {
    try {
      const page = await fetchBuf(`https://${host}/`, TIMEOUT_MS);
      const html = page.buffer.toString('utf8');
      // 宽松匹配 link 标签（rel 与 href 顺序不定），仅当命中再继续
      const m = html.match(/<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]*>/i);
      if (m && /href=["']([^"']+)["']/.test(m[0])) {
        const href = /href=["']([^"']+)["']/.exec(m[0])[1];
        const iconUrl = new URL(href, `https://${host}/`).href;
        const res = await fetchBuf(iconUrl, TIMEOUT_MS);
        if (res.statusCode >= 200 && res.statusCode < 300 && isImage(res.buffer)) {
          writeFileSync(out, res.buffer);
          return 'ok(html)';
        }
      }
    } catch {
      /* 解析失败忽略 */
    }
  }

  // 3) Google faviconV2 服务（64px PNG；不带 www 先试，带 www 变体兜底——收录率更高）
  const googleUrls = [
    `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`http://${domain}/`)}&size=64`,
    ...(domain.startsWith('www.')
      ? []
      : [
          `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`http://www.${domain}/`)}&size=64`,
        ]),
  ];
  for (const google of googleUrls) {
    try {
      const res = await fetchBuf(google, TIMEOUT_MS);
      if (res.statusCode >= 200 && res.statusCode < 300 && isImage(res.buffer)) {
        writeFileSync(out, res.buffer);
        return 'ok(google)';
      }
    } catch {
      /* Google 不可达忽略 */
    }
  }

  // 4) favicon.im 备用服务（聚合多源图标）
  try {
    const fim = `https://favicon.im/${encodeURIComponent(domain)}?format=png`;
    const res = await fetchBuf(fim, TIMEOUT_MS);
    if (res.statusCode >= 200 && res.statusCode < 300 && isImage(res.buffer)) {
      writeFileSync(out, res.buffer);
      return 'ok(favicon.im)';
    }
  } catch {
    /* favicon.im 不可达忽略 */
  }

  // 5) DuckDuckGo favicon 服务（与主页运行时回退链一致）
  try {
    const ddg = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
    const res = await fetchBuf(ddg, TIMEOUT_MS);
    if (res.statusCode >= 200 && res.statusCode < 300 && isImage(res.buffer)) {
      writeFileSync(out, res.buffer);
      return 'ok(ddg)';
    }
  } catch {
    /* DDG 不可达忽略 */
  }
  return 'fail';
}

const sites = parseSites();
console.log(`站点清单：${sites.length} 个（源：site-directory.ts）\n`);

let ok = 0;
let fail = 0;
let cursor = 0;
async function worker() {
  while (cursor < sites.length) {
    const [key, domain] = sites[cursor++];
    const r = await fetchIcon(key, domain);
    if (r === 'fail') {
      fail++;
      console.log(`✗ ${key} (${domain})`);
    } else if (r !== 'skip') {
      ok++;
      console.log(`✓ ${key} (${r})`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const total = sites.length;
console.log(`\n完成：成功 ${ok}，失败 ${fail}，已存在跳过 ${total - ok - fail}（共 ${total}）`);

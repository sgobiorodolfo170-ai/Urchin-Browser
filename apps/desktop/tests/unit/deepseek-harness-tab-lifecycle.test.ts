/**
 * tab-lifecycle 绑定单元测试（§7.1 DSH 遗留规划 / 波 1）
 *
 * 复现并固化缺陷语义（2026-11-06 规划，测试名表达意图）：
 * - dsh web 认证 URL（带 ?token=）首访后 303 重定向为不带 token 的干净 URL
 *   （vendor packages/client/connection/src/browser-auth.ts:279-293 writeHead(303,
 *   {location:'./'})），Electron 标签的 tab.url 随后变干净 URL。因此匹配基准
 *   必须是**服务 origin**而非「带 token 的认证 URL 前缀」——否则：
 *   ① 关闭 dsh 标签匹配失败 → 后端不停（违反「关 web 前端即关 dsh 项目」）；
 *   ② （配套修复）服务运行时再次点击入口 → 找不到已开标签 → 重复开标签。
 * - 语义（用户裁决 Q3 = A2「关最后一个才停」）：window.open 派生标签也命中
 *   同一 origin，关闭任一派生标签不得停掉仍在使用中的后端；最后一个关闭才停。
 * - 全部依赖注入 mock，不真实 spawn / 不真实 TabManager。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  bindTabCloseToStop,
  type TabSnapshotLike,
  type TabManagerLike,
  type DshLauncherLike,
} from '../../src/main/deepseek-harness/tab-lifecycle';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';

/** 可控 fake TabManager：捕获 removed 监听器 + 可设定「剩余存活标签」快照 */
class FakeTabManager implements TabManagerLike {
  private readonly removedListeners: ((snapshot: TabSnapshotLike) => void)[] = [];

  /** 移除事件发出时 query() 返回的内容（缺省 = 其余标签已全部清空） */
  remaining: TabSnapshotLike[] = [];

  on(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown {
    if (event === 'removed') {
      this.removedListeners.push(listener);
    }
    return undefined;
  }

  off(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown {
    if (event === 'removed') {
      const idx = this.removedListeners.indexOf(listener);
      if (idx >= 0) this.removedListeners.splice(idx, 1);
    }
    return undefined;
  }

  /** 与 TabManager.query 同构：'removed' 发出时该标签已从集合删除（tab-manager.ts:313→325） */
  query(): readonly TabSnapshotLike[] {
    return this.remaining;
  }

  /** 触发一次标签移除事件 */
  emitRemoved(snapshot: TabSnapshotLike): void {
    for (const listener of [...this.removedListeners]) listener(snapshot);
  }
}

/** 可控 fake launcher：status 可编程，stop 记录调用次数 */
function createFakeLauncher(status: { state: string; url?: string }): {
  launcher: DshLauncherLike;
  stopFn: ReturnType<typeof vi.fn>;
  setStatus: (next: { state: string; url?: string }) => void;
} {
  let current = status;
  const stopFn = vi.fn(() => Promise.resolve(undefined));
  return {
    launcher: {
      status: () => current,
      stop: stopFn,
    },
    stopFn,
    setStatus: (next) => {
      current = next;
    },
  };
}

const SERVICE_URL = `http://127.0.0.1:47001/?token=${TOKEN}`;
const CLEAN_URL = 'http://127.0.0.1:47001/';

describe('bindTabCloseToStop（dsh 标签关闭 → 停止后端）', () => {
  it('should stop dsh web when the dsh frontend tab is closed after 303 redirect', () => {
    // 核心 bug 复现：认证 URL 已被 303 重定向为干净 URL，tab.url 是干净前缀，
    // 旧 startsWith(认证URL) 不命中 → 后端不停。origin 匹配后必须命中并停止。
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'running', url: SERVICE_URL });
    bindTabCloseToStop(tm, launcher);

    tm.emitRemoved({ id: 1, url: CLEAN_URL, active: false });

    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('should also match when the closed tab still holds the token URL (mid-auth close)', () => {
    // 重定向前关闭（罕见但会发生：首访未完成即关）→ token URL 也属于 dsh 服务，
    // 关闭同样应停止后端，两个阶段语义一致。
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'running', url: SERVICE_URL });
    bindTabCloseToStop(tm, launcher);

    tm.emitRemoved({ id: 2, url: SERVICE_URL, active: false });

    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('should ignore tabs from unrelated origins', () => {
    // 端口不同 = 不同服务（127.0.0.1 上可能跑着其它本地服务）；host 不同也不匹配。
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'running', url: SERVICE_URL });
    bindTabCloseToStop(tm, launcher);

    tm.emitRemoved({ id: 3, url: 'http://127.0.0.1:47002/', active: false });
    tm.emitRemoved({ id: 4, url: 'https://example.com/', active: false });
    tm.emitRemoved({ id: 5, url: 'urchin://newtab', active: false });

    expect(stopFn).not.toHaveBeenCalled();
  });

  it('should keep dsh web running while another dsh-origin tab remains open', () => {
    // A2 语义：window.open 派生标签也命中同 origin——关掉它（或关掉后台主标签）
    // 不得停掉用户仍在前台使用的另一标签对应的后端。
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'running', url: SERVICE_URL });
    bindTabCloseToStop(tm, launcher);
    // 移除事件发出时 id=9 的 dsh 前端标签仍存活
    tm.remaining = [{ id: 9, url: CLEAN_URL, active: true }];

    tm.emitRemoved({ id: 8, url: CLEAN_URL, active: false });

    expect(stopFn).not.toHaveBeenCalled();
  });

  it('should stop dsh web when the last dsh-origin tab is closed', () => {
    // A2 语义到达终态：剩余标签里没有任何 dsh origin 标签（剩余的非 dsh 页面
    // 一律不算数）→ 关闭即停。
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'running', url: SERVICE_URL });
    bindTabCloseToStop(tm, launcher);
    // 剩余只有无关标签
    tm.remaining = [{ id: 10, url: 'urchin://newtab', active: true }];

    tm.emitRemoved({ id: 6, url: CLEAN_URL, active: false });

    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('should not call stop when the dsh service is not running', () => {
    // 服务已停止/从未启动 → 关啥都不动 launcher.stop（幂等安全边界）
    const tm = new FakeTabManager();
    const { launcher, stopFn } = createFakeLauncher({ state: 'stopped' });
    bindTabCloseToStop(tm, launcher);

    tm.emitRemoved({ id: 7, url: CLEAN_URL, active: false });

    expect(stopFn).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppSend } from "../../src/app-globals";
import { LanguageProvider } from "../../src/i18n";
import { ScmPanel } from "../../src/components/SCMPanel";
import type { ChatState } from "../../src/use-chat";
import type { ClientMessage, ServerMessage } from "../../src/types";

// P6 口径补齐（2026-11-10）：SCMPanel 组件渲染冒烟。
// 重点锁住 D6 空仓语义：服务端 scm_data.empty=true（空仓）时历史视图必须显示
// scmEmptyRepo（「空仓库」），而不是与「有历史但列表为空」共用 scmNoHistory。
// 交接文档 §9.3 记录的欠账（SCMPanel 空仓文案无组件级断言）由本文件销账。

type PanelProps = Parameters<typeof ScmPanel>[0];
type ScmData = Extract<ServerMessage, { type: "scm_data" }>;

let root: Root | null = null;

const terminal = {
	create: () => {},
	close: () => {},
	register: () => () => {},
	restart: () => {},
	select: () => {},
};

const chatStub = {
	status: "open",
	ready: true,
	state: { cwd: "/work" },
	scmData: null as ScmData | null,
	scmDirty: 0,
	terminals: [],
} as unknown as ChatState;

function mount(chatPatch: Partial<ChatState> = {}, propPatch: Partial<PanelProps> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: ClientMessage[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	let chat = { ...chatStub, ...chatPatch };
	const render = (nextChatPatch: Partial<ChatState> = {}) => {
		chat = { ...chat, ...nextChatPatch };
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(ScmPanel, {
						chat,
						terminal,
						active: true,
						onSwitchToTerminal: () => {},
						...propPatch,
					} as unknown as PanelProps),
				),
			);
		});
	};
	render();
	return {
		container,
		render,
		sent,
		unmount() {
			act(() => root!.unmount());
			root = null;
			container.remove();
		},
	};
}

/** 受控 input 赋值（React 19 受控组件需要原生 setter + input 事件）。 */
function setInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** 切到历史视图（第二个 role=tab 按钮）。 */
function switchToHistory(container: HTMLElement) {
	const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
	expect(tabs.length).toBe(2);
	act(() => tabs[1].click());
}

const scmStatusResponse = (reqId: number, patch: Record<string, unknown> = {}): ScmData =>
	({ type: "scm_data", reqId, ok: true, branch: "main", files: [], ...patch }) as unknown as ScmData;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	setAppSend(null);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ScmPanel 渲染冒烟", () => {
	it("挂载（active）即请求 scm_status；未就绪时不请求", () => {
		const panel = mount();
		expect(panel.sent.map((m) => m.type)).toContain("scm_status");
		const request = panel.sent.find((m) => m.type === "scm_status");
		expect(request?.reqId).toBe(1);
		panel.unmount();

		const idle = mount({ ready: false, status: "connecting" } as Partial<ChatState>);
		expect(idle.sent.filter((m) => m.type === "scm_status")).toHaveLength(0);
		idle.unmount();
	});

	it("status 响应后渲染分支名与文件列表", () => {
		const panel = mount();
		panel.render({
			scmData: scmStatusResponse(1, { files: [{ path: "src/a.ts", x: "M", y: "M" }] }),
		} as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-branch-current")?.textContent).toContain("main");
		expect(panel.container.querySelectorAll(".scm-file")).toHaveLength(1);
		expect(panel.container.querySelector(".scm-files-count")?.textContent).toBe("1");
		panel.unmount();
	});

	it("工作区干净（无文件）显示 no-changes 空态", () => {
		const panel = mount();
		panel.render({ scmData: scmStatusResponse(1) } as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-empty")?.textContent).toContain("Working tree clean");
		panel.unmount();
	});

	it("未就绪时显示连接中文案而非加载中", () => {
		const panel = mount({ ready: false, status: "connecting" } as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-empty")?.textContent).toContain("Waiting for connection");
		panel.unmount();
	});

	it("notRepo 响应显示非 Git 仓库提示", () => {
		const panel = mount();
		panel.render({ scmData: scmStatusResponse(1, { notRepo: true }) } as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-empty")?.textContent).toContain("not a Git repository");
		panel.unmount();
	});

	it("失败响应显示错误横幅", () => {
		const panel = mount();
		panel.render({ scmData: { type: "scm_data", reqId: 1, ok: false, error: "boom" } } as unknown as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-error")?.textContent).toContain("boom");
		panel.unmount();
	});
});

describe("ScmPanel 历史视图与 D6 空仓语义", () => {
	it("空仓库（empty=true）显示 scmEmptyRepo，而非 scmNoHistory（D6 回归）", () => {
		const panel = mount();
		// status 响应带 empty=true（服务端 D6 起对空仓提供）
		panel.render({ scmData: scmStatusResponse(1, { empty: true }) } as Partial<ChatState>);
		switchToHistory(panel.container);
		// 切到历史视图自动发 scm_history
		const historyReq = panel.sent.filter((m) => m.type === "scm_history").at(-1);
		expect(historyReq).toBeDefined();
		panel.render({
			scmData: { type: "scm_data", reqId: historyReq!.reqId, ok: true, history: [] },
		} as unknown as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-empty")?.textContent).toContain("Empty repository");
		panel.unmount();
	});

	it("有历史但列表为空（无 empty 标记）显示 scmNoHistory", () => {
		const panel = mount();
		panel.render({ scmData: scmStatusResponse(1) } as Partial<ChatState>);
		switchToHistory(panel.container);
		const historyReq = panel.sent.filter((m) => m.type === "scm_history").at(-1);
		panel.render({
			scmData: { type: "scm_data", reqId: historyReq!.reqId, ok: true, history: [] },
		} as unknown as Partial<ChatState>);
		expect(panel.container.querySelector(".scm-empty")?.textContent).toContain("No commits yet");
		panel.unmount();
	});

	it("提交历史渲染且过滤输入生效", () => {
		const panel = mount();
		panel.render({ scmData: scmStatusResponse(1) } as Partial<ChatState>);
		switchToHistory(panel.container);
		const historyReq = panel.sent.filter((m) => m.type === "scm_history").at(-1);
		panel.render({
			scmData: {
				type: "scm_data",
				reqId: historyReq!.reqId,
				ok: true,
				history: [
					{ hash: "h1", shortHash: "h1", author: "alice", date: "2026-11-01", subject: "feat: alpha", decorations: "", graph: "" },
					{ hash: "h2", shortHash: "h2", author: "bob", date: "2026-11-02", subject: "fix: beta", decorations: "", graph: "" },
				],
			},
		} as unknown as Partial<ChatState>);
		expect(panel.container.querySelectorAll(".scm-commit")).toHaveLength(2);
		const filter = panel.container.querySelector(".scm-history-filter") as HTMLInputElement;
		expect(filter).not.toBeNull();
		setInputValue(filter, "alpha");
		expect(panel.container.querySelectorAll(".scm-commit")).toHaveLength(1);
		expect(panel.container.querySelector(".scm-files-count")?.textContent).toBe("1/2");
		panel.unmount();
	});

	it("点击文件行请求 diff 并渲染暂存/未暂存视图；行数统计显示", () => {
		const panel = mount();
		panel.render({
			scmData: scmStatusResponse(1, {
				files: [{ path: "src/a.ts", x: "M", y: "M" }],
				stats: { "src/a.ts": [3, 1] },
			}),
		} as Partial<ChatState>);
		expect(panel.container.textContent).toContain("+3");
		expect(panel.container.textContent).toContain("-1");
		const row = panel.container.querySelector(".scm-file") as HTMLButtonElement;
		expect(row).not.toBeNull();
		act(() => row.click());
		const diffReq = panel.sent.filter((m) => m.type === "scm_filediff").at(-1) as { reqId: number; path: string };
		expect(diffReq?.path).toBe("src/a.ts");
		panel.render({
			scmData: { type: "scm_data", reqId: diffReq.reqId, ok: true, stagedText: "+staged", worktreeText: "-work" },
		} as unknown as Partial<ChatState>);
		expect(panel.container.textContent).toContain("+staged");
		expect(panel.container.textContent).toContain("-work");
		panel.unmount();
	});

	it("未跟踪文件直接进入 untracked 视图，不发 diff 请求", () => {
		const panel = mount();
		panel.render({
			scmData: scmStatusResponse(1, { files: [{ path: "new.txt", x: "?", y: "?" }] }),
		} as Partial<ChatState>);
		const row = panel.container.querySelector(".scm-file") as HTMLButtonElement;
		act(() => row.click());
		expect(panel.sent.filter((m) => m.type === "scm_filediff")).toHaveLength(0);
		expect(panel.container.textContent).toContain("new.txt");
		panel.unmount();
	});

	it("分支列表渲染：当前分支选中、远端分组展示", () => {
		const panel = mount();
		panel.render({
			scmData: scmStatusResponse(1, {
				branches: [
					{ name: "main", current: true },
					{ name: "dev", current: false },
					{ name: "origin/main", remote: true, current: false },
				],
			}),
		} as Partial<ChatState>);
		const select = panel.container.querySelector("select") as HTMLSelectElement;
		expect(select).not.toBeNull();
		expect(select.value).toBe("main");
		const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
		expect(options).toContain("main");
		expect(options).toContain("dev");
		expect(options).toContain("origin/main");
		panel.unmount();
	});

	it("分离头指针 / 上游丢失 / 领先落后 各分支文案", () => {
		const cases: Record<string, Record<string, unknown>> = {
			detached: { detached: true },
			upstreamGone: { upstream: "origin/main", upstreamGone: true },
			aheadBehind: { upstream: "origin/main", ahead: 2, behind: 1 },
		};
		for (const [name, patch] of Object.entries(cases)) {
			const panel = mount();
			panel.render({ scmData: scmStatusResponse(1, { files: [], ...patch }) } as Partial<ChatState>);
			const header = panel.container.querySelector(".scm-branch-current")?.textContent ?? "";
			if (name === "detached") {
				expect(header).toContain("Detached HEAD");
			} else if (name === "upstreamGone") {
				expect(header).toContain("Upstream deleted");
			} else {
				expect(header).toContain("↑2 ↓1");
			}
			panel.unmount();
		}
	});
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_GLOBALS, resetAppGlobals, setAppGlobals, setAppSend } from "../../src/app-globals";
import { ChatInput } from "../../src/components/ChatInput";
import { TemplateProvider } from "../../src/components/PromptTemplates";
import { LanguageProvider } from "../../src/i18n";
import type { ChatState } from "../../src/use-chat";
import type { ClientMessage, SlashCommandInfo, UiMessage } from "../../src/types";

// @ 菜单的 canvas 数据源依赖 appSend 往返（测试环境无响应），mock 为即时命中
vi.mock("../../src/canvas-mentions", () => ({
	mapCanvasHits: () => [{ providerId: "host:canvases", title: "Canvas X", providerLabel: "Canvas" }],
	searchCanvasMentions: () => Promise.resolve([{ id: "c1", title: "Canvas X" }]),
}));

// P6 口径补齐（2026-11-10）：ChatInput 组件渲染/交互冒烟。
// 覆盖发送链路（点击 / Enter / 队列补发 / 停止）、slash 菜单、快捷短语、
// 附件 chip 与未连接禁用态。发送链路是 compos er 最高频用户路径。

type InputProps = Parameters<typeof ChatInput>[0];

let root: Root | null = null;

const slashCommands = [
	{ name: "help", description: "Show help" },
	{ name: "copy", description: "Copy last" },
] as unknown as SlashCommandInfo[];

function mount(propPatch: Partial<InputProps> = {}, globalsPatch: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: ClientMessage[] = [];
	const notices: string[] = [];
	let sentCount = 0;
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	setAppGlobals({
		...DEFAULT_APP_GLOBALS,
		status: "open",
		ready: true,
		cwd: "/work",
		...(globalsPatch as object),
	});
	root = createRoot(container);
	let props: InputProps = {
		streaming: false,
		messages: [] as UiMessage[],
		slashCommands,
		modelState: null,
		models: [],
		modelsLoading: false,
		attachments: [],
		onRemoveAttachment: () => {},
		onAddImageFiles: () => {},
		onAddLocalFiles: () => {},
		onNotice: (level, text) => notices.push(`${level}:${text}`),
		onSent: () => {
			sentCount += 1;
		},
		onManageModels: () => {},
		providerKeys: {},
		quickPhrases: ["ping", "pong"],
		quickPhrasesEnabled: true,
		sessionId: "s1",
		onAbort: () => {},
		...propPatch,
	} as unknown as InputProps;
	const render = (patch: Partial<InputProps> = {}) => {
		props = { ...props, ...patch };
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(
						// ChatInput 内部经 useTemplates 消费模板上下文（App 同款包裹层级）
						TemplateProvider,
						{ currentModelId: null },
						createElement(ChatInput, props),
					),
				),
			);
		});
	};
	render();
	return { container, render, sent, notices, sentCount: () => sentCount, unmount() { act(() => root!.unmount()); root = null; container.remove(); } };
}

function setTextareaValue(ta: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	act(() => {
		setter.call(ta, value);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const textarea = (container: HTMLElement) => container.querySelector(".inputbox textarea") as HTMLTextAreaElement;
const sendButton = (container: HTMLElement) => container.querySelector(".inputbox-actions .btn.send") as HTMLButtonElement;

const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const realScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// jsdom 无 ResizeObserver：ChatInput 工具行折叠测量依赖它（TopBar 测试同款 stub）
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	// jsdom 无 scrollIntoView：slash 菜单高亮项滚动定位依赖它
	Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	setAppSend(null);
	resetAppGlobals();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
	Element.prototype.scrollIntoView = realScrollIntoView;
});

describe("ChatInput 渲染冒烟", () => {
	it("渲染输入框；空文本且无附件时发送按钮禁用", () => {
		const input = mount();
		expect(textarea(input.container)).not.toBeNull();
		expect(sendButton(input.container).disabled).toBe(true);
		input.unmount();
	});

	it("未连接（ready=false）时发送按钮同样禁用", () => {
		const input = mount({}, { status: "connecting", ready: false });
		expect(sendButton(input.container).disabled).toBe(true);
		input.unmount();
	});

	it("输入文本后发送按钮可用，点击发送 prompt 并清空输入框", () => {
		const input = mount();
		setTextareaValue(textarea(input.container), "hello pi");
		expect(sendButton(input.container).disabled).toBe(false);
		act(() => sendButton(input.container).click());
		const prompt = input.sent.find((m) => m.type === "prompt") as { type: string; text: string; queue?: boolean } | undefined;
		expect(prompt?.text).toBe("hello pi");
		expect(prompt?.queue).toBeFalsy();
		expect(input.sentCount()).toBe(1);
		expect(textarea(input.container).value).toBe("");
		input.unmount();
	});

	it("仅添加附件（无文本）也允许发送", () => {
		const input = mount({
			attachments: [{ path: "/tmp/a.png", name: "a.png", imageData: "data:image/png;base64,xxx", mimeType: "image/png" }],
		} as Partial<InputProps>);
		expect(input.container.querySelector(".attach-chip.image")).not.toBeNull();
		expect(sendButton(input.container).disabled).toBe(false);
		input.unmount();
	});

	it("Enter 键发送（默认发送键）", () => {
		const input = mount();
		const ta = textarea(input.container);
		setTextareaValue(ta, "via enter");
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		const prompt = input.sent.find((m) => m.type === "prompt") as { text: string } | undefined;
		expect(prompt?.text).toBe("via enter");
		expect(input.sentCount()).toBe(1);
		input.unmount();
	});
});

describe("ChatInput 流式与队列", () => {
	it("流式中且无可提交内容时显示停止按钮，点击触发 onAbort", () => {
		const onAbort = vi.fn();
		const input = mount({ streaming: true, onAbort });
		const stop = input.container.querySelector(".inputbox-actions .btn.stop") as HTMLButtonElement;
		expect(stop).not.toBeNull();
		act(() => stop.click());
		expect(onAbort).toHaveBeenCalledTimes(1);
		input.unmount();
	});

	it("流式中输入文本出现队列补发按钮，点击以 queue:true 发送", () => {
		const input = mount({ streaming: true });
		setTextareaValue(textarea(input.container), "queued msg");
		const splitQueue = input.container.querySelector(".split-queue") as HTMLButtonElement;
		expect(splitQueue).not.toBeNull();
		act(() => splitQueue.click());
		const prompt = input.sent.find((m) => m.type === "prompt") as { text: string; queue?: boolean } | undefined;
		expect(prompt?.text).toBe("queued msg");
		expect(prompt?.queue).toBe(true);
		input.unmount();
	});

	it("流式中可点击 steer 按钮（非队列补发）", () => {
		const input = mount({ streaming: true });
		setTextareaValue(textarea(input.container), "steer msg");
		const steer = input.container.querySelector(".split-steer") as HTMLButtonElement;
		expect(steer).not.toBeNull();
		act(() => steer.click());
		const prompt = input.sent.find((m) => m.type === "prompt") as { text: string; queue?: boolean } | undefined;
		expect(prompt?.text).toBe("steer msg");
		expect(prompt?.queue).toBeFalsy();
		input.unmount();
	});

	it("流式中无 onAbort 时停止按钮走 appSend abort 兜底", () => {
		const input = mount({ streaming: true, onAbort: undefined });
		const stop = input.container.querySelector(".inputbox-actions .btn.stop") as HTMLButtonElement;
		act(() => stop.click());
		expect(input.sent.some((m) => (m as { type: string }).type === "abort")).toBe(true);
		input.unmount();
	});
});

describe("ChatInput 菜单与快捷输入", () => {
	it("输入 / 打开 slash 菜单并渲染命令列表", () => {
		const input = mount();
		setTextareaValue(textarea(input.container), "/");
		const menu = input.container.querySelector('.slash-menu[data-menu-kind="slash"]');
		expect(menu).not.toBeNull();
		expect((menu as HTMLElement).textContent).toContain("help");
		input.unmount();
	});

	it("ArrowDown 移动高亮项，Escape 关闭菜单", () => {
		const input = mount();
		const ta = textarea(input.container);
		setTextareaValue(ta, "/");
		expect(input.container.querySelector(".slash-menu")).not.toBeNull();
		const activeAt = (i: number) =>
			(input.container.querySelectorAll(".slash-item")[i] as HTMLElement).classList.contains("active");
		expect(activeAt(0)).toBe(true);
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		});
		expect(activeAt(1)).toBe(true);
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		expect(input.container.querySelector(".slash-menu")).toBeNull();
		input.unmount();
	});

	it("点击 slash 项填充命令文本并关闭菜单", () => {
		const input = mount();
		setTextareaValue(textarea(input.container), "/");
		const first = input.container.querySelector(".slash-item") as HTMLButtonElement;
		act(() => first.click());
		expect(textarea(input.container).value).toBe("/help ");
		expect(input.container.querySelector(".slash-menu")).toBeNull();
		input.unmount();
	});

	it("群组模式发送走 onGroupSend 而非普通 prompt", async () => {
		const onGroupSend = vi.fn(() => Promise.resolve(true));
		const input = mount({
			groupDevices: [{ id: "dev1", name: "Bot A" }],
			groupReady: true,
			onGroupSend,
		} as unknown as Partial<InputProps>);
		const ta = textarea(input.container);
		setTextareaValue(ta, "hello bots");
		act(() => sendButton(input.container).click());
		expect(onGroupSend).toHaveBeenCalledTimes(1);
		const [text, targets, destination] = onGroupSend.mock.calls[0];
		expect(text).toBe("hello bots");
		expect(Array.isArray(targets)).toBe(true);
		expect(destination).toBeUndefined();
		expect(input.sent.filter((m) => m.type === "prompt")).toHaveLength(0);
		// onGroupSend resolve(true) 后清空输入框
		await act(async () => {
			await Promise.resolve();
		});
		expect(ta.value).toBe("");
		input.unmount();
	});

	it("发送历史双向循环：ArrowUp 逐条回溯、ArrowDown 回到草稿", () => {
		const input = mount();
		const ta = textarea(input.container);
		for (const msg of ["first msg", "second msg"]) {
			setTextareaValue(ta, msg);
			act(() => sendButton(input.container).click());
		}
		expect(ta.value).toBe("");
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
		expect(ta.value).toBe("second msg");
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
		expect(ta.value).toBe("first msg");
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
		expect(ta.value).toBe("second msg");
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
		expect(ta.value).toBe("");
		input.unmount();
	});

	it("发送图片附件时 prompt 附带 imageData", () => {
		const input = mount({
			attachments: [{ path: "/tmp/pic.png", name: "pic.png", imageData: "data:image/png;base64,abc", mimeType: "image/png" }],
		} as Partial<InputProps>);
		act(() => sendButton(input.container).click());
		const prompt = input.sent.find((m) => m.type === "prompt") as {
			text: string;
			attachments: { imageData?: string; mimeType?: string; path: string }[];
		};
		expect(prompt.attachments).toHaveLength(1);
		expect(prompt.attachments[0].imageData).toBe("data:image/png;base64,abc");
		expect(prompt.attachments[0].mimeType).toBe("image/png");
		input.unmount();
	});

	it("快捷短语渲染为 chip，点击直接发送该短语", () => {
		const input = mount();
		const chips = Array.from(input.container.querySelectorAll(".quick-chip")) as HTMLButtonElement[];
		expect(chips.map((c) => c.textContent)).toContain("ping");
		act(() => chips.find((c) => c.textContent === "ping")!.click());
		const prompt = input.sent.find((m) => m.type === "prompt") as { text: string } | undefined;
		expect(prompt?.text).toBe("ping");
		expect(input.sentCount()).toBe(1);
		input.unmount();
	});

	it("引用菜单包含文件命中（fileSearch 注入响应）并可选择插入", async () => {
		let lastReqId = -1;
		const input = mount({
			onSearchFiles: (reqId: number) => {
				lastReqId = reqId;
			},
		} as unknown as Partial<InputProps>);
		const ta = textarea(input.container);
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(ta, "@ma");
			ta.setSelectionRange(3, 3);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(lastReqId).toBeGreaterThan(0);
		input.render({ fileSearch: { reqId: lastReqId, ok: true, results: [{ path: "src/main.ts", name: "main.ts" }] } } as Partial<InputProps>);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const menu = input.container.querySelector('.slash-menu[data-menu-kind="at"]');
		expect(menu).not.toBeNull();
		expect((menu as HTMLElement).textContent).toContain("main.ts");
		input.unmount();
	});

	it("输入 @ 打开引用菜单（canvas 命中）并可选择插入", async () => {
		// 注意：不传 onSearchFiles——否则 files job 等 3s 超时，allSettled 卡住菜单不弹
		const input = mount();
		const ta = textarea(input.container);
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(ta, "@can");
			// @ 菜单按光标位置解析 token：jsdom 设值不移动光标，需显式置尾
			ta.setSelectionRange(4, 4);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const menu = input.container.querySelector('.slash-menu[data-menu-kind="at"]');
		expect(menu).not.toBeNull();
		expect((menu as HTMLElement).textContent).toContain("Canvas X");
		const row = input.container.querySelector('.slash-menu .slash-item') as HTMLButtonElement;
		act(() => row.click());
		expect(input.container.querySelector(".slash-menu")).toBeNull();
		expect(ta.value).toContain("Canvas X");
		input.unmount();
	});
});

describe("ChatInput 帮助浮层 / 历史 / IME / 模式", () => {
	it("发送 /help 打开帮助浮层而非发送消息", () => {
		const input = mount();
		setTextareaValue(textarea(input.container), "/help");
		act(() => sendButton(input.container).click());
		expect(input.container.querySelector(".modal-backdrop")).not.toBeNull();
		expect(input.sent.filter((m) => m.type === "prompt")).toHaveLength(0);
		input.unmount();
	});

	it("宿主拒发（appSend=false）时提示网络断开且不清空输入", () => {
		const input = mount();
		setAppSend(() => false);
		const ta = textarea(input.container);
		setTextareaValue(ta, "will fail");
		act(() => sendButton(input.container).click());
		expect(input.notices.some((n) => n.startsWith("error:"))).toBe(true);
		expect(ta.value).toBe("will fail");
		input.unmount();
	});

	it("群组模式下 @ 菜单列出 Bot 会话且插入引用（同步命中）", () => {
		const input = mount({
			groupDevices: [{ id: "dev1", name: "Bot A" }],
			groupReady: true,
			groupConversations: [{ id: "c1", botId: "dev1", name: "Bot A" }],
			groupConversationError: "group sync failed",
		} as unknown as Partial<InputProps>);
		const ta = textarea(input.container);
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(ta, "@Bo");
			ta.setSelectionRange(3, 3);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const menu = input.container.querySelector('.slash-menu[data-menu-kind="at"]');
		expect(menu).not.toBeNull();
		expect((menu as HTMLElement).textContent).toContain("group sync failed");
		const row = input.container.querySelector(".slash-menu .slash-item") as HTMLButtonElement;
		act(() => row.click());
		expect(input.container.querySelector(".slash-menu")).toBeNull();
		expect(ta.value).toContain("Bot A");
		input.unmount();
	});

	it("slash 命令渲染来源标签与参数提示", () => {
		const input = mount({
			slashCommands: [
				{ name: "myskill", source: "skill", description: "A skill command", argumentHint: "<name>" },
			] as unknown as SlashCommandInfo[],
		});
		setTextareaValue(textarea(input.container), "/");
		const row = input.container.querySelector(".slash-item");
		expect(row).not.toBeNull();
		expect(row!.textContent).toContain("myskill");
		expect(input.container.querySelector(".slash-source.skill")).not.toBeNull();
		expect(input.container.querySelector(".slash-hint")?.textContent).toContain("<name>");
		input.unmount();
	});

	it("无描述的 builtin 命令行照常渲染", () => {
		const input = mount({
			slashCommands: [{ name: "bare", source: "builtin" }] as unknown as SlashCommandInfo[],
		});
		setTextareaValue(textarea(input.container), "/bar");
		const row = input.container.querySelector(".slash-item");
		expect(row).not.toBeNull();
		expect(row!.textContent).toContain("bare");
		expect(input.container.querySelector(".slash-source.builtin")).not.toBeNull();
		expect(input.container.querySelector(".slash-hint")).toBeNull();
		input.unmount();
	});

	it("菜单展开时 Enter 选中当前高亮项", () => {
		const input = mount();
		const ta = textarea(input.container);
		setTextareaValue(ta, "/");
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(input.container.querySelector(".slash-menu")).toBeNull();
		expect(ta.value).toBe("/help ");
		expect(input.sent.filter((m) => m.type === "prompt")).toHaveLength(0);
		input.unmount();
	});

	it("ArrowUp 恢复上一条已发送历史", () => {
		const input = mount();
		const ta = textarea(input.container);
		setTextareaValue(ta, "remembered prompt");
		act(() => sendButton(input.container).click());
		expect(ta.value).toBe("");
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
		});
		expect(ta.value).toBe("remembered prompt");
		input.unmount();
	});

	it("IME 组合中的 Enter 不发送，组合结束才发送", () => {
		const input = mount();
		const ta = textarea(input.container);
		setTextareaValue(ta, "拼音输入中");
		act(() => {
			ta.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
			);
		});
		expect(input.sent.filter((m) => m.type === "prompt")).toHaveLength(0);
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(input.sent.filter((m) => m.type === "prompt")).toHaveLength(1);
		input.unmount();
	});

	it("planMode 下 placeholder 切换为规划模式文案", () => {
		const idle = mount();
		const idlePlaceholder = textarea(idle.container).placeholder;
		idle.unmount();
		const plan = mount({ planMode: true });
		expect(textarea(plan.container).placeholder).not.toBe(idlePlaceholder);
		expect(textarea(plan.container).placeholder.length).toBeGreaterThan(0);
		plan.unmount();
	});

	it("Backspace 删除会话引用附件（mention 退格路径）", () => {
		const onRemoveAttachment = vi.fn();
		const input = mount({
			attachments: [{ path: "conv|c1", mode: "conversation", conversationId: "c1", name: "Bot A" }],
			onRemoveAttachment,
		} as unknown as Partial<InputProps>);
		const ta = textarea(input.container);
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(ta, "@Bot A ");
			ta.setSelectionRange(7, 7);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
		});
		expect(onRemoveAttachment).toHaveBeenCalledWith("conv|c1|");
		input.unmount();
	});

	it("已有消息时 composer 正常渲染且可关闭快捷短语条", () => {
		const msg = {
			id: "m1",
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
		} as unknown as UiMessage;
		const on = mount({ messages: [msg] });
		expect(textarea(on.container)).not.toBeNull();
		on.unmount();
		const off = mount({ quickPhrases: ["ping"], quickPhrasesEnabled: false });
		expect(off.container.querySelector(".quick-chip")).toBeNull();
		off.unmount();
	});
});

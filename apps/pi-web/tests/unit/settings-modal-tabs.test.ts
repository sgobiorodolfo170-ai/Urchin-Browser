// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppGlobals, setAppSend, DEFAULT_APP_GLOBALS, resetAppGlobals } from "../../src/app-globals";
import { LanguageProvider } from "../../src/i18n";
import { SettingsModal } from "../../src/components/SettingsModal";
import type { ChatState } from "../../src/use-chat";
import type { UiSettingsState } from "../../src/types";

// P6 口径补齐（2026-11-10）：SettingsModal（6786 行，P6 计划「各 tab」但未交付）。
// 冒烟策略：完整 UiSettingsState stub 挂载后，动态发现侧栏全部 data-tab 按钮，
// 逐一点击断言激活态与内容区非空——覆盖全部已渲染 tab 的渲染路径。

type ModalProps = Parameters<typeof SettingsModal>[0];

let root: Root | null = null;

/** 与 shared/protocol UiSettingsState 字段一一对应的安全空值 stub。 */
const settingsStub = {
	promptMode: "append",
	customSystemPrompt: "",
	promptTemplate: "",
	promptOverrides: {},
	promptDisabled: [],
	toolPromptOverrides: {},
	disabledSkills: [],
	disabledExtensions: [],
	disabledAgentTools: [],
	disabledPluginTools: [],
	nativeCliInheritModel: "off",
	terminalToolsEnabled: true,
	terminalBash: true,
	terminalBashIdleMs: 5000,
	terminalBashMaxForegroundMs: 60000,
	toolWatchdogTimeoutMs: 60000,
	readDirEnabled: true,
	bgAutoCleanupMin: 60,
	toolLazyLoading: false,
	codemodeMode: "on",
	codemodeInlineBudget: 2000,
	editSoftEnabled: false,
	questionnaireEnabled: true,
	questionPresentation: "queue",
	toolApprovalPresentation: "queue",
	questionTimeoutSeconds: 120,
	toolApprovalEnabled: true,
	approvalPolicy: { allowAll: false, categories: [] },
	approvalRules: [],
	parallelReminderEnabled: true,
	goalModeEnabled: false,
	thinkingWrap: true,
	devNoCache: false,
	autoReload: true,
	toolsWrap: true,
	toolImagesEnabled: true,
	keepRecentMessages: 100,
	reversePagination: false,
	showForkedParentSessions: false,
	retainFinishedConversations: true,
	openRecentSessionOnProjectSwitch: false,
	skillsFullText: [],
	skillsCatalogMaxDesc: 200,
	skillsCatalogShowLocation: true,
	skillsCatalogBudget: 2000,
	skillsMaxFileBytes: 100000,
	skillsFullTextMaxBytes: 2000,
	chatUploadMaxMb: 20,
	workspaceUploadMaxMb: 100,
	folderUploadMaxMb: 32,
	visionBridgeEnabled: false,
	visionBridgeModel: null,
	visionBridgePromptMode: "append",
	visionBridgePrompt: "",
	scmCommitMsgPromptMode: "append",
	scmCommitMsgPrompt: "",
	quickAskEnabled: true,
	quickAskModel: null,
	quickAskThinking: "off",
	quickAskSystemPrompt: "",
	quickAskExplainPrompt: "",
	quickAskTranslateEnabled: true,
	quickAskTranslateTarget: "en",
	quickAskTranslateStyle: "natural",
	quickAskTranslatePrompt: "",
	quickAskShowOriginal: false,
	quickAskReferenceMenus: true,
	quickAskConversationScope: "recent",
	quickAskFolderScope: "listing",
	planModePromptMode: "append",
	planModePrompt: "",
	reviewPrompt: "",
	reviewDisabledSkills: [],
	disabledPlugins: [],
	uiLayout: {},
	effectiveSystemPrompt: "",
	promptSourceDefaults: {},
	promptSections: [],
	toolsSchema: "",
	visionBridgeDefaultPrompt: "",
	scmCommitMsgDefaultPrompt: "",
	planModeDefaultPrompt: "",
	visionModels: [],
	skills: [],
	reviewSkills: [],
	extensions: [],
	presets: [],
	markersEnabled: false,
	disabledMarkers: [],
	markers: [],
	subagentTemplates: [],
	subagentDefaultModel: null,
	subagentMaxDepth: 3,
	subagentAutoWakeMaxTurns: 5,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retryMaxAttempts: 3,
	softCapTokens: 0,
	softCapByModel: {},
	autoCompactionInstructions: "",
	quickPhrases: [],
	quickPhrasesEnabled: true,
	minimalNewChat: false,
	preserveDraftAcrossConversations: false,
	quickPhrasesSeeded: true,
	subagentModels: [],
	subagentDefaultTemplates: [],
} as unknown as UiSettingsState;

const chatStub = {
	settings: settingsStub,
	plugins: [],
	pluginCatalog: [],
	pluginUpdates: null,
	checkingPluginUpdates: false,
	pluginJobs: {},
	catalogSync: null,
	presetExport: null,
	presetImport: null,
	presetCatalog: null,
	presetShare: null,
	installInspect: null,
	pluginsEpoch: 0,
	pluginGrants: [],
	pluginPermissions: [],
	dshPresets: null,
	dshPermission: null,
	terminals: [],
	state: { cwd: "/work", conversationId: "c1" },
	activeConversationId: "c1",
	schedulerTasks: [],
	mcpOAuthResult: null,
	mcpMarketResult: null,
	skillMarketResult: null,
	skillContentResult: null,
} as unknown as ChatState;

const sound = { enabled: false, question: false, done: false, subagentDone: false, start: false, error: false, approval: false, volume: 0.5 };
const tts = { enabled: false, announce: false, readReplies: false, streamReplies: false, rate: 1, voiceURI: "", engine: "native" };

function mount(chatPatch: Partial<ChatState> = {}, propPatch: Partial<ModalProps> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: { type: string }[] = [];
	const closed = vi.fn();
	setAppSend((message) => {
		sent.push(message as { type: string });
		return true;
	});
	// models tab 受全局 ready 门控：pi 引擎 + 就绪态（DEFAULT_APP_GLOBALS.engine 已是 pi）
	setAppGlobals({ ...DEFAULT_APP_GLOBALS, status: "open", ready: true, cwd: "/work" });
	root = createRoot(container);
	let chat = { ...chatStub, ...chatPatch };
	const render = (nextChatPatch: Partial<ChatState> = {}) => {
		chat = { ...chat, ...nextChatPatch };
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(SettingsModal, {
						chat,
						terminal: { create: () => {}, restart: () => {}, select: () => {} },
						onSwitchToTerminal: () => {},
						onClose: closed,
						// models tab 仅在提供 onOpenManageModels 时渲染（App 同款）
						onOpenManageModels: () => {},
						sound,
						onSoundChange: () => {},
						tts,
						onTtsChange: () => {},
						...propPatch,
					} as unknown as ModalProps),
				),
			);
		});
	};
	render();
	return { container, render, sent, closed, unmount() { act(() => root!.unmount()); root = null; container.remove(); } };
}

const tabButtons = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-tab]")) as HTMLButtonElement[];

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// jsdom 无 ResizeObserver / scrollIntoView（与 ChatInput 测试同款 stub）
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	Element.prototype.scrollIntoView = () => {};
	Element.prototype.scrollTo = () => {};
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	setAppSend(null);
	resetAppGlobals();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("SettingsModal 渲染冒烟", () => {
	it("挂载即请求 get_settings；settings 为 null 时不渲染", () => {
		const modal = mount();
		expect(modal.sent.some((m) => m.type === "get_settings")).toBe(true);
		modal.unmount();

		const empty = mount({ settings: null } as Partial<ChatState>);
		expect(empty.container.querySelector(".settings-layout")).toBeNull();
		empty.unmount();
	});

	it("pi 引擎默认打开 prompt tab，侧栏渲染全部 tab 按钮", () => {
		const modal = mount();
		const active = modal.container.querySelector(".settings-tab.active") as HTMLElement;
		expect(active?.dataset.tab).toBe("prompt");
		// pi 引擎 + 默认能力全开下至少 15 个 tab 可见
		expect(tabButtons(modal.container).length).toBeGreaterThanOrEqual(15);
		modal.unmount();
	});

	it("逐个 tab 点击：激活态切换且内容区非空", () => {
		const modal = mount();
		const buttons = tabButtons(modal.container);
		expect(buttons.length).toBeGreaterThan(0);
		const visited: string[] = [];
		for (const btn of buttons) {
			const id = btn.dataset.tab!;
			act(() => btn.click());
			const active = modal.container.querySelector(".settings-tab.active") as HTMLElement | null;
			expect(active?.dataset.tab, `tab ${id} 应激活`).toBe(id);
			// 交互放大器：逐个拨动该 tab 的开关行（ToggleRow 语义统一为 on/off）
			const switches = Array.from(modal.container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
			for (const sw of switches) {
				act(() => sw.click());
			}
			const body = modal.container.querySelector(".modal-body");
			expect(body?.children.length ?? 0, `tab ${id} 内容区应非空`).toBeGreaterThan(0);
			visited.push(id);
		}
		// 关键 tab 必须在列（P6 计划点名）
		for (const must of ["models", "prompt", "tools", "plugins", "display"]) {
			expect(visited, `缺少关键 tab: ${must}`).toContain(must);
		}
		modal.unmount();
	});

	it("initialSection=plugins 直接打开插件 tab", () => {
		const modal = mount({}, { initialSection: "plugins" });
		const active = modal.container.querySelector(".settings-tab.active") as HTMLElement;
		expect(active?.dataset.tab).toBe("plugins");
		modal.unmount();
	});

	it("关闭按钮触发 onClose", () => {
		const modal = mount();
		const close = modal.container.querySelector(".settings-layout button[aria-label], .settings-header button") as HTMLButtonElement | null;
		// 头部第一个可点按钮即关闭（FiX）
		const headerBtns = Array.from(modal.container.querySelectorAll("button")).filter((b) => b.querySelector("svg"));
		expect(headerBtns.length).toBeGreaterThan(0);
		act(() => (close ?? headerBtns[0]).click());
		expect(modal.closed).toHaveBeenCalledTimes(1);
		modal.unmount();
	});
});

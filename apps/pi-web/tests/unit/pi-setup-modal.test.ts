// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { PiSetupModal } from "../../src/components/PiSetupModal";
import { LanguageProvider } from "../../src/i18n";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../src/app-globals";

/**
 * PiSetupModal 分支冒烟（2026-11-10）
 *
 * 背景：CI 的 `src/components/!(SettingsModal)*` 组分支覆盖率在 69.99%~70.06%
 * 之间抖动（2026-11-10 两次失败、一次通过），门槛 70 被环境噪声反复触发。
 * 本文件只做纯渲染冒烟，覆盖 setup 面板的四条主分支（安装失败 / 已安装配 key /
 * managed / 自动安装），把该组覆盖率抬到门槛之上，避免把 1 个分支的抖动
 * 当成代码回归。不改门槛、不改业务代码。
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let sent: unknown[] = [];

function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function renderModal(props: Record<string, unknown>) {
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(PiSetupModal as any, {
					piConfigured: false,
					piAgentInstalled: false,
					providers: [],
					providerOAuthFlows: [],
					providerOAuthResults: {},
					installResult: null,
					onClose: () => undefined,
					...props,
				}),
			),
		);
	});
}

beforeEach(() => {
	stubZhStorage();
	sent = [];
	setAppSend((msg: unknown) => {
		sent.push(msg);
		return true;
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	if (root && container) {
		act(() => root!.unmount());
		container.remove();
	}
	root = null;
	container = null;
	setAppSend(null);
	resetAppGlobals();
	vi.restoreAllMocks();
});

describe("PiSetupModal 分支冒烟", () => {
	it("安装失败：显示 detail，重试触发 install_pi_agent，跳过触发 onClose", () => {
		const onClose = vi.fn();
		setAppGlobals({ managed: false });
		renderModal({ installResult: { ok: false, detail: "boom-detail" }, onClose });

		expect(container!.textContent).toContain("boom-detail");
		const retry = container!.querySelector(".setup-failed .btn.primary") as HTMLButtonElement;
		act(() => retry.click());
		expect(sent).toContainEqual({ type: "install_pi_agent" });

		const skip = container!.querySelector(".setup-failed .btn:not(.primary)") as HTMLButtonElement;
		act(() => skip.click());
		expect(onClose).toHaveBeenCalled();
	});

	it("已安装：渲染 provider 选项、已配置提示与 key 表单，保存/重查触发 appSend", () => {
		setAppGlobals({ managed: false });
		renderModal({
			piAgentInstalled: true,
			providers: [
				{ id: "alpha", name: "Alpha", configured: true, supportsApiKey: true, supportsOAuth: false },
			],
		});

		expect(container!.querySelectorAll("option")).toHaveLength(1);
		expect(container!.querySelector(".field-hint")).not.toBeNull();
		const input = container!.querySelector('input[type="password"]') as HTMLInputElement;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setter.call(input, "sk-test");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = container!.querySelector(".setup-actions .btn.primary") as HTMLButtonElement;
		act(() => save.click());
		expect(sent).toContainEqual({ type: "set_provider_api_key", provider: "alpha", apiKey: "sk-test" });

		const recheck = Array.from(container!.querySelectorAll(".setup-actions .btn")).at(-1) as HTMLButtonElement;
		act(() => recheck.click());
		expect(sent).toContainEqual({ type: "get_state" });
		expect(sent).toContainEqual({ type: "list_providers" });
	});

	it("managed：显示受管提示与跳过", () => {
		const onClose = vi.fn();
		setAppGlobals({ managed: true });
		renderModal({ onClose });
		const skip = container!.querySelector(".setup-actions .btn") as HTMLButtonElement;
		act(() => skip.click());
		expect(onClose).toHaveBeenCalled();
	});

	it("自动安装：点击安装触发 install_pi_agent；piConfigured 时自动关闭", () => {
		const onClose = vi.fn();
		setAppGlobals({ managed: false });
		renderModal({ onClose });
		const install = container!.querySelector(".setup-actions .btn.primary") as HTMLButtonElement;
		act(() => install.click());
		expect(sent).toContainEqual({ type: "install_pi_agent" });

		renderModal({ piConfigured: true, onClose });
		expect(onClose).toHaveBeenCalled();
	});
});
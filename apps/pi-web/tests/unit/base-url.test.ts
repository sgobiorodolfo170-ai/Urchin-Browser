import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBase, withAppBase } from "../../src/base-url";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveBase", () => {
	it("根部署返回根", () => {
		expect(resolveBase("/")).toBe("/");
		expect(resolveBase("")).toBe("/");
		expect(resolveBase(undefined)).toBe("/");
	});

	it("子路径返回带尾斜杠的应用根", () => {
		expect(resolveBase("/pi/")).toBe("/pi/");
		expect(resolveBase("/pi")).toBe("/pi/");
		expect(resolveBase("/pi/index.html")).toBe("/pi/");
	});

	it("多层子路径", () => {
		expect(resolveBase("/apps/pi-web/")).toBe("/apps/pi-web/");
		expect(resolveBase("/apps/pi-web/index.html")).toBe("/apps/pi-web/");
	});
});

describe("withAppBase", () => {
	it("根部署原样返回", () => {
		expect(withAppBase("/ws", "/")).toBe("/ws");
		expect(withAppBase("/plugins/x/client/entry.mjs?e=0", "/")).toBe("/plugins/x/client/entry.mjs?e=0");
	});

	it("子路径部署统一加前缀", () => {
		expect(withAppBase("/ws", "/pi/")).toBe("/pi/ws");
		expect(withAppBase("/api/file?a=1&b=2", "/pi/")).toBe("/pi/api/file?a=1&b=2");
		expect(withAppBase("/plugins/vscode-editor/client/entry.mjs?e=3", "/apps/web/")).toBe(
			"/apps/web/plugins/vscode-editor/client/entry.mjs?e=3",
		);
	});
});

describe("resolveBase capability roots and runtime sources", () => {
	it("detects device and device-lan capability roots, rejecting other paths", async () => {
		const { relayBase } = await import("../../src/base-url");

		expect(relayBase("/device/abc/__relay/def/index.html")).toBe("/device/abc/__relay/def/");
		expect(relayBase("/apps/web/device-lan/abc/__relay/def/")).toBe(
			"/apps/web/device-lan/abc/__relay/def/",
		);
		expect(relayBase("/device/abc/not-a-relay")).toBeNull();
		expect(relayBase("/pi/")).toBeNull();
	});

	it("prefers the capability URL from location over document metadata", () => {
		vi.stubGlobal("location", { pathname: "/device/abc/__relay/def/index.html" });
		vi.stubGlobal("document", { baseURI: "https://host/apps/pi/index.html" });

		expect(resolveBase()).toBe("/device/abc/__relay/def/");
	});

	it("derives the base from document.baseURI when location has no capability", () => {
		vi.stubGlobal("location", undefined);
		vi.stubGlobal("document", { baseURI: "https://host/apps/pi/index.html" });

		expect(resolveBase()).toBe("/apps/pi/");
	});

	it("memoizes appBase after the first resolution", async () => {
		vi.stubGlobal("document", { baseURI: "http://localhost/app/index.html" });
		vi.resetModules();

		const { appBase } = await import("../../src/base-url");
		expect(appBase()).toBe("/app/");

		vi.stubGlobal("document", { baseURI: "http://localhost/other/index.html" });
		expect(appBase()).toBe("/app/");
	});

	it("builds non-mobile app, resource and websocket URLs", async () => {
		vi.stubGlobal("document", { baseURI: "http://localhost/app/index.html" });
		vi.stubGlobal("location", {
			pathname: "/app/",
			href: "http://localhost/app/",
			protocol: "http:",
			host: "localhost",
		});
		vi.resetModules();

		const { appUrl, appResourceUrl, appResourceCrossOrigin, appWsUrl } = await import(
			"../../src/base-url"
		);

		expect(appUrl("/ws")).toBe("/app/ws");
		expect(appResourceUrl("/api/x")).toBe("/app/api/x");
		expect(appResourceCrossOrigin("http://localhost/app/api/x")).toBeUndefined();
		expect(appWsUrl("/ws")).toBe("ws://localhost/app/ws");
	});

	it("builds mobile URLs, appends the token and upgrades websockets", async () => {
		const originalFetch = globalThis.fetch;
		vi.resetModules();
		const { configureMobileRuntime } = await import("../../src/mobile-runtime");
		const { appUrl, appResourceUrl, appResourceCrossOrigin, appWsUrl } = await import(
			"../../src/base-url"
		);

		try {
			configureMobileRuntime({
				serverUrl: "https://hub.example.test/base",
				token: "tok",
			});

			expect(appUrl("/ws")).toBe("https://hub.example.test/base/ws");
			expect(appResourceUrl("/ws")).toBe("https://hub.example.test/base/ws?token=tok");
			expect(appResourceCrossOrigin("https://hub.example.test/base/api/x")).toBe("anonymous");
			expect(appResourceCrossOrigin("https://other.test/api/x")).toBeUndefined();
			expect(appWsUrl("/ws")).toBe("wss://hub.example.test/base/ws");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

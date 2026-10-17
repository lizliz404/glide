// Service worker: orchestration only. Media lives in the offscreen document (MV3 service
// workers have no DOM / getDisplayMedia), per
// https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
import type { RecordOptions } from "./shared/types";

const OFFSCREEN = "recorder.html";
const CS_ID = "glide-pointer";
const handled = new Set<string>();

async function ensureOffscreen() {
	const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
	if (ctx.length) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN,
		reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA, chrome.offscreen.Reason.USER_MEDIA],
		justification: "Record the shared tab/window/screen plus microphone and webcam.",
	});
}

async function startPointerLogging() {
	const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
	if (!granted) return false;
	const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CS_ID] });
	if (!existing.length) {
		await chrome.scripting.registerContentScripts([
			{ id: CS_ID, js: ["content.js"], matches: ["<all_urls>"], runAt: "document_start", persistAcrossSessions: false },
		]);
	}
	// Tabs that were already open before recording started.
	const tabs = await chrome.tabs.query({});
	await Promise.all(
		tabs.map((t) =>
			t.id ? chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => {}) : null,
		),
	);
	return true;
}

async function stopPointerLogging() {
	await chrome.storage.local.set({ glideRecording: false });
	await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] }).catch(() => {});
}

async function setBadge(on: boolean) {
	await chrome.action.setBadgeText({ text: on ? "REC" : "" });
	if (on) await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg?.target !== "background") return;
	(async () => {
		switch (msg.type) {
			case "start": {
				const opts = msg.opts as RecordOptions;
				const pointer = await startPointerLogging();
				await ensureOffscreen();
				const res = await chrome.runtime.sendMessage({ target: "recorder", type: "start", opts });
				if (res?.ok) {
					await chrome.storage.local.set({ glideRecording: true });
					await setBadge(true);
				} else {
					await stopPointerLogging();
				}
				reply({ ...res, pointer });
				break;
			}
			case "prepare-page": {
				// Fallback: recorder runs in a visible tab instead of the offscreen document.
				const pointer = await startPointerLogging();
				const q = new URLSearchParams({ page: "1", mic: msg.opts.mic ? "1" : "0", camera: msg.opts.camera ? "1" : "0", surface: msg.opts.surface });
				await chrome.tabs.create({ url: chrome.runtime.getURL(`recorder.html?${q}`) });
				reply({ ok: true, pointer });
				break;
			}
			case "stop":
				reply(await chrome.runtime.sendMessage({ target: "recorder", type: "stop" }));
				break;
			case "status": {
				const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
				reply(ctx.length ? await chrome.runtime.sendMessage({ target: "recorder", type: "status" }) : { recording: false });
				break;
			}
			case "saved": {
				if (handled.has(msg.id)) return reply({ ok: true });
				handled.add(msg.id);
				// Recorder finished writing to IndexedDB (also fires when the user clicks
				// Chrome's own "Stop sharing" bar).
				await stopPointerLogging();
				await setBadge(false);
				if (!msg.page) await chrome.offscreen.closeDocument().catch(() => {});
				await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(msg.id)}`) });
				reply({ ok: true });
				break;
			}
			case "failed":
				await stopPointerLogging();
				await setBadge(false);
				await chrome.offscreen.closeDocument().catch(() => {});
				reply({ ok: true });
				break;
		}
	})();
	return true;
});

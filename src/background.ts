// Service worker: orchestration only. Media lives in the offscreen document (MV3 service
// workers have no DOM / getDisplayMedia), per
// https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
import type { RecordOptions } from "./shared/types";

const OFFSCREEN = "recorder.html";
const CS_ID = "glide-pointer";
const handled = new Set<string>();
/** Tab that owns start/stop/status. Active-tab selection breaks once the user switches away. */
let recorderOwnerId: number | null = null;

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

function isRecorderUrl(url: string | undefined) {
	if (!url) return false;
	try {
		return new URL(url).pathname === new URL(chrome.runtime.getURL(OFFSCREEN)).pathname;
	} catch {
		return false;
	}
}

/** Visible recorder pages. Contexts do not need the tabs permission to expose documentUrl. */
async function recorderTabs() {
	const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
	const ids = [
		...new Set(
			ctx.filter((c) => isRecorderUrl(c.documentUrl) && new URL(c.documentUrl!).searchParams.has("page") && c.tabId != null && c.tabId >= 0).map((c) => c.tabId!),
		),
	];
	const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
	return tabs.filter((t): t is chrome.tabs.Tab => t?.id != null);
}

async function askRecorder(type: "status" | "stop") {
	const tabs = await recorderTabs();
	const owner = tabs.find((t) => t.id === recorderOwnerId) ?? tabs[0];
	if (owner?.id == null) {
		recorderOwnerId = null;
		return null;
	}
	recorderOwnerId = owner.id;
	return chrome.tabs.sendMessage(owner.id, { target: "recorder", type }).catch(() => null);
}

async function focusRecorder(tabId: number) {
	const tab = await chrome.tabs.get(tabId);
	if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
	await chrome.tabs.update(tabId, { active: true });
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
					await chrome.offscreen.closeDocument().catch(() => {});
				}
				reply({ ...res, pointer });
				break;
			}
			case "prepare-page": {
				// Only one recorder listener may own start/stop/status replies.
				await chrome.offscreen.closeDocument().catch(() => {});
				const pointer = await startPointerLogging();
				const q = new URLSearchParams({ page: "1", mic: msg.opts.mic ? "1" : "0", camera: msg.opts.camera ? "1" : "0", surface: msg.opts.surface });
				const existing = await recorderTabs();
				recorderOwnerId = existing.find((t) => t.id === recorderOwnerId)?.id ?? existing[0]?.id ?? null;
				const live = existing.length ? await askRecorder("status") : null;
				if (live?.recording && recorderOwnerId != null) {
					await focusRecorder(recorderOwnerId);
					reply({ ok: true, pointer, reused: true, recording: true });
					break;
				}
				// A cancelled picker leaves an idle page. Reuse it; never navigate a live session.
				const idle = existing.filter((t) => t.id != null);
				if (idle.length > 1) await chrome.tabs.remove(idle.slice(1).map((t) => t.id!)).catch(() => {});
				const keep = idle.find((t) => t.id === recorderOwnerId) ?? idle[0];
				if (keep?.id != null) {
					const next = chrome.runtime.getURL(`recorder.html?${q}`);
					if (keep.url !== next) await chrome.tabs.update(keep.id, { url: next });
					recorderOwnerId = keep.id;
					await focusRecorder(keep.id);
					reply({ ok: true, pointer, reused: true });
					break;
				}
				const created = await chrome.tabs.create({ url: chrome.runtime.getURL(`recorder.html?${q}`), active: true });
				recorderOwnerId = created.id ?? null;
				reply({ ok: true, pointer, reused: false });
				break;
			}
			case "stop": {
				const page = await askRecorder("stop");
				if (page) return reply(page);
				const offscreen = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
				reply(
					offscreen.length
						? await chrome.runtime.sendMessage({ target: "recorder", type: "stop" }).catch(() => ({ ok: false, error: "Recorder closed" }))
						: { ok: false, error: "Recorder closed" },
				);
				break;
			}
			case "status": {
				const page = await askRecorder("status");
				if (page) return reply(page);
				const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
				reply(ctx.length ? await chrome.runtime.sendMessage({ target: "recorder", type: "status" }).catch(() => ({ recording: false })) : { recording: false });
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

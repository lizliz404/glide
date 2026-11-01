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

async function askRecorder(type: "status" | "stop" | "pause" | "resume") {
	const tabs = await recorderTabs();
	const owner = tabs.find((t) => t.id === recorderOwnerId) ?? tabs[0];
	if (owner?.id == null) {
		recorderOwnerId = null;
		return null;
	}
	recorderOwnerId = owner.id;
	return chrome.tabs.sendMessage(owner.id, { target: "recorder", type }).catch(() => null);
}

/** status/stop against the offscreen recorder document, or null when it does not exist. */
async function offscreenStatus(type: "status" | "stop" = "status") {
	const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
	if (!ctx.length) return null;
	return chrome.runtime.sendMessage({ target: "recorder", type }).catch(() => null);
}

async function focusRecorder(tabId: number) {
	const tab = await chrome.tabs.get(tabId);
	if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
	await chrome.tabs.update(tabId, { active: true });
}

async function setBadge(on: boolean, paused = false) {
	await chrome.action.setBadgeText({ text: on ? (paused ? "II" : "REC") : "" });
	if (on) await chrome.action.setBadgeBackgroundColor({ color: paused ? "#8b8d98" : "#e5484d" });
}

// Focused-window pointer heuristic: the recorder accepts events only from tabs inside
// the focused window for picker-based (window/screen) captures. Pushed on start and on
// every focus change; tab capture ignores this (it binds an exact tabId instead).
let focusedWindowId: number | null = null;

function pushFocusedWindow() {
	void chrome.runtime.sendMessage({ target: "recorder", type: "focusWindow", windowId: focusedWindowId }).catch(() => {});
}

chrome.windows.onFocusChanged.addListener((id) => {
	focusedWindowId = id === chrome.windows.WINDOW_ID_NONE ? null : id;
	pushFocusedWindow();
});

// Floating teleprompter window lifecycle. The window id is kept in memory and
// re-checked against chrome.windows.get on every toggle (SW restarts are fine).
let teleWindowId: number | null = null;

async function teleWindowExists() {
	if (teleWindowId == null) return false;
	const win = await chrome.windows.get(teleWindowId).catch(() => null);
	if (!win) teleWindowId = null;
	return win != null;
}

async function toggleTeleWindow(): Promise<boolean> {
	if (await teleWindowExists()) {
		await chrome.windows.remove(teleWindowId!).catch(() => {});
		teleWindowId = null;
		return false;
	}
	const { glideTeleBounds } = await chrome.storage.local.get("glideTeleBounds");
	const b = (glideTeleBounds ?? {}) as { left?: number; top?: number; width?: number; height?: number };
	const win = await chrome.windows.create({
		url: chrome.runtime.getURL("teleprompter.html"),
		type: "popup",
		width: b.width ?? 560,
		height: b.height ?? 300,
		left: b.left,
		top: b.top,
		focused: true,
	});
	teleWindowId = win?.id ?? null;
	return teleWindowId != null;
}

chrome.windows.onRemoved.addListener((id) => {
	if (id === teleWindowId) teleWindowId = null;
});

async function refreshFocusedWindow() {
	// Normal windows only: devtools/popup windows must not become the pointer scope.
	const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
	focusedWindowId = w?.id ?? null;
	pushFocusedWindow();
}

// Closing a page-mode recorder tab mid-recording kills the session silently: no "saved" and
// no "failed" ever arrives, leaving the REC badge and glideRecording flag stuck. Clean up here.
// Normal stops send "saved" before the tab closes, which already clears the flag, so the
// storage check keeps that path a no-op.
chrome.tabs.onRemoved.addListener((tabId) => {
	if (tabId !== recorderOwnerId) return;
	recorderOwnerId = null;
	void (async () => {
		const { glideRecording } = await chrome.storage.local.get("glideRecording");
		if (!glideRecording) return;
		// Another recorder page may still own the session (prepare-page can re-point the owner).
		const live = await askRecorder("status");
		if (live?.recording) return;
		await stopPointerLogging();
		await setBadge(false);
	})();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg?.target !== "background") return;
	(async () => {
		switch (msg.type) {
			case "start": {
				const opts = msg.opts as RecordOptions;
				// A stale idle recorder page can sit next to a live offscreen session;
				// never start a second capture while any recorder reports recording.
				if ((await askRecorder("status"))?.recording || (await offscreenStatus())?.recording) {
					reply({ ok: false, error: "Already recording" });
					break;
				}
				const pointer = await startPointerLogging();
				await ensureOffscreen();
				const res = await chrome.runtime.sendMessage({
					target: "recorder",
					type: "start",
					opts: { ...opts, pointerEnabled: pointer },
				});
				if (res?.ok) {
					await chrome.storage.local.set({ glideRecording: true });
					await setBadge(true);
					await refreshFocusedWindow();
				} else {
					await stopPointerLogging();
					await chrome.offscreen.closeDocument().catch(() => {});
				}
				reply({ ...res, pointer });
				break;
			}
			case "start-tab": {
				// Single-tab capture via chrome.tabCapture: no picker, exact tab identity,
				// and the video contains no browser chrome. The stream id is minted here
				// and consumed by the offscreen recorder via getUserMedia(chromeMediaSource).
				const opts = msg.opts as RecordOptions;
				const tabId = msg.tabId as number;
				if ((await askRecorder("status"))?.recording || (await offscreenStatus())?.recording) {
					reply({ ok: false, error: "Already recording" });
					break;
				}
				const pointer = await startPointerLogging();
				let streamId: string;
				try {
					streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
				} catch (err) {
					await stopPointerLogging();
					reply({ ok: false, error: `tabCapture: ${err instanceof Error ? err.message : err}` });
					break;
				}
				await ensureOffscreen();
				const res = await chrome.runtime
					.sendMessage({
						target: "recorder",
						type: "start",
						opts: { ...opts, tabStreamId: streamId, sourceTabId: tabId, pointerEnabled: pointer },
					})
					.catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : "Recorder unavailable" }));
				if (res?.ok) {
					await chrome.storage.local.set({ glideRecording: true });
					await setBadge(true);
					await refreshFocusedWindow();
				} else {
					await stopPointerLogging();
					await chrome.offscreen.closeDocument().catch(() => {});
				}
				reply({ ...res, pointer });
				break;
			}
			case "prepare-page": {
				// Only one recorder listener may own start/stop/status replies.
				if ((await offscreenStatus())?.recording) {
					reply({ ok: false, error: "Already recording" });
					break;
				}
				await chrome.offscreen.closeDocument().catch(() => {});
				const pointer = await startPointerLogging();
				const q = new URLSearchParams({
					page: "1",
					mic: msg.opts.mic ? "1" : "0",
					camera: msg.opts.camera ? "1" : "0",
					surface: msg.opts.surface,
					ptr: pointer ? "1" : "0",
				});
				await refreshFocusedWindow();
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
				// The owner may be a page or the offscreen doc; a page reply with no id
				// means it was idle, so keep looking before declaring the session dead.
				const page = await askRecorder("stop");
				if (page?.id) return reply(page);
				const off = await offscreenStatus("stop");
				reply(off ?? page ?? { ok: false, error: "Recorder closed" });
				break;
			}
			case "pause":
			case "resume": {
				const res =
					(await askRecorder(msg.type)) ??
					(await chrome.runtime.sendMessage({ target: "recorder", type: msg.type }).catch(() => ({ ok: false, error: "Recorder closed" })));
				if (res?.ok) await setBadge(true, res.paused);
				reply(res);
				break;
			}
			case "status": {
				const page = await askRecorder("status");
				if (page?.recording) return reply(page);
				const off = await offscreenStatus();
				const st = off?.recording ? off : (page ?? off ?? { recording: false });
				// The recorder tab was closed or the document died: drop the stale REC badge.
				if (!st?.recording) await setBadge(false);
				reply(st);
				break;
			}
			case "tele-toggle":
				reply({ open: await toggleTeleWindow() });
				break;
			case "tele-state":
				reply({ open: await teleWindowExists() });
				break;
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

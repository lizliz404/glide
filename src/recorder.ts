// Recorder: runs in the offscreen document (default) or in recorder.html opened as a normal
// tab (fallback when the browser refuses getDisplayMedia without a direct user gesture).
// Captures: display (tab/window/screen), mic, webcam.
// Display video + mixed audio go into one WebM; webcam goes into a second WebM so the
// editor can place it freely. Pointer events from content scripts are collected here.
import { appendChunk, finishChunks } from "./shared/db";
import { acceptsPointerSender, type PointerSource } from "./shared/pointerScope";
import type { PointerEvt, RecordOptions, RecordingMeta, Surface } from "./shared/types";

const isPage = new URLSearchParams(location.search).has("page");

interface Session {
	screenRec: MediaRecorder;
	camRec: MediaRecorder | null;
	id: string;
	/** Chunk writes in order; stop waits for the last one before assembling the take. */
	writes: Promise<unknown>;
	writeError: string | null;
	streams: MediaStream[];
	audioCtx: AudioContext | null;
	events: PointerEvt[];
	startedAt: number;
	surface: Surface;
	width: number;
	height: number;
	opts: RecordOptions;
	stopping: Promise<string> | null;
	/** Wall-clock [from, to) ranges spent paused; `to` is 0 while still paused. */
	pauses: [number, number][];
}

/** Wall-clock ms spent paused before `t`, so recorded time is continuous across pauses. */
function pausedBefore(s: Session, t: number) {
	return s.pauses.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(t, b || t) - a), 0);
}
let session: Session | null = null;
/** Provenance rule for incoming pointer events; set by start(). */
let pointerSource: PointerSource = { kind: "unknown" };
/** Window the OS currently reports as focused. Tracked locally (the service worker
 *  also pushes updates, which covers contexts where window events do not fire). */
let focusedWindowId: number | null = null;

// Offscreen documents do not expose every chrome.* surface; degrade quietly and let
// the service worker's focusWindow pushes carry the heuristic there.
try {
	void chrome.windows
		.getLastFocused({ windowTypes: ["normal"] })
		.then((w) => (focusedWindowId = w?.id ?? null))
		.catch(() => {});
	chrome.windows.onFocusChanged.addListener((id) => {
		focusedWindowId = id === chrome.windows.WINDOW_ID_NONE ? null : id;
	});
} catch {
	/* no windows API in this context — rely on pushed focusWindow messages */
}

/** Re-read the focused window at capture start: onFocusChanged can be unreliable on
 *  some platforms (Wayland), and pushed messages may predate a page-mode recorder. */
async function refreshFocusedWindow() {
	try {
		const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		if (w?.id != null) focusedWindowId = w.id;
	} catch {
		/* keep the last known value */
	}
}

function pickMime(kind: "video" | "camera") {
	const list =
		kind === "video"
			? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
			: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
	return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

function metaOf(s: Session): RecordingMeta {
	const startedAt = s.startedAt || Date.now();
	return {
		id: s.id,
		createdAt: startedAt,
		startedAt,
		durationMs: Date.now() - startedAt - pausedBefore(s, Date.now()),
		surface: s.surface,
		width: s.width,
		height: s.height,
		hasCamera: !!s.camRec,
		hasMic: s.opts.mic,
		headTrimMs: s.opts.headTrimMs,
	};
}

async function start(
	opts: RecordOptions,
): Promise<{ ok: boolean; error?: string; surface?: Surface; requested?: Surface; warnings?: string[] }> {
	if (session) return { ok: false, error: "Already recording" };
	const warnings: string[] = [];
	const streams: MediaStream[] = [];
	try {
		// Single-tab capture consumes a chrome.tabCapture stream id directly: no picker,
		// and the tabId is known exactly so pointer telemetry can be trusted. Window and
		// screen still go through Chrome's picker (getDisplayMedia).
		// https://developer.chrome.com/docs/web-platform/screen-sharing-controls
		const display = opts.tabStreamId
			? await navigator.mediaDevices.getUserMedia({
					audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: opts.tabStreamId } },
					video: {
						mandatory: {
							chromeMediaSource: "tab",
							chromeMediaSourceId: opts.tabStreamId,
							maxWidth: 3840,
							maxHeight: 2160,
							maxFrameRate: 60,
						},
					},
				} as MediaStreamConstraints)
			: await navigator.mediaDevices.getDisplayMedia({
			video: {
				displaySurface: opts.surface,
				frameRate: { ideal: 60, max: 60 },
				// Glide redraws a smoothed cursor; ask the browser to leave it out where supported.
				cursor: "never",
			} as MediaTrackConstraints,
			audio: true,
			surfaceSwitching: "include",
			selfBrowserSurface: "exclude",
			systemAudio: "include",
			monitorTypeSurfaces: "include",
		} as DisplayMediaStreamOptions);
		streams.push(display);
		const vTrack = display.getVideoTracks()[0];
		const settings = vTrack.getSettings() as MediaTrackSettings & { displaySurface?: Surface };

		let mic: MediaStream | null = null;
		if (opts.mic) {
			mic = await navigator.mediaDevices
				.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
				.catch((e: DOMException) => (warnings.push(`Microphone unavailable (${e.name}); recording without it.`), null));
			if (mic) streams.push(mic);
		}
		let cam: MediaStream | null = null;
		if (opts.camera) {
			cam = await navigator.mediaDevices
				.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
				.catch((e: DOMException) => (warnings.push(`Camera unavailable (${e.name}); recording without it.`), null));
			if (cam) streams.push(cam);
		}

		// Mix tab/system audio and mic into one track.
		let audioCtx: AudioContext | null = null;
		const audioTracks: MediaStreamTrack[] = [];
		const sources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
		if (sources.length) {
			audioCtx = new AudioContext();
			const dest = audioCtx.createMediaStreamDestination();
			for (const s of sources) audioCtx.createMediaStreamSource(s).connect(dest);
			// Tab capture mutes the tab locally; play tab audio back so the user still hears it.
			if (display.getAudioTracks().length && (settings.displaySurface === "browser" || opts.tabStreamId)) {
				audioCtx.createMediaStreamSource(display).connect(audioCtx.destination);
			}
			audioTracks.push(...dest.stream.getAudioTracks());
		}

		// Scale with what was actually captured, like Screenity's per-resolution presets
		// (720p 5, 1080p 12, 4K 20 Mbps): ~0.13 bits/pixel/frame gives ~8 Mbps at 1080p30,
		// ~14 at 1440p30, ~32 at 4K30, clamped to 4–40 Mbps.
		const px = (settings.width ?? 1920) * (settings.height ?? 1080) * Math.min(settings.frameRate ?? 30, 60);
		const bitrate = Math.round(Math.min(40e6, Math.max(4e6, px * 0.13)));
		const screenStream = new MediaStream([vTrack, ...audioTracks]);
		const screenRec = new MediaRecorder(screenStream, { mimeType: pickMime("video"), videoBitsPerSecond: bitrate });
		const camRec = cam ? new MediaRecorder(cam, { mimeType: pickMime("camera"), videoBitsPerSecond: 4_000_000 }) : null;

		const s: Session = {
			screenRec,
			camRec,
			id: `rec-${new Date().toISOString().replace(/[:.]/g, "-")}`,
			writes: Promise.resolve(),
			writeError: null,
			streams,
			audioCtx,
			events: [],
			startedAt: 0,
			surface: settings.displaySurface ?? opts.surface,
			width: settings.width ?? 0,
			height: settings.height ?? 0,
			opts,
			stopping: null,
			pauses: [],
		};
		// Provenance for pointer telemetry: exact tab for tabCapture, focused-window
		// heuristic for picker-based window/screen captures. Refresh focus now — the
		// window that was active when capture began is the best heuristic we have.
		pointerSource = opts.sourceTabId != null ? { kind: "tab", tabId: opts.sourceTabId } : { kind: "focused-window" };
		await refreshFocusedWindow();
		// Every second's chunk goes straight to IndexedDB (as Screenity does), so memory stays flat on
		// long takes and a crashed or closed recorder still leaves a recoverable recording.
		const keep = (kind: "screen" | "camera") => (e: BlobEvent) => {
			if (!e.data.size) return;
			const row = { rec: s.id, kind, data: e.data, meta: metaOf(s) };
			s.writes = s.writes.then(() => appendChunk(row)).catch((err: DOMException) => {
				s.writeError = `Could not save recording data (${err?.name ?? "error"}). Free disk space and stop soon.`;
			});
		};
		screenRec.ondataavailable = keep("screen");
		if (camRec) camRec.ondataavailable = keep("camera");
		// User clicked Chrome's "Stop sharing".
		vTrack.addEventListener("ended", () => void stop());

		session = s;
		const started = new Promise<void>((r) => (screenRec.onstart = () => r()));
		camRec?.start(1000);
		screenRec.start(1000);
		await started;
		s.startedAt = Date.now();
		return { ok: true, surface: s.surface, requested: opts.surface, warnings };
	} catch (err) {
		for (const st of streams) for (const t of st.getTracks()) t.stop();
		session = null;
		pointerSource = { kind: "unknown" };
		const e = err as DOMException;
		const error = `${e.name}: ${e.message}`;
		void chrome.runtime.sendMessage({ target: "background", type: "failed", error, page: isPage }).catch(() => {});
		return { ok: false, error };
	}
}

function setPaused(on: boolean) {
	const s = session;
	if (!s || s.stopping) return { ok: false, error: "Not recording" };
	const paused = s.pauses.at(-1)?.[1] === 0;
	if (on === paused) return { ok: true, paused };
	for (const r of [s.screenRec, s.camRec]) if (r) on ? r.pause() : r.resume();
	if (on) s.pauses.push([Date.now(), 0]);
	else s.pauses.at(-1)![1] = Date.now();
	return { ok: true, paused: on };
}

function stopRecorder(r: MediaRecorder | null) {
	return new Promise<void>((resolve) => {
		if (!r || r.state === "inactive") return resolve();
		r.onstop = () => resolve();
		r.stop();
	});
}

function stop(): Promise<string> {
	const s = session;
	if (!s) return Promise.resolve("");
	if (s.stopping) return s.stopping;
	s.stopping = (async () => {
		if (s.pauses.at(-1)?.[1] === 0) s.pauses.at(-1)![1] = Date.now();
		await Promise.all([stopRecorder(s.screenRec), stopRecorder(s.camRec)]);
		for (const st of s.streams) for (const t of st.getTracks()) t.stop();
		await Promise.race([s.audioCtx?.close(), new Promise((r) => setTimeout(r, 1000))]);
		const meta = metaOf(s);
		await s.writes;
		const id = await finishChunks(
			s.id,
			s.events.filter((e) => e.t >= s.startedAt).map((e) => ({ ...e, t: e.t - s.startedAt - pausedBefore(s, e.t) })),
			meta,
		);
		session = null;
		pointerSource = { kind: "unknown" };
		if (!id) throw new Error(s.writeError ?? "Nothing was recorded");
		// Defer: let the "stop" reply reach the service worker first, because handling
		// "saved" closes this offscreen document.
		setTimeout(() => {
			void chrome.runtime.sendMessage({ target: "background", type: "saved", id, page: isPage }).finally(() => {
				if (isPage) window.close();
			});
		}, 50);
		return id;
	})();
	// A failed save must not poison retry: keep the session but drop the cached rejection so
	// the next stop() re-runs the (already-stopped) recorders and retries the IndexedDB write.
	s.stopping.catch(() => {
		s.stopping = null;
	});
	return s.stopping;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (msg?.target !== "recorder") return;
	if (msg.type === "focusWindow") {
		// Focused-window heuristic input, pushed by the service worker on start and on
		// every windows.onFocusChanged. WINDOW_ID_NONE (-1) and friends clear it.
		focusedWindowId = typeof msg.windowId === "number" && msg.windowId >= 0 ? msg.windowId : null;
		return;
	}
	if (msg.type === "pointer") {
		// Only events provably inside the recorded surface become zoom/cursor data.
		// `sender` is Chrome's message metadata, so a page cannot claim another identity.
		if (!acceptsPointerSender(pointerSource, sender?.tab, focusedWindowId)) return;
		// Movement while paused is not in the video, so it is not kept either.
		if (session && session.pauses.at(-1)?.[1] !== 0) session.events.push(msg.evt as PointerEvt);
		return;
	}
	if (isPage && msg.type === "start") return; // page mode starts from its own button
	(async () => {
		if (msg.type === "start") reply(await start(msg.opts));
		else if (msg.type === "stop")
			reply(await stop().then((id) => ({ ok: true, id }), (e: Error) => ({ ok: false, error: e.message })));
		else if (msg.type === "pause" || msg.type === "resume") reply(setPaused(msg.type === "pause"));
		else if (msg.type === "status")
			reply({
				recording: !!session,
				since: session?.startedAt ?? 0,
				events: session?.events.length ?? 0,
				// "tab" = precise follow data, "window" = focused-window best effort, "off" = none.
				pointer: !session?.opts.pointerEnabled
					? "off"
					: pointerSource.kind === "tab"
						? "tab"
						: pointerSource.kind === "focused-window"
							? "window"
							: "off",
				surface: session?.surface ?? null,
				paused: session?.pauses.at(-1)?.[1] === 0,
				error: session?.writeError ?? null,
			});
	})();
	return true;
});

// Fallback page UI.
if (isPage) {
	const btn = document.getElementById("start") as HTMLButtonElement;
	const status = document.getElementById("status") as HTMLElement;
	const p = new URLSearchParams(location.search);
	const opts: RecordOptions = {
		mic: p.get("mic") !== "0",
		camera: p.get("camera") !== "0",
		surface: (p.get("surface") as Surface) || "browser",
		pointerEnabled: p.get("ptr") !== "0",
	};
	const lead = document.getElementById("lead");
	if (lead) {
		lead.textContent =
			opts.surface === "window"
				? "Click start, then choose this browser window. Recording follows tab switches in that window. Chrome's picker can still choose a tab or screen instead."
				: opts.surface === "browser"
					? "Click start, then choose one tab. That capture stays locked to the tab; it does not follow switches."
					: "Click start, then choose a screen in Chrome's dialog.";
	}
	btn.addEventListener("click", async () => {
		if (session?.stopping) return;
		if (session) {
			btn.disabled = true;
			status.textContent = "Saving…";
			try {
				await stop();
			} catch (err) {
				btn.disabled = false;
				const why = err instanceof Error ? err.message : "Could not save";
				status.textContent = /quota|disk|space/i.test(why)
					? "Not enough disk space to save. Free some space, then press Stop and edit again. Closing this tab discards the recording."
					: `${why} — the recording is still in this tab. Press Stop and edit to try again.`;
			}
			return;
		}
		btn.disabled = true;
		const res = await start(opts);
		btn.disabled = false;
		if (!res.ok) {
			status.textContent = startFailure(res.error);
			return;
		}
		await chrome.storage.local.set({ glideRecording: true });
		await chrome.action.setBadgeText({ text: "REC" });
		await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
		btn.textContent = "Stop and edit";
		btn.className = "btn danger";
		btn.type = "button";
		document.getElementById("rec-dot")!.hidden = false;
		if (lead) lead.textContent = "Recording in progress — keep this tab open. Stop from the Glide toolbar button or the button below; the editor opens next.";
		// Never print the raw capture id (`web-contents-media-stream://9:17`, `screen:-3:0`).
		const what =
			res.surface === "window"
				? "Recording this window. Tab switches inside it are recorded; hide the browser top later in the editor."
				: res.surface === "browser"
					? "Recording this tab. To record tab switches, stop and choose a browser window."
					: "Recording the selected screen. Keep this recorder open.";
		status.textContent = `${[what, ...(res.warnings ?? [])].join(" ")} Cursor effects follow the focused window — they track the pointer inside whichever window is active (best effort, not exact).`;
	});
	// Guard while the session object exists: stopping is async, so "Saving…" is still unsaved.
	window.addEventListener("beforeunload", (e) => {
		if (session) e.preventDefault();
	});
}

function startFailure(error?: string) {
	if (!error) return "Could not start — press Start recording to try again.";
	if (/NotAllowedError|Permission denied|permission/i.test(error)) return "Chrome blocked the capture. Press Start recording and choose a tab, window, or screen in the dialog.";
	if (/NotFoundError|no audio|no video|device/i.test(error)) return "No capture device was available. Press Start recording and pick a different source.";
	if (/NotSupportedError|codec|mime/i.test(error)) return "This browser cannot record that format. Update Chrome, then press Start recording again.";
	return `${error} — press Start recording to try again.`;
}

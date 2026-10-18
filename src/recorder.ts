// Recorder: runs in the offscreen document (default) or in recorder.html opened as a normal
// tab (fallback when the browser refuses getDisplayMedia without a direct user gesture).
// Captures: display (tab/window/screen, user picks in Chrome's picker), mic, webcam.
// Display video + mixed audio go into one WebM; webcam goes into a second WebM so the
// editor can place it freely. Pointer events from content scripts are collected here.
import { saveRecording } from "./shared/db";
import type { PointerEvt, RecordOptions, RecordingMeta, Surface } from "./shared/types";

const isPage = new URLSearchParams(location.search).has("page");

interface Session {
	screenRec: MediaRecorder;
	camRec: MediaRecorder | null;
	screenChunks: Blob[];
	camChunks: Blob[];
	streams: MediaStream[];
	audioCtx: AudioContext | null;
	events: PointerEvt[];
	startedAt: number;
	surface: Surface;
	width: number;
	height: number;
	opts: RecordOptions;
	stopping: Promise<string> | null;
}
let session: Session | null = null;

function pickMime(kind: "video" | "camera") {
	const list =
		kind === "video"
			? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
			: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
	return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

async function start(opts: RecordOptions): Promise<{ ok: boolean; error?: string; name?: string; surface?: Surface; requested?: Surface }> {
	if (session) return { ok: false, error: "Already recording" };
	const streams: MediaStream[] = [];
	try {
		// https://developer.chrome.com/docs/web-platform/screen-sharing-controls
		const display = await navigator.mediaDevices.getDisplayMedia({
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
				.catch(() => null);
			if (mic) streams.push(mic);
		}
		let cam: MediaStream | null = null;
		if (opts.camera) {
			cam = await navigator.mediaDevices
				.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
				.catch(() => null);
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
			if (display.getAudioTracks().length && settings.displaySurface === "browser") {
				audioCtx.createMediaStreamSource(display).connect(audioCtx.destination);
			}
			audioTracks.push(...dest.stream.getAudioTracks());
		}

		const screenStream = new MediaStream([vTrack, ...audioTracks]);
		const screenRec = new MediaRecorder(screenStream, { mimeType: pickMime("video"), videoBitsPerSecond: 12_000_000 });
		const camRec = cam ? new MediaRecorder(cam, { mimeType: pickMime("camera"), videoBitsPerSecond: 4_000_000 }) : null;

		const s: Session = {
			screenRec,
			camRec,
			screenChunks: [],
			camChunks: [],
			streams,
			audioCtx,
			events: [],
			startedAt: 0,
			surface: settings.displaySurface ?? opts.surface,
			width: settings.width ?? 0,
			height: settings.height ?? 0,
			opts,
			stopping: null,
		};
		screenRec.ondataavailable = (e) => e.data.size && s.screenChunks.push(e.data);
		if (camRec) camRec.ondataavailable = (e) => e.data.size && s.camChunks.push(e.data);
		// User clicked Chrome's "Stop sharing".
		vTrack.addEventListener("ended", () => void stop());

		session = s;
		const started = new Promise<void>((r) => (screenRec.onstart = () => r()));
		camRec?.start(1000);
		screenRec.start(1000);
		await started;
		s.startedAt = Date.now();
		return { ok: true, name: vTrack.label, surface: s.surface, requested: opts.surface };
	} catch (err) {
		for (const st of streams) for (const t of st.getTracks()) t.stop();
		session = null;
		const e = err as DOMException;
		const error = `${e.name}: ${e.message}`;
		void chrome.runtime.sendMessage({ target: "background", type: "failed", error, page: isPage }).catch(() => {});
		return { ok: false, error };
	}
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
		await Promise.all([stopRecorder(s.screenRec), stopRecorder(s.camRec)]);
		for (const st of s.streams) for (const t of st.getTracks()) t.stop();
		await Promise.race([s.audioCtx?.close(), new Promise((r) => setTimeout(r, 1000))]);
		const meta: RecordingMeta = {
			id: `rec-${new Date().toISOString().replace(/[:.]/g, "-")}`,
			createdAt: Date.now(),
			startedAt: s.startedAt,
			durationMs: Date.now() - s.startedAt,
			surface: s.surface,
			width: s.width,
			height: s.height,
			hasCamera: s.camChunks.length > 0,
			hasMic: s.opts.mic,
		};
		const id = await saveRecording({
			meta,
			screen: new Blob(s.screenChunks, { type: "video/webm" }),
			camera: s.camChunks.length ? new Blob(s.camChunks, { type: "video/webm" }) : null,
			events: s.events.filter((e) => e.t >= s.startedAt).map((e) => ({ ...e, t: e.t - s.startedAt })),
		});
		session = null;
		// Defer: let the "stop" reply reach the service worker first, because handling
		// "saved" closes this offscreen document.
		setTimeout(() => {
			void chrome.runtime.sendMessage({ target: "background", type: "saved", id, page: isPage }).finally(() => {
				if (isPage) window.close();
			});
		}, 50);
		return id;
	})();
	return s.stopping;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg?.target !== "recorder") return;
	if (msg.type === "pointer") {
		session?.events.push(msg.evt as PointerEvt);
		return;
	}
	if (isPage && msg.type === "start") return; // page mode starts from its own button
	(async () => {
		if (msg.type === "start") reply(await start(msg.opts));
		else if (msg.type === "stop") reply({ ok: true, id: await stop() });
		else if (msg.type === "status")
			reply({ recording: !!session, since: session?.startedAt ?? 0, events: session?.events.length ?? 0 });
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
		surface: (p.get("surface") as Surface) || "window",
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
				status.textContent = err instanceof Error ? err.message : "Could not save";
			}
			return;
		}
		btn.disabled = true;
		const res = await start(opts);
		btn.disabled = false;
		if (!res.ok) {
			status.textContent = res.error ?? "Could not start";
			return;
		}
		await chrome.storage.local.set({ glideRecording: true });
		await chrome.action.setBadgeText({ text: "REC" });
		btn.textContent = "Stop and edit";
		status.textContent = res.surface === "window"
			? `Recording ${res.name ?? ""}. Tab switches inside the selected window are recorded. Keep this recorder open; hide the browser top later in the editor.`
			: res.surface === "browser"
				? `Recording ${res.name ?? ""}. This captures one tab only. To record tab switches, stop and choose a browser window.`
				: `Recording ${res.name ?? ""}. Keep this recorder open. The selected screen is being recorded.`;
	});
}

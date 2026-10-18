// Frame-accurate export with WebCodecs via Mediabunny (https://mediabunny.dev, MPL-2.0).
// Decode source frames at exact output timestamps, composite on an OffscreenCanvas, encode.
// Encoding is independent of real-time playback; throughput depends on compositing and hardware.
// Trim range / timestamp-rebasing pattern only (no source snippets copied): Screenity
// src/pages/Editor/mediabunny/lib/videoTrimmer.ts @ 90a3a8b38ab87466589e17dfbf2f97717ca48baa.
// Unlike that keyframe stream-copy path, this re-composites at absolute source times and clips PCM audio.
import {
	ALL_FORMATS,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	Input,
	Mp4OutputFormat,
	Output,
	QUALITY_HIGH,
	WebMOutputFormat,
} from "mediabunny";
import { Compositor, type SceneData } from "./compose";
import { preloadCursorAssets } from "./cursor";
import { outputSize, type GlideSettings } from "./settings";

export interface ExportOptions {
	container: "mp4" | "webm";
	fps: number;
	screen: Blob;
	camera: Blob | null;
	bgImage: CanvasImageSource | null;
	scene: SceneData;
	settings: GlideSettings;
	durationMs: number;
	/** Source-relative interval [startMs, endMs); source/scene timestamps stay unchanged. */
	trim?: { startMs: number; endMs: number };
	onProgress?: (p: number) => void;
	signal?: AbortSignal;
}

export interface ExportResult {
	blob: Blob;
	videoCodec: string;
	audioCodec: string | null;
	width: number;
	height: number;
}

export async function exportVideo(o: ExportOptions): Promise<ExportResult> {
	const startMs = o.trim?.startMs ?? 0;
	const endMs = o.trim?.endMs ?? o.durationMs;
	if (!Number.isFinite(o.durationMs) || o.durationMs <= 0 || !Number.isFinite(o.fps) || o.fps <= 0
		|| !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > o.durationMs) {
		throw new Error("Invalid export trim interval, duration or frame rate");
	}
	const start = startMs / 1000;
	const duration = (endMs - startMs) / 1000;
	const inputs: Input[] = [];
	let output: Output | null = null;
	let cancelJob: Promise<void> | null = null;
	let stopped = false;
	const jobs: Promise<void>[] = [];
	const checkCancelled = () => {
		if (stopped || o.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
	};
	const stop = () => {
		stopped = true;
		// dispose() interrupts pending sink reads as well as releasing decoder resources.
		for (const input of inputs) input.dispose();
		if (output && output.state !== "finalized") cancelJob ??= output.cancel().catch(() => {});
	};
	o.signal?.addEventListener("abort", stop, { once: true });
	try {
		checkCancelled();
		const { width, height } = outputSize(o.settings.aspect);
		const mp4 = o.container === "mp4";
		const videoCodec = await getFirstEncodableVideoCodec(mp4 ? ["avc", "vp9", "av1"] : ["vp9", "vp8", "av1"], { width, height });
		if (!videoCodec) throw new Error("No WebCodecs video encoder available in this browser");
		const audioCodec = await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus", "vorbis"]);
		checkCancelled();

		const screenIn = new Input({ source: new BlobSource(o.screen), formats: ALL_FORMATS });
		inputs.push(screenIn);
		const vt = await screenIn.getPrimaryVideoTrack();
		if (!vt) throw new Error("Recording has no video track");
		const at = await screenIn.getPrimaryAudioTrack();
		const t0 = await vt.getFirstTimestamp();
		const screenSink = new CanvasSink(vt, { poolSize: 2 });

		let camSink: CanvasSink | null = null;
		let camT0 = 0;
		checkCancelled();
		if (o.camera && o.settings.webcam.enabled) {
			const camIn = new Input({ source: new BlobSource(o.camera), formats: ALL_FORMATS });
			inputs.push(camIn);
			const ct = await camIn.getPrimaryVideoTrack();
			if (ct) {
				camT0 = await ct.getFirstTimestamp();
				camSink = new CanvasSink(ct, { width: 640, poolSize: 2 });
			}
		}
		checkCancelled();
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) throw new Error("Failed to get export canvas context");
		output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target: new BufferTarget() });
		const vsrc = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
		output.addVideoTrack(vsrc, { frameRate: o.fps });
		let asrc: AudioSampleSource | null = null;
		if (at && audioCodec && (await at.canDecode())) {
			asrc = new AudioSampleSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
			output.addAudioTrack(asrc);
		}
		checkCancelled();
		await output.start();
		// Preserve the untrimmed frame count; trimmed exports cover even a partial final frame.
		const frames = Math.max(1, o.trim ? Math.ceil(duration * o.fps - 1e-9) : Math.round(duration * o.fps));
		const times = Array.from({ length: frames }, (_, i) => i / o.fps);
		if (o.settings.cursor.show) await preloadCursorAssets();
		checkCancelled();
		const comp = new Compositor(o.settings);
		comp.reset();

		jobs.push((async () => {
			const screenIt = screenSink.canvasesAtTimestamps(times.map((t) => t0 + start + t));
			const camIt = camSink?.canvasesAtTimestamps(times.map((t) => camT0 + start + t)) ?? null;
			try {
				let lastScreen: CanvasImageSource | null = null;
				for (let i = 0; i < frames; i++) {
					checkCancelled();
					const s = await screenIt.next();
					const c = camIt ? await camIt.next() : null;
					checkCancelled();
					if (s.value) lastScreen = s.value.canvas;
					const camCanvas = c?.value?.canvas ?? null;
					comp.draw(ctx, width, height, startMs + times[i] * 1000,
						{ screen: lastScreen, cam: camCanvas, camW: camCanvas?.width ?? 0, camH: camCanvas?.height ?? 0, bgImage: o.bgImage },
						o.scene, i === 0);
					await vsrc.add(times[i], o.trim ? Math.min(1 / o.fps, duration - times[i]) : 1 / o.fps);
					if (i % 10 === 0) o.onProgress?.(i / frames);
				}
				vsrc.close();
			} finally {
				await Promise.allSettled([screenIt.return(), camIt?.return()]);
			}
		})());

		jobs.push((async () => {
			if (!asrc || !at) return;
			const audioStart = t0 + start;
			const audioEnd = t0 + endMs / 1000;
			for await (const sample of new AudioSampleSink(at).samples(audioStart, audioEnd)) {
				let clipped: typeof sample | null = null;
				try {
					checkCancelled();
					// Sink ranges can return a sample straddling either boundary. Keep only whole
					// PCM frames within the interval (sub-frame precision is not representable).
					const lo = Math.max(0, Math.min(sample.numberOfFrames, Math.ceil((audioStart - sample.timestamp) * sample.sampleRate - 1e-7)));
					const hi = Math.max(0, Math.min(sample.numberOfFrames, Math.floor((audioEnd - sample.timestamp) * sample.sampleRate + 1e-7)));
					if (hi <= lo) continue;
					const kept = lo === 0 && hi === sample.numberOfFrames ? sample : (clipped = sample.trim(lo, hi));
					kept.setTimestamp(Math.max(0, kept.timestamp - audioStart));
					await asrc.add(kept);
				} finally {
					clipped?.close();
					sample.close();
				}
			}
			asrc.close();
		})());

		await Promise.all(jobs);
		checkCancelled();
		await output.finalize();
		checkCancelled();
		o.onProgress?.(1);
		const buf = (output.target as BufferTarget).buffer!;
		return { blob: new Blob([buf], { type: mp4 ? "video/mp4" : "video/webm" }), videoCodec,
			audioCodec: asrc ? audioCodec : null, width, height };
	} catch (error) {
		stop();
		await Promise.allSettled(jobs);
		await cancelJob;
		if (o.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
		throw error;
	} finally {
		o.signal?.removeEventListener("abort", stop);
		for (const input of inputs) input.dispose();
	}
}

/** Remux a MediaRecorder WebM (no duration, no cues) into a seekable WebM without re-encoding. */
export async function makeSeekable(blob: Blob): Promise<{ blob: Blob; durationMs: number }> {
	const { Conversion } = await import("mediabunny");
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	const durationMs = (await input.computeDuration()) * 1000;
	try {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const conv = await Conversion.init({ input, output });
		if (!conv.isValid) return { blob, durationMs };
		await conv.execute();
		return { blob: new Blob([(output.target as BufferTarget).buffer!], { type: "video/webm" }), durationMs };
	} catch {
		return { blob, durationMs };
	}
}

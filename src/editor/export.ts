// Frame-accurate export with WebCodecs via Mediabunny (https://mediabunny.dev, MPL-2.0).
// Decode source frames at exact output timestamps, composite on an OffscreenCanvas, encode.
// This is faster than real time and avoids MediaRecorder's dropped frames.
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
import { Camera, type Track, type ZoomSegment } from "./camera";
import { renderFrame } from "./render";
import { outputSize, type Settings } from "./settings";

export interface ExportOptions {
	container: "mp4" | "webm";
	fps: number;
	screen: Blob;
	camera: Blob | null;
	bgImage: CanvasImageSource | null;
	track: Track;
	segments: ZoomSegment[];
	settings: Settings;
	durationMs: number;
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
	const { width, height } = outputSize(o.settings.aspect);
	const mp4 = o.container === "mp4";
	const videoCodec = await getFirstEncodableVideoCodec(mp4 ? ["avc", "vp9", "av1"] : ["vp9", "vp8", "av1"], { width, height });
	if (!videoCodec) throw new Error("No WebCodecs video encoder available in this browser");
	const audioCodec = await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus", "vorbis"]);

	const screenIn = new Input({ source: new BlobSource(o.screen), formats: ALL_FORMATS });
	const vt = await screenIn.getPrimaryVideoTrack();
	if (!vt) throw new Error("Recording has no video track");
	const at = await screenIn.getPrimaryAudioTrack();
	const t0 = await vt.getFirstTimestamp();
	const screenSink = new CanvasSink(vt, { poolSize: 2 });

	let camSink: CanvasSink | null = null;
	let camT0 = 0;
	if (o.camera && o.settings.webcam.show) {
		const camIn = new Input({ source: new BlobSource(o.camera), formats: ALL_FORMATS });
		const ct = await camIn.getPrimaryVideoTrack();
		if (ct) {
			camT0 = await ct.getFirstTimestamp();
			camSink = new CanvasSink(ct, { width: 640, poolSize: 2 });
		}
	}

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D;
	const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target: new BufferTarget() });
	const vsrc = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
	output.addVideoTrack(vsrc, { frameRate: o.fps });
	let asrc: AudioSampleSource | null = null;
	if (at && audioCodec && (await at.canDecode())) {
		asrc = new AudioSampleSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
		output.addAudioTrack(asrc);
	}
	await output.start();

	const frames = Math.max(1, Math.round((o.durationMs / 1000) * o.fps));
	const times = Array.from({ length: frames }, (_, i) => i / o.fps);
	const camera = new Camera(o.track, o.segments, o.settings);
	const dt = 1000 / o.fps;

	const videoJob = (async () => {
		const screenIt = screenSink.canvasesAtTimestamps(times.map((t) => t0 + t));
		const camIt = camSink?.canvasesAtTimestamps(times.map((t) => camT0 + t)) ?? null;
		let lastScreen: CanvasImageSource | null = null;
		for (let i = 0; i < frames; i++) {
			if (o.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
			const s = await screenIt.next();
			const c = camIt ? await camIt.next() : null;
			if (s.value) lastScreen = s.value.canvas;
			const tMs = times[i] * 1000;
			renderFrame(ctx, width, height, {
				screen: lastScreen as never,
				camera: (c?.value?.canvas ?? null) as never,
				bgImage: o.bgImage,
				cam: camera.frame(tMs, dt),
				track: o.track,
				t: tMs,
				settings: o.settings,
			});
			await vsrc.add(times[i], 1 / o.fps);
			if (i % 10 === 0) o.onProgress?.(i / frames);
		}
		vsrc.close();
	})();

	const audioJob = (async () => {
		if (!asrc || !at) return;
		const end = t0 + o.durationMs / 1000;
		for await (const sample of new AudioSampleSink(at).samples(t0, end)) {
			if (o.signal?.aborted) {
				sample.close();
				break;
			}
			sample.setTimestamp(sample.timestamp - t0);
			await asrc.add(sample);
			sample.close();
		}
		asrc.close();
	})();

	await Promise.all([videoJob, audioJob]);
	await output.finalize();
	o.onProgress?.(1);
	const buf = (output.target as BufferTarget).buffer!;
	return {
		blob: new Blob([buf], { type: mp4 ? "video/mp4" : "video/webm" }),
		videoCodec,
		audioCodec: asrc ? audioCodec : null,
		width,
		height,
	};
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

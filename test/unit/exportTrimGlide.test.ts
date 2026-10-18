import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inputs: [] as any[], outputs: [] as any[], videoAdds: [] as number[][],
	audioAdds: [] as { timestamp: number; duration: number; frames: number; data: number[] }[],
	sinkTimes: [] as { track: string; times: number[] }[], draws: [] as any[][],
	samples: [] as any[], iteratorsClosed: [] as string[],
	videoCodec: "avc" as string | null, audioCodec: "opus" as string | null,
	videoFailure: null as Error | null, audioFailure: null as Error | null,
	onVideoAdd: null as (() => void) | null,
	hasAudio: true, hasVideo: true,
}));

vi.mock("mediabunny", async (importOriginal) => {
	const original = await importOriginal<typeof import("mediabunny")>();
	return {
		...original,
		getFirstEncodableVideoCodec: vi.fn(async () => mocks.videoCodec),
		getFirstEncodableAudioCodec: vi.fn(async () => mocks.audioCodec),
		BlobSource: class { constructor(public blob: Blob) {} },
		Input: class {
			dispose = vi.fn();
			index = mocks.inputs.length;
			constructor() { mocks.inputs.push(this); }
			async getPrimaryVideoTrack() {
				if (!mocks.hasVideo) return null;
				return { name: this.index ? "camera" : "screen", getFirstTimestamp: async () => this.index ? 7 : 2 };
			}
			async getPrimaryAudioTrack() { return mocks.hasAudio ? { canDecode: async () => true } : null; }
		},
		CanvasSink: class {
			constructor(private track: { name: string }) {}
			async *canvasesAtTimestamps(times: number[]) {
				mocks.sinkTimes.push({ track: this.track.name, times });
				try { for (const _t of times) yield { canvas: { width: 640, height: 360 } }; }
				finally { mocks.iteratorsClosed.push(this.track.name); }
			}
		},
		CanvasSource: class {
			close = vi.fn();
			async add(timestamp: number, duration: number) {
				mocks.videoAdds.push([timestamp, duration]);
				mocks.onVideoAdd?.();
				if (mocks.videoFailure) throw mocks.videoFailure;
			}
		},
		AudioSampleSink: class {
			async *samples(start: number, end: number) {
				mocks.sinkTimes.push({ track: "audio", times: [start, end] });
				for (const sample of mocks.samples) yield sample;
			}
		},
		AudioSampleSource: class {
			close = vi.fn();
			async add(sample: any) {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: "f32" });
				mocks.audioAdds.push({ timestamp: sample.timestamp, duration: sample.duration, frames: sample.numberOfFrames, data: [...data] });
				if (mocks.audioFailure) throw mocks.audioFailure;
			}
		},
		BufferTarget: class { buffer = new ArrayBuffer(4); },
		Mp4OutputFormat: class {}, WebMOutputFormat: class {},
		Output: class {
			state = "pending";
			target: any;
			video: any;
			audio: any;
			constructor(options: any) { this.target = options.target; mocks.outputs.push(this); }
			addVideoTrack(source: any) { this.video = source; }
			addAudioTrack(source: any) { this.audio = source; }
			start = vi.fn(async () => { this.state = "started"; });
			finalize = vi.fn(async () => { this.state = "finalized"; });
			cancel = vi.fn(async () => { this.state = "canceled"; });
		},
	};
});
vi.mock("../../src/editor/compose", () => ({
	Compositor: class {
		reset() {}
		draw(...args: any[]) { mocks.draws.push(args); }
	},
}));
vi.mock("../../src/editor/cursor", async (importOriginal) => ({
	...await importOriginal<typeof import("../../src/editor/cursor")>(),
	preloadCursorAssets: vi.fn(async () => {}),
}));

import { AudioSample } from "mediabunny";
import { exportVideo, type ExportOptions } from "../../src/editor/export";
import { defaultSettings } from "../../src/editor/settings";

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
	return {
		container: "mp4", fps: 4, screen: new Blob(), camera: new Blob(), bgImage: null,
		scene: { videoW: 640, videoH: 360, telemetry: [], regions: [] },
		settings: defaultSettings(), durationMs: 5000, trim: { startMs: 1000, endMs: 1625 },
		...overrides,
	};
}

// Real installed Mediabunny PCM sample/trim implementation; only IO and codecs are mocked.
function pcm(timestamp: number, frames: number, sampleRate = 1000) {
	const sample = new AudioSample({
		format: "f32", sampleRate, numberOfChannels: 1, timestamp,
		data: Float32Array.from({ length: frames }, (_, i) => i),
	});
	vi.spyOn(sample, "close");
	const trim = sample.trim.bind(sample);
	vi.spyOn(sample, "trim").mockImplementation((lo, hi) => {
		const result = trim(lo, hi);
		vi.spyOn(result, "close");
		return result;
	});
	mocks.samples.push(sample);
	return sample;
}

beforeEach(() => {
	for (const key of ["inputs", "outputs", "videoAdds", "audioAdds", "sinkTimes", "draws", "samples", "iteratorsClosed"] as const) mocks[key].length = 0;
	mocks.videoCodec = "avc";
	mocks.audioCodec = "opus";
	mocks.hasAudio = mocks.hasVideo = true;
	mocks.videoFailure = mocks.audioFailure = mocks.onVideoAdd = null;
	vi.stubGlobal("OffscreenCanvas", class { getContext() { return {}; } });
});
afterEach(() => {
	for (const sample of mocks.samples) sample.close();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("composed export trim", () => {
	it("samples original media/scene times but encodes from zero with a shortened final frame", async () => {
		const o = options();
		const progress = vi.fn();
		o.onProgress = progress;
		const result = await exportVideo(o);
		expect(mocks.sinkTimes).toContainEqual({ track: "screen", times: [3, 3.25, 3.5] });
		expect(mocks.sinkTimes).toContainEqual({ track: "camera", times: [8, 8.25, 8.5] });
		expect(mocks.sinkTimes).toContainEqual({ track: "audio", times: [3, 3.625] });
		expect(mocks.draws.map((d) => d[3])).toEqual([1000, 1250, 1500]);
		expect(mocks.draws.every((d) => d[5] === o.scene)).toBe(true);
		expect(mocks.draws.map((d) => d[6])).toEqual([true, false, false]);
		expect(mocks.videoAdds).toEqual([[0, .25], [.25, .25], [.5, .125]]);
		expect(result.blob.type).toBe("video/mp4");
		expect(result.audioCodec).toBe("opus");
		expect(mocks.outputs[0].finalize).toHaveBeenCalledOnce();
		expect(mocks.outputs[0].cancel).not.toHaveBeenCalled();
		expect(mocks.inputs.every((i) => i.dispose.mock.calls.length === 1)).toBe(true);
		expect(mocks.iteratorsClosed.sort()).toEqual(["camera", "screen"]);
		expect(progress).toHaveBeenLastCalledWith(1);
	});

	it("clips boundary PCM samples, rebases without shifting gaps, and closes original and trimmed samples", async () => {
		const first = pcm(2.99, 20);
		const middle = pcm(3.01, 610);
		const last = pcm(3.62, 20);
		await exportVideo(options());
		expect(first.trim).toHaveBeenCalledWith(10, 20);
		expect(middle.trim).not.toHaveBeenCalled();
		expect(last.trim).toHaveBeenCalledWith(0, 5);
		expect(mocks.audioAdds.map((a) => a.frames)).toEqual([10, 610, 5]);
		for (const [i, timestamp] of [0, .01, .62].entries()) expect(mocks.audioAdds[i].timestamp).toBeCloseTo(timestamp);
		expect(mocks.audioAdds[0].data).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
		expect(mocks.audioAdds[2].data).toEqual([0, 1, 2, 3, 4]);
		for (const sample of [first, middle, last]) expect(sample.close).toHaveBeenCalledOnce();
		for (const sample of [first, last]) expect(vi.mocked(sample.trim).mock.results[0].value.close).toHaveBeenCalledOnce();
	});

	it("uses sample-frame precision for non-aligned audio boundaries and doesn't extend past the end", async () => {
		pcm(3, 100, 48000);
		await exportVideo(options({ trim: { startMs: 1000.01, endMs: 1001.01 } }));
		expect(mocks.audioAdds).toHaveLength(1);
		const a = mocks.audioAdds[0];
		expect(a.timestamp).toBeGreaterThanOrEqual(0);
		expect(a.timestamp).toBeLessThan(1 / 48000);
		expect(a.timestamp + a.duration).toBeLessThanOrEqual(.001 + 1e-12);
		expect(mocks.videoAdds).toHaveLength(1);
		expect(mocks.videoAdds[0][1]).toBeCloseTo(.001);
	});

	it("skips samples entirely outside the interval and preserves late audio timing", async () => {
		const before = pcm(2.9, 10);
		pcm(3.1, 10);
		const after = pcm(3.7, 10);
		await exportVideo(options());
		expect(mocks.audioAdds).toHaveLength(1);
		expect(mocks.audioAdds[0].timestamp).toBeCloseTo(.1);
		expect(before.close).toHaveBeenCalledOnce();
		expect(after.close).toHaveBeenCalledOnce();
	});

	it("avoids a spurious zero-duration frame at a floating-point exact frame boundary", async () => {
		await exportVideo(options({ fps: 30, trim: { startMs: 0, endMs: 1100 } }));
		expect(mocks.videoAdds).toHaveLength(33);
		expect(mocks.videoAdds.every(([, duration]) => duration > 0)).toBe(true);
	});

	it("retains full-length WebM export and codec fallback when trim is omitted", async () => {
		mocks.audioCodec = null;
		mocks.videoCodec = "vp9";
		const result = await exportVideo(options({ container: "webm", trim: undefined, camera: null, durationMs: 1000 }));
		expect(mocks.videoAdds).toEqual([[0, .25], [.25, .25], [.5, .25], [.75, .25]]);
		expect(mocks.draws.map((d) => d[3])).toEqual([0, 250, 500, 750]);
		expect(mocks.sinkTimes).toEqual([{ track: "screen", times: [2, 2.25, 2.5, 2.75] }]);
		expect(result).toMatchObject({ videoCodec: "vp9", audioCodec: null });
		expect(result.blob.type).toBe("video/webm");
	});

	it.each([
		{ startMs: -1, endMs: 1000 }, { startMs: 1000, endMs: 1000 },
		{ startMs: 2000, endMs: 1000 }, { startMs: 0, endMs: 5001 },
		{ startMs: NaN, endMs: 1000 }, { startMs: 0, endMs: Infinity },
	])("rejects invalid trim before opening media: %j", async (trim) => {
		await expect(exportVideo(options({ trim }))).rejects.toThrow("Invalid export");
		expect(mocks.inputs).toHaveLength(0);
	});

	it("closes PCM samples and cancels/disposes when audio encode fails", async () => {
		const first = pcm(2.99, 20);
		mocks.audioFailure = new Error("audio encoder failed");
		await expect(exportVideo(options())).rejects.toThrow("audio encoder failed");
		expect(first.close).toHaveBeenCalledOnce();
		expect(vi.mocked(first.trim).mock.results[0].value.close).toHaveBeenCalledOnce();
		expect(mocks.outputs[0].cancel).toHaveBeenCalledOnce();
		expect(mocks.outputs[0].finalize).not.toHaveBeenCalled();
		expect(mocks.inputs.every((i) => i.dispose.mock.calls.length > 0)).toBe(true);
	});

	it("cancels output and closes both frame iterators on video encode failure", async () => {
		mocks.videoFailure = new Error("video encoder failed");
		await expect(exportVideo(options())).rejects.toThrow("video encoder failed");
		expect(mocks.outputs[0].cancel).toHaveBeenCalledOnce();
		expect(mocks.outputs[0].finalize).not.toHaveBeenCalled();
		expect(mocks.iteratorsClosed.sort()).toEqual(["camera", "screen"]);
	});

	it("rejects cancellation rather than returning a successful partial export", async () => {
		const controller = new AbortController();
		mocks.onVideoAdd = () => controller.abort();
		await expect(exportVideo(options({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.outputs[0].cancel).toHaveBeenCalledOnce();
		expect(mocks.outputs[0].finalize).not.toHaveBeenCalled();
		expect(mocks.inputs.every((i) => i.dispose.mock.calls.length > 0)).toBe(true);
	});

	it("does not open inputs for a pre-aborted request and disposes malformed media", async () => {
		const controller = new AbortController(); controller.abort();
		await expect(exportVideo(options({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.inputs).toHaveLength(0);
		mocks.hasVideo = false;
		await expect(exportVideo(options())).rejects.toThrow("no video track");
		expect(mocks.inputs[0].dispose).toHaveBeenCalled();
	});
});

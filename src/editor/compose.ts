// One compositor for preview and export (what you see is what you export). Per frame it does what
// Recordly's FrameRenderer.renderFrame does: layout -> camera (SceneCamera = updateAnimationState)
// -> background + camera-transformed video layer with the cursor inside it -> webcam bubble on top.
import type { CursorTelemetryPoint, ZoomRegion } from "../vendor/recordly/types";
import { SceneCamera, type CameraTransform } from "./camera";
import { CursorLayer } from "./cursor";
import { computeFrameLayout } from "./frame";
import { renderFrame, type Ctx2D } from "./render";
import type { GlideSettings } from "./settings";
import { drawWebcamBubble } from "./webcam";

export interface SceneData {
	telemetry: CursorTelemetryPoint[];
	regions: ZoomRegion[];
	videoW: number;
	videoH: number;
}

export interface FrameSources {
	screen: CanvasImageSource | null;
	cam: CanvasImageSource | null;
	camW: number;
	camH: number;
	bgImage: CanvasImageSource | null;
}

export class Compositor {
	readonly camera: SceneCamera;
	readonly cursor: CursorLayer;
	lastCamera: CameraTransform = { scale: 1, x: 0, y: 0, progress: 0, zoomScale: 1 };

	constructor(private settings: GlideSettings) {
		this.camera = new SceneCamera(settings.zoom);
		this.cursor = new CursorLayer(settings.cursor);
	}

	setSettings(s: GlideSettings): void {
		this.settings = s;
		this.camera.setConfig(s.zoom);
		this.cursor.setConfig(s.cursor);
	}

	/** Seek / export frame 0: springs and the smoothed cursor start over. */
	reset(): void {
		this.camera.reset();
		this.cursor.reset();
	}

	draw(ctx: Ctx2D, W: number, H: number, timeMs: number, src: FrameSources, scene: SceneData, snap = false): CameraTransform {
		const s = this.settings;
		const vw = scene.videoW || 16;
		const vh = scene.videoH || 9;
		const { mask } = computeFrameLayout(W, H, vw, vh, s.frame);
		const camera = this.camera.step(timeMs, { width: W, height: H }, mask, scene.telemetry, scene.regions, snap);
		this.lastCamera = camera;
		renderFrame(ctx, W, H, {
			screen: src.screen,
			videoW: scene.videoW,
			videoH: scene.videoH,
			bgImage: s.frame.background.kind === "image" ? src.bgImage : null,
			style: s.frame,
			camera,
			drawCursor: s.cursor.show && scene.telemetry.length ? (c, vp) => this.cursor.draw(c, scene.telemetry, timeMs, vp) : undefined,
			drawWebcam: src.cam && s.webcam.enabled ? (c, w, h, z) => drawWebcamBubble(c, w, h, src.cam, src.camW, src.camH, s.webcam, z) : undefined,
		});
		return camera;
	}
}

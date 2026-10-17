// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/lib/exporter/frameRenderer.ts (FrameRenderer.setupBackground, ≈L555–667, and
//   configureHighQuality2DContext ≈L207)
// Changes: lifted out of the class into free functions; the image is loaded by the caller and passed in
//   (Recordly awaited `new Image()` inside setupBackground); `this.config.width/height` -> width/height
//   params; context type widened to OffscreenCanvasRenderingContext2D; video wallpapers and the
//   file:// / asset-path resolution (Electron) removed; the `try { … } catch` black fallback is kept, and a
//   missing image (still loading or failed) takes the same black fallback.

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function configureHighQuality2DContext<T extends Ctx2D | null>(context: T): T {
	if (!context) {
		return context;
	}

	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";

	return context;
}

export function isImageWallpaper(wallpaper: string): boolean {
	return (
		wallpaper.startsWith("file://") ||
		wallpaper.startsWith("data:") ||
		wallpaper.startsWith("blob:") ||
		wallpaper.startsWith("/") ||
		wallpaper.startsWith("http") ||
		wallpaper.startsWith("chrome-extension:") ||
		/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(wallpaper)
	);
}

/** Paints the static (zoom-independent) background exactly like Recordly's setupBackground. */
export function paintWallpaper(
	bgCtx: Ctx2D,
	width: number,
	height: number,
	wallpaper: string,
	img: { width: number; height: number; source: CanvasImageSource } | null,
): void {
	try {
		// Render background based on type
		if (isImageWallpaper(wallpaper)) {
			if (!img || !img.width || !img.height) {
				throw new Error(`Background image not loaded: ${wallpaper}`);
			}
			// Draw the image using cover and center positioning
			const imgAspect = img.width / img.height;
			const canvasAspect = width / height;

			let drawWidth, drawHeight, drawX, drawY;

			if (imgAspect > canvasAspect) {
				drawHeight = height;
				drawWidth = drawHeight * imgAspect;
				drawX = (width - drawWidth) / 2;
				drawY = 0;
			} else {
				drawWidth = width;
				drawHeight = drawWidth / imgAspect;
				drawX = 0;
				drawY = (height - drawHeight) / 2;
			}

			bgCtx.drawImage(img.source, drawX, drawY, drawWidth, drawHeight);
		} else if (wallpaper.startsWith("#")) {
			bgCtx.fillStyle = wallpaper;
			bgCtx.fillRect(0, 0, width, height);
		} else if (
			wallpaper.startsWith("linear-gradient") ||
			wallpaper.startsWith("radial-gradient")
		) {
			const gradientMatch = wallpaper.match(/(linear|radial)-gradient\((.+)\)/);
			if (gradientMatch) {
				const [, type, params] = gradientMatch;
				const parts = params.split(",").map((s) => s.trim());

				let gradient: CanvasGradient;

				if (type === "linear") {
					gradient = bgCtx.createLinearGradient(0, 0, 0, height);
					parts.forEach((part, index) => {
						if (part.startsWith("to ") || part.includes("deg")) return;

						const colorMatch = part.match(
							/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-z]+)/,
						);
						if (colorMatch) {
							const color = colorMatch[1];
							const position = index / (parts.length - 1);
							gradient.addColorStop(position, color);
						}
					});
				} else {
					const cx = width / 2;
					const cy = height / 2;
					const radius = Math.max(width, height) / 2;
					gradient = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);

					parts.forEach((part, index) => {
						const colorMatch = part.match(
							/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-z]+)/,
						);
						if (colorMatch) {
							const color = colorMatch[1];
							const position = index / (parts.length - 1);
							gradient.addColorStop(position, color);
						}
					});
				}

				bgCtx.fillStyle = gradient;
				bgCtx.fillRect(0, 0, width, height);
			} else {
				console.warn("[FrameRenderer] Could not parse gradient, using black fallback");
				bgCtx.fillStyle = "#000000";
				bgCtx.fillRect(0, 0, width, height);
			}
		} else {
			bgCtx.fillStyle = wallpaper;
			bgCtx.fillRect(0, 0, width, height);
		}
	} catch (error) {
		console.error("[FrameRenderer] Error setting up background, using fallback:", error);
		bgCtx.fillStyle = "#000000";
		bgCtx.fillRect(0, 0, width, height);
	}
}

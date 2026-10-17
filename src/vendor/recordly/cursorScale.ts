// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/cursorScale.ts
// Changes: none

export const CURSOR_REFERENCE_VIEWPORT_WIDTH = 1920;

export function getCursorViewportScale(viewportWidth: number, minimumScale = 0): number {
	return Math.max(minimumScale, Math.max(0, viewportWidth) / CURSOR_REFERENCE_VIEWPORT_WIDTH);
}

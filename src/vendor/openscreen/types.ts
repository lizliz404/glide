// Subset of siddharthvaddem/openscreen (MIT) @ ca8104c src/components/video-editor/types.ts
// Only the two interfaces used by cursorFollowUtils.ts are copied.

export interface ZoomFocus {
	cx: number; // normalized horizontal center (0-1)
	cy: number; // normalized vertical center (0-1)
}

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: "move" | "click" | "double-click" | "right-click" | "middle-click" | "mouseup";
}

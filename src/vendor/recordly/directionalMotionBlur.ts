// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/zoomTransform.ts (L6-8, L14-19, L257-282, L355-357)
// Changes: extracted only the pure computeDirectionalMotionBlur + its constants/helpers (resolveFpsScale, createZeroPoint, DirectionalMotionBlur); Point2D inlined as {x,y}; Pixi camera/filter code not copied

const MIN_DIRECTIONAL_BLUR_MAGNITUDE = 0.01;
const DIRECTIONAL_BLUR_KERNEL_SIZE = 13;
const DIRECTIONAL_BLUR_OFFSET_DIVISOR = 32;

export interface DirectionalMotionBlur {
	velocity: { x: number; y: number };
	magnitude: number;
	kernelSize: number;
	offset: number;
}

function resolveFpsScale(deltaSeconds: number) {
	const fps = 1 / Math.max(1 / 240, deltaSeconds);
	return fps / 60;
}

export function computeDirectionalMotionBlur(
	delta: { x: number; y: number },
	motionBlurAmount: number,
	deltaSeconds: number,
	strengthMultiplier = 1,
): DirectionalMotionBlur {
	const scale = motionBlurAmount * resolveFpsScale(deltaSeconds) * strengthMultiplier;
	const velocity = {
		x: delta.x * scale,
		y: delta.y * scale,
	};
	const magnitude = Math.hypot(velocity.x, velocity.y);
	const isActive = magnitude >= MIN_DIRECTIONAL_BLUR_MAGNITUDE;

	return {
		velocity: isActive ? velocity : createZeroPoint(),
		magnitude: isActive ? magnitude : 0,
		kernelSize: DIRECTIONAL_BLUR_KERNEL_SIZE,
		offset: isActive ? -magnitude / DIRECTIONAL_BLUR_OFFSET_DIVISOR : 0,
	};
}

function createZeroPoint(): { x: number; y: number } {
	return { x: 0, y: 0 };
}

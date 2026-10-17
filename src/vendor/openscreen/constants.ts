// Subset of siddharthvaddem/openscreen (MIT) @ ca8104c src/components/video-editor/videoPlayback/constants.ts
// Only the auto-follow tuning (shared by preview and export) is copied, values unchanged.

export const AUTO_FOLLOW_SMOOTHING_FACTOR = 0.1;
export const AUTO_FOLLOW_SMOOTHING_FACTOR_MAX = 0.25;
export const AUTO_FOLLOW_RAMP_DISTANCE = 0.15;
export const AUTO_FOLLOW_REFERENCE_MS = 1000 / 40;
export const AUTO_FOLLOW_PARAMS = {
	minFactor: AUTO_FOLLOW_SMOOTHING_FACTOR,
	maxFactor: AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
	rampDistance: AUTO_FOLLOW_RAMP_DISTANCE,
	referenceMs: AUTO_FOLLOW_REFERENCE_MS,
} as const;

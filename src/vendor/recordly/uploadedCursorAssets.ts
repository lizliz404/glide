// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/uploadedCursorAssets.ts
// Changes: Vite SVG asset imports -> runtime URL constants ("cursors/<set>/<file>.svg", relative to
//   editor.html; the files are copied to static/cursors/); import path ../types -> ./types

const macosClosedHandUrl = "cursors/macos/closedhand-1__50-50.svg";
const macosCrosshairUrl = "cursors/macos/crosshair-1__50-50.svg";
const macosTextUrl = "cursors/macos/ibeamstroke-1__50-50.svg";
const macosNotAllowedUrl = "cursors/macos/notallowed-1__23-0.svg";
const macosOpenHandUrl = "cursors/macos/openhand-1__50-50.svg";
const macosArrowUrl = "cursors/macos/pointer-1__34-24.svg";
const macosPointerUrl = "cursors/macos/pointinghand-1__39-26.svg";
const macosResizeEwUrl = "cursors/macos/resizeeastwest-1__50-50.svg";
const macosResizeNsUrl = "cursors/macos/resizenorthsouth-1__50-50.svg";
const tahoeClosedHandUrl = "cursors/golden-gate/closedhand.svg";
const tahoeCrosshairUrl = "cursors/tahoe/crosshair-1__50-50.svg";
const tahoeTextUrl = "cursors/tahoe/ibeam-1__50-44.svg";
const tahoeNotAllowedUrl = "cursors/tahoe/notallowed-1__23-0.svg";
const tahoeOpenHandUrl = "cursors/golden-gate/openhand.svg";
const tahoeArrowUrl = "cursors/tahoe/pointer-1__14-6.svg";
const tahoePointerUrl = "cursors/golden-gate/pointinghand.svg";
const tahoeResizeEwUrl = "cursors/tahoe/resizeeastwest-1__50-50.svg";
const tahoeResizeNsUrl = "cursors/tahoe/resizenorthsouth-1__50-49.svg";
const windows11ArrowUrl = "cursors/windows11/arrow__31-22.svg";
const windows11NotAllowedUrl = "cursors/windows11/block__50-50.svg";
const windows11CrosshairUrl = "cursors/windows11/cross__50-50.svg";
const windows11OpenHandUrl = "cursors/windows11/grab__50-50.svg";
const windows11ClosedHandUrl = "cursors/windows11/grabbing__50-50.svg";
const windows11PointerUrl = "cursors/windows11/pointer__54-35.svg";
const windows11ResizeEwUrl = "cursors/windows11/resize-horizontal__51-49.svg";
const windows11ResizeNsUrl = "cursors/windows11/resize-vertical__48-50.svg";
const windows11TextUrl = "cursors/windows11/text__50-50.svg";
import type { CursorStyle, CursorTelemetryPoint } from "./types";

type CursorAssetKey = NonNullable<CursorTelemetryPoint["cursorType"]>;
type CursorSetStyle = Extract<CursorStyle, "macos" | "tahoe" | "tahoe-inverted" | "windows11">;

const MACOS_POINTER_ASSET_HEIGHT = 746;
const MACOS_POINTER_CONTENT_HEIGHT = 386;
const TAHOE_POINTER_ASSET_HEIGHT = 958;
const TAHOE_POINTER_CONTENT_HEIGHT = 851;
const WINDOWS11_CURSOR_VIEWBOX_HEIGHT = 32;
// Alpha bounds measured after correcting the bottom-up Windows system SVG coordinates.
const WINDOWS11_ARROW_CONTENT_HEIGHT = 19.0625;

// Measured from the raw pointer assets using the non-shadow pixel bounds.
const MACOS_CURSOR_STYLE_SIZE_MULTIPLIER =
	TAHOE_POINTER_CONTENT_HEIGHT /
	TAHOE_POINTER_ASSET_HEIGHT /
	(MACOS_POINTER_CONTENT_HEIGHT / MACOS_POINTER_ASSET_HEIGHT);

export type UploadedCursorAsset = {
	url: string;
	fallbackAnchor: {
		x: number;
		y: number;
	};
	preserveCanvas?: boolean;
};

function asset(
	url: string,
	hotspotX: number,
	hotspotY: number,
	options: Pick<UploadedCursorAsset, "preserveCanvas"> = {},
): UploadedCursorAsset {
	return {
		url,
		fallbackAnchor: {
			x: hotspotX / 100,
			y: hotspotY / 100,
		},
		...options,
	};
}

function windowsSystemAsset(url: string, hotspotX: number, hotspotY: number) {
	return asset(
		url,
		(hotspotX / WINDOWS11_CURSOR_VIEWBOX_HEIGHT) * 100,
		(hotspotY / WINDOWS11_CURSOR_VIEWBOX_HEIGHT) * 100,
		{ preserveCanvas: true },
	);
}

export const cursorSetAssets: Record<
	Exclude<CursorSetStyle, "tahoe-inverted">,
	Record<CursorAssetKey, UploadedCursorAsset>
> = {
	macos: {
		arrow: asset(macosArrowUrl, 34, 24),
		text: asset(macosTextUrl, 50, 50),
		pointer: asset(macosPointerUrl, 39, 26),
		crosshair: asset(macosCrosshairUrl, 50, 50),
		"open-hand": asset(macosOpenHandUrl, 50, 50),
		"closed-hand": asset(macosClosedHandUrl, 50, 50),
		"resize-ew": asset(macosResizeEwUrl, 50, 50),
		"resize-ns": asset(macosResizeNsUrl, 50, 50),
		"not-allowed": asset(macosNotAllowedUrl, 23, 0),
	},
	// Keep the legacy style ID so saved projects use the updated Golden Gate pack.
	tahoe: {
		arrow: asset(tahoeArrowUrl, 14, 6),
		text: asset(tahoeTextUrl, 50, 44),
		pointer: asset(tahoePointerUrl, 37.5, 25),
		crosshair: asset(tahoeCrosshairUrl, 50, 50),
		"open-hand": asset(tahoeOpenHandUrl, 46.875, 50),
		"closed-hand": asset(tahoeClosedHandUrl, 46.875, 50),
		"resize-ew": asset(tahoeResizeEwUrl, 50, 50),
		"resize-ns": asset(tahoeResizeNsUrl, 50, 49),
		"not-allowed": asset(tahoeNotAllowedUrl, 23, 0),
	},
	windows11: {
		// Hotspots are from the 32px frames embedded in the matching Windows .cur files.
		arrow: windowsSystemAsset(windows11ArrowUrl, 0, 0),
		text: windowsSystemAsset(windows11TextUrl, 16, 16),
		pointer: windowsSystemAsset(windows11PointerUrl, 6, 0),
		crosshair: windowsSystemAsset(windows11CrosshairUrl, 16, 16),
		"open-hand": windowsSystemAsset(windows11OpenHandUrl, 16, 16),
		"closed-hand": windowsSystemAsset(windows11ClosedHandUrl, 16, 16),
		"resize-ew": windowsSystemAsset(windows11ResizeEwUrl, 11, 4),
		"resize-ns": windowsSystemAsset(windows11ResizeNsUrl, 4, 11),
		"not-allowed": windowsSystemAsset(windows11NotAllowedUrl, 8, 8),
	},
};

export const cursorStyleSizeMultipliers: Record<CursorSetStyle, number> = {
	macos: MACOS_CURSOR_STYLE_SIZE_MULTIPLIER,
	tahoe: 1,
	"tahoe-inverted": 1,
	windows11: WINDOWS11_CURSOR_VIEWBOX_HEIGHT / WINDOWS11_ARROW_CONTENT_HEIGHT,
};

export function getCursorStyleSizeMultiplier(style: CursorStyle) {
	return style in cursorStyleSizeMultipliers
		? cursorStyleSizeMultipliers[style as CursorSetStyle]
		: 1;
}

export const uploadedCursorAssets = cursorSetAssets.tahoe;

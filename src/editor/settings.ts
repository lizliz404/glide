export type Aspect = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
export type Corner = "br" | "bl" | "tr" | "tl";

export interface Settings {
	aspect: Aspect;
	background: { kind: "gradient"; stops: string[] } | { kind: "color"; color: string } | { kind: "image"; url: string };
	/** Padding around the display, as a fraction of the shorter output side. */
	padding: number;
	/** Corner radius in px at 1080p, scaled with output size. */
	radius: number;
	/** 0..1 drop shadow strength. */
	shadow: number;
	zoom: {
		enabled: boolean;
		scale: number;
		follow: boolean;
		/** Clicks needed inside `gapMs` to trigger a zoom (Cursorful uses 2 to reduce motion). */
		minClicks: number;
		gapMs: number;
		leadMs: number;
		holdMs: number;
	};
	cursor: { draw: boolean; size: number; smoothing: number; ripple: boolean };
	webcam: { show: boolean; size: number; corner: Corner; mirror: boolean; shape: "circle" | "rounded" };
}

export const GRADIENTS: Record<string, string[]> = {
	Dusk: ["#1e3a8a", "#7c3aed", "#f472b6"],
	Sky: ["#0ea5e9", "#6366f1"],
	Mint: ["#064e3b", "#10b981", "#a7f3d0"],
	Sunset: ["#f97316", "#db2777", "#7c3aed"],
	Graphite: ["#0b0f19", "#1f2937", "#374151"],
	Paper: ["#fafaf9", "#e7e5e4"],
};

export const defaultSettings = (): Settings => ({
	aspect: "16:9",
	background: { kind: "gradient", stops: GRADIENTS.Dusk },
	padding: 0.07,
	radius: 18,
	shadow: 0.6,
	zoom: { enabled: true, scale: 1.8, follow: true, minClicks: 1, gapMs: 3000, leadMs: 300, holdMs: 1600 },
	cursor: { draw: true, size: 1, smoothing: 0.5, ripple: true },
	webcam: { show: true, size: 0.24, corner: "br", mirror: true, shape: "circle" },
});

export function outputSize(aspect: Aspect, base = 1080): { width: number; height: number } {
	const [w, h] = aspect.split(":").map(Number);
	// Short side = base; keep dimensions even for H.264.
	const even = (n: number) => Math.round(n / 2) * 2;
	return w >= h ? { width: even((base * w) / h), height: base } : { width: base, height: even((base * h) / w) };
}

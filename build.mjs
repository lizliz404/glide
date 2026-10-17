import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("static", "dist", { recursive: true });

const opts = {
	entryPoints: {
		background: "src/background.ts",
		content: "src/content.ts",
		recorder: "src/recorder.ts",
		popup: "src/popup.ts",
		setup: "src/setup.ts",
		editor: "src/editor/main.ts",
	},
	bundle: true,
	format: "esm",
	target: "chrome116",
	outdir: "dist",
	sourcemap: true,
	minify: !watch,
	legalComments: "linked",
	logLevel: "info",
};
// content.js runs as a classic content script: bundle it as an IIFE.
const contentOpts = { ...opts, entryPoints: { content: "src/content.ts" }, format: "iife" };
delete opts.entryPoints.content;

if (watch) {
	await (await context(opts)).watch();
	await (await context(contentOpts)).watch();
} else {
	await build(opts);
	await build(contentOpts);
}

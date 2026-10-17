# Vendored from OpenScreen

- Upstream: https://github.com/siddharthvaddem/openscreen
- Commit: `ca8104c279da0d4b4481ec992ff103949e22c772` (pushed 2026-10-17)
- License: MIT (see `LICENSE` in this folder, kept verbatim)

| File | Upstream path | Changes |
| --- | --- | --- |
| `mathUtils.ts` | `src/components/video-editor/videoPlayback/mathUtils.ts` | header only |
| `motionSmoothing.ts` | `.../videoPlayback/motionSmoothing.ts` | header only (uses `motion`'s `spring`, MIT) |
| `zoomSpring.ts` | `.../videoPlayback/zoomSpring.ts` | header only |
| `cursorFollowUtils.ts` | `.../videoPlayback/cursorFollowUtils.ts` | header, `../types` → `./types` |
| `types.ts` | `src/components/video-editor/types.ts` | two interfaces only |
| `constants.ts` | `.../videoPlayback/constants.ts` | auto-follow constants only |

Why vendor instead of depend: OpenScreen is an Electron app, not a library. These files are
pure TypeScript math (no Electron / Pixi), so they drop into a browser extension unchanged.
Update by re-copying from a newer commit and bumping the hash above.

# Third-party notices

Glide is licensed under the GNU AGPL-3.0 (see `LICENSE`) because most of its editor is ported from Recordly.

| Component | How it is used | License |
| --- | --- | --- |
| [Recordly](https://github.com/webadderallorg/Recordly) @ `e4a9d04860f4cbad3358bda3ac4a2307489f1d03`, © 2026 webadderall | Source copied into `src/vendor/recordly/`. Each file has a header with its upstream path and the changes made; the full list is in `src/vendor/recordly/README.md`. Glide's `src/editor/*` wires these files together, following Recordly's `frameRenderer.ts`, `projectPersistence.ts` and `SettingsPanel.tsx`. Assets copied: `static/wallpapers/*` (all 38 image files from `public/wallpapers/`, byte-exact, listed under *Wallpaper provenance* below) and `static/cursors/**`. | AGPL-3.0 plus Recordly's extra terms, kept verbatim in `src/vendor/recordly/LICENSE.md`. In short: attribute Recordly in the user-facing UI and in the repo (Glide's editor footer reads "Based on Recordly (AGPL-3.0)"), and don't use the "Recordly" name or branding for your own project. **The AGPL-3.0 covers Recordly's code, not the images it bundles** (see *Wallpaper provenance*). |
| [OpenScreen](https://github.com/siddharthvaddem/openscreen), © 2025 Siddharth Vaddem | Recordly started as a fork of OpenScreen, so parts of the Recordly code above derive from it. Glide's earlier direct vendoring of OpenScreen (`src/vendor/openscreen/`, @ `ca8104c`) has been removed. | MIT (reproduced in Part 2 of `src/vendor/recordly/LICENSE.md`) |
| [Geist Sans](https://github.com/vercel/geist-font) @ `10dc7658f13c38a474cde201bb09a4617267545b`, © 2024 The Geist Project Authors | UI face for Glide's editor, popup and pages. Vendored unmodified as `static/fonts/Geist-Variable.woff2` (variable woff2, weights 100–900) and loaded by `static/ui.css` through `@font-face`. Self-hosted so the extension works offline; no CDN and no npm dependency. | SIL OFL 1.1, full text in `static/fonts/OFL.txt`. Upstream path, sha256 and the pinned commit's git blob SHA-1 for each file: `static/fonts/sources.json`. |
| [Geist Mono](https://github.com/vercel/geist-font) @ `10dc7658f13c38a474cde201bb09a4617267545b`, © 2024 The Geist Project Authors | Numeric and measurement face: slider values, the timecode, trim range and timeline ruler. Vendored unmodified as `static/fonts/GeistMono-Variable.woff2` (variable woff2, weights 100–900). | SIL OFL 1.1, as above. |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6 | npm dependency bundled into `editor.js` for WebM demux, WebCodecs encode, and MP4/WebM mux. Unmodified. | MPL-2.0 |

## Wallpaper provenance

Glide ships **every image wallpaper Recordly bundles** (`public/wallpapers/` @ `e4a9d04`), copied byte-exact into `static/wallpapers/`, because that is the product decision recorded in `docs/QA.md` (P1-13: Recordly's backgrounds only, none of our own). Recordly ships its wallpaper files without a stated licence or source, and **Recordly's AGPL-3.0 covers its code, not these images** — they are third-party artwork redistributed as-is.

The 38 shipped files, in the order Glide's picker shows them:

- Recordly's own picker list (24): `tahoe-light.jpg`, `tahoe-dark.jpg`, `midnight-8.jpg`, `ipad-17-dark.jpg`, `ipad-17-light.jpg`, `sequoia-blue.jpg`, `sequoia-blue-orange.jpg`, `ventura.jpg`, `sonoma-clouds.jpg`, `sonoma-light.jpg`, `sonoma-dark.jpg`, `glassmorphism-3.jpg`, `glassmorphism-4.jpg`, `energy-19.jpg`, `wallpaper3.jpg`, `wallpaper4.jpg`, `cityscape.jpg`, `levels.jpg`, `wallpaper10.jpg`, `ventura-dark.jpg`, `sonoma-evening.jpg`, `sonoma-horizon.jpg`, `iridescent-9.jpg`, `energy-17.jpg`.
- Files present in that folder without a picker entry, shown after them (14): `bluerays.jpeg`, `cherrypop.jpg`, `farmvalley.jpg`, `lemonade.jpeg`, `luisdelrio.jpg`, `mountaintrees.jpg`, `wallpaper1.jpg`, `wallpaper2.jpg`, `wallpaper7.jpg`, `wallpaper9.jpg`, `wallpaper11.jpg`, `wallpaper12.jpg`, `wallpaper13.jpg`, `wallpaper15.jpg`.

Not shipped: `wispysky.mp4`, Recordly's one video wallpaper. Glide's renderer (`src/vendor/recordly/wallpaperFill.ts`) draws images, colours and gradients only, and a video source would paint black. Adding it needs a video-background path in the renderer — follow-up, tracked in `docs/QA.md` P1-13.

Why this is a risk: filenames such as `tahoe-*`, `sequoia-*`, `sonoma-*`, `ventura*`, `ipad-17-*`, `midnight-8`, `iridescent-9`, `energy-17/19`, `glassmorphism-*` and `levels` match Apple release wallpaper names, so they appear to be Apple artwork; `bluerays`, `cherrypop`, `farmvalley`, `lemonade`, `luisdelrio`, `mountaintrees` and `wallpaper1–15` have no stated origin at all. The Glide repository is public, so shipping these files is a copyright risk. Replace them with CC0 or self-made assets, or make the repository private.

Cursor images in `static/cursors/` carry the same problem and the same caveat: `tahoe/`, `golden-gate/` and `macos/` are converted macOS system cursors (Apple artwork) and `windows11/` resembles Microsoft's cursors. Before the wallpaper expansion only five wallpapers were shipped; the caveat applied then too and applies now to all 38.

The built bundle keeps upstream license comments in `dist/*.LEGAL.txt` (esbuild `legalComments: "linked"`). Vendored font files travel with the built extension (`dist/fonts/**`, including `OFL.txt` and `sources.json`), as the OFL requires.

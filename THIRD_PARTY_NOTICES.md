# Third-party notices

Glide is licensed under the GNU AGPL-3.0 (see `LICENSE`) because most of its editor is ported from Recordly.

| Component | How it is used | License |
| --- | --- | --- |
| [Recordly](https://github.com/webadderallorg/Recordly) @ `e4a9d04860f4cbad3358bda3ac4a2307489f1d03`, © 2026 webadderall | Source copied into `src/vendor/recordly/`. Each file has a header with its upstream path and the changes made; the full list is in `src/vendor/recordly/README.md`. Glide's `src/editor/*` wires these files together, following Recordly's `frameRenderer.ts`, `projectPersistence.ts` and `SettingsPanel.tsx`. Assets copied: `static/wallpapers/*` (5 files) and `static/cursors/**`. | AGPL-3.0 plus Recordly's extra terms, kept verbatim in `src/vendor/recordly/LICENSE.md`. In short: attribute Recordly in the user-facing UI and in the repo (Glide's editor footer reads "Based on Recordly (AGPL-3.0)"), and don't use the "Recordly" name or branding for your own project. |
| [OpenScreen](https://github.com/siddharthvaddem/openscreen), © 2025 Siddharth Vaddem | Recordly started as a fork of OpenScreen, so parts of the Recordly code above derive from it. Glide's earlier direct vendoring of OpenScreen (`src/vendor/openscreen/`, @ `ca8104c`) has been removed. | MIT (reproduced in Part 2 of `src/vendor/recordly/LICENSE.md`) |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6 | npm dependency bundled into `editor.js` for WebM demux, WebCodecs encode, and MP4/WebM mux. Unmodified. | MPL-2.0 |

## Asset provenance caveat

Recordly ships its wallpapers and cursor images without a stated license or source. Glide copies them only because Recordly does:

- `static/wallpapers/tahoe-*.jpg`, `sequoia-blue-orange.jpg` and `ventura.jpg` appear to be Apple macOS wallpapers. `glassmorphism-4.jpg` has no stated origin.
- `static/cursors/tahoe/`, `golden-gate/` and `macos/` are converted macOS system cursors, which makes them Apple artwork. `windows11/` resembles Microsoft's cursors.

The Glide repository is public, so shipping these files is a copyright risk. Replace them with CC0 or self-made assets, or make the repository private.

The built bundle keeps upstream license comments in `dist/*.LEGAL.txt` (esbuild `legalComments: "linked"`).

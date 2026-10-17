# Third-party notices

| Component | How it is used | License |
| --- | --- | --- |
| [OpenScreen](https://github.com/siddharthvaddem/openscreen) @ `ca8104c` | Vendored source in `src/vendor/openscreen/` (zoom spring, cursor follow, easing). | MIT — `src/vendor/openscreen/LICENSE` |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6 | npm dependency, bundled into `editor.js` for WebM demux, WebCodecs encode, MP4/WebM mux. Unmodified. | MPL-2.0 (file-level copyleft; unmodified use inside an MIT project is fine; source at the link above) |
| [Motion](https://github.com/motiondivision/motion) 14.3.0 | npm dependency, only the `spring` generator (used by OpenScreen's `motionSmoothing.ts`). | MIT |

The built bundle keeps upstream license comments in `dist/*.LEGAL.txt` (esbuild `legalComments: "linked"`).

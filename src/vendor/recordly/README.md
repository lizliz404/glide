# Vendored from Recordly

- Upstream: https://github.com/webadderallorg/Recordly
- Commit: `e4a9d04860f4cbad3358bda3ac4a2307489f1d03`
- License: AGPL-3.0 with Recordly's attribution terms (see `LICENSE.md`, kept verbatim).
  Recordly itself started as a fork of OpenScreen (MIT, Siddharth Vaddem).

Every file starts with a header naming its upstream path and the changes made.
Packages P1–P4 add more files here; list them in the table below.

| File | Upstream path | Owner package |
| --- | --- | --- |
| types.ts, mathUtils.ts, motionSmoothing.ts, cursorPosition.ts, constants.ts, focusUtils.ts, cursorMotionPresets.ts, squircle.ts | see headers | P0 (shared) |
| webcamOverlay.ts | src/components/video-editor/webcamOverlay.ts | P3 |
| shadowProfile.ts | src/lib/exporter/shadowProfile.ts | P3 (byte-identical if P2 also copies it) |

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
| cursorCanvas.ts | src/components/video-editor/videoPlayback/cursorRenderer.ts (Pixi removed; PixiCursorOverlay → CanvasCursorOverlay; ImageBitmap asset loading) | P4 |
| cursorScale.ts, cursorViewport.ts, cursorSway.ts, frameMotionSample.ts, uploadedCursorAssets.ts | src/components/video-editor/videoPlayback/ (same names) | P4 |
| directionalMotionBlur.ts | src/components/video-editor/videoPlayback/zoomTransform.ts (pure computeDirectionalMotionBlur only) | P4 |
| ../../../static/cursors/** | src/assets/cursors/{tahoe,golden-gate}/ (full), macos/ + windows11/ (the 9 files each that uploadedCursorAssets.ts references), custom/minimal-cursor.svg | P4 |

import { describe, expect, it } from "vitest";
import { WEBCAM_DEFAULTS, WEBCAM_SIZE_PERCENT, computeWebcamBubbleLayout, drawWebcamBubble } from "../../src/editor/webcam";

describe("glide webcam bubble", () => {
  it("uses Recordly defaults", () => {
    expect(WEBCAM_SIZE_PERCENT).toBe(40);
    expect(WEBCAM_DEFAULTS).toMatchObject({ sizePercent: 40, roundness: 100, shadow: 0.3, margin: 24,
      positionPreset: "bottom-right", positionX: 1, positionY: 1, mirror: true, reactToZoom: true });
  });
  it("is 432px bottom-right with 24px margin at 1920x1080, zoom 1", () => {
    const l = computeWebcamBubbleLayout(1920, 1080, 1280, 720, WEBCAM_DEFAULTS, 1);
    expect(l.width).toBeCloseTo(432); expect(l.height).toBeCloseTo(432);
    expect(l.x + l.width).toBeCloseTo(1920 - 24); expect(l.y + l.height).toBeCloseTo(1080 - 24);
    expect(l.radius).toBeCloseTo(216);
  });
  it("shrinks by 1/zoom when reactToZoom", () => {
    const l = computeWebcamBubbleLayout(1920, 1080, 1280, 720, WEBCAM_DEFAULTS, 1.8);
    expect(l.width).toBeCloseTo(432 / 1.8);
    const fixed = computeWebcamBubbleLayout(1920, 1080, 1280, 720, { ...WEBCAM_DEFAULTS, reactToZoom: false }, 1.8);
    expect(fixed.width).toBeCloseTo(432);
  });
  it("no-ops without a frame or when disabled", () => {
    const ctx = { drawImage: () => { throw new Error("drew"); } } as unknown as CanvasRenderingContext2D;
    expect(() => drawWebcamBubble(ctx, 1920, 1080, null, 1, 1, WEBCAM_DEFAULTS, 1)).not.toThrow();
    expect(() => drawWebcamBubble(ctx, 1920, 1080, {} as CanvasImageSource, 1, 1, { ...WEBCAM_DEFAULTS, enabled: false }, 1)).not.toThrow();
  });
});

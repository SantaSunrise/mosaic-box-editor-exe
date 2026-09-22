import assert from "node:assert/strict";
import test from "node:test";
import { fitSize, zoomAt, constrainView } from "../src/viewport.ts";

const stage = { width: 800, height: 450 };
const image = fitSize(stage, 16 / 9);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test("wheel zoom preserves the normalized image point under the cursor", () => {
  const pointer = { x: 150, y: -80 };
  let view = { zoom: 1, x: 0, y: 0 };
  const normalized = (v) => [
    (pointer.x - v.x) / (image.width * v.zoom) + 0.5,
    (pointer.y - v.y) / (image.height * v.zoom) + 0.5,
  ];
  const before = normalized(view);
  view = zoomAt(view, 2, pointer, image, stage);
  normalized(view).forEach((v, i) => close(v, before[i]));
  view = zoomAt(view, 3.5, pointer, image, stage);
  normalized(view).forEach((v, i) => close(v, before[i]));
  view = zoomAt(view, 1.5, pointer, image, stage);
  normalized(view).forEach((v, i) => close(v, before[i]));
});
test("zoom bounds and fit reset remain stable", () => {
  const enlarged = zoomAt(
    { zoom: 2, x: 120, y: 80 },
    99,
    { x: 0, y: 0 },
    image,
    stage,
  );
  assert.equal(enlarged.zoom, 8);
  const reset = zoomAt(enlarged, 0.2, { x: 100, y: -90 }, image, stage);
  assert.equal(reset.zoom, 1);
  close(reset.x, 0);
  close(reset.y, 0);
});
test("portrait and ultrawide images fit without stretching; pan stops at edges", () => {
  for (const aspect of [9 / 16, 16 / 9, 32 / 9]) {
    const fit = fitSize(stage, aspect);
    assert.ok(fit.width <= stage.width && fit.height <= stage.height);
    close(fit.width / fit.height, aspect);
    const view = constrainView({ zoom: 2, x: 9999, y: -9999 }, fit, stage);
    close(view.x, Math.max(0, (fit.width * 2 - stage.width) / 2));
    close(view.y, -Math.max(0, (fit.height * 2 - stage.height) / 2));
  }
});

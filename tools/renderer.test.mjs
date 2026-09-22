import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer } from "../src/renderer.ts";

test("reuses unchanged geometry and invalidates after clearing, drawing and resizing", (t) => {
  const paths = [];
  const surface = () => ({
    width: 300,
    height: 150,
    getContext: () => ({
      beginPath() {},
      clearRect() {},
      fill() {},
      stroke() {},
      save() {},
      restore() {},
      drawImage() {},
      fillRect() {},
      rect(...coords) {
        paths.push(coords);
      },
    }),
  });
  const original = globalThis.document;
  globalThis.document = { createElement: surface };
  t.after(() => {
    if (original) globalThis.document = original;
    else delete globalThis.document;
  });
  const draw = createRenderer(surface(), {});
  const rect = {
    tool: "rect",
    mode: "add",
    points: [
      [0.1, 0.1],
      [0.4, 0.4],
    ],
  };
  const operations = [rect];
  const options = {
    fitted: { width: 800, height: 450 },
    operations,
    draft: null,
    previewMode: "region",
    rangeColor: { rgb: "1,2,3" },
    rangeOpacity: { alpha: 0.3 },
  };
  draw(options);
  draw(options);
  assert.equal(paths.length, 1);
  operations.pop();
  draw(options);
  operations.push({
    ...rect,
    points: [
      [0.5, 0.5],
      [0.8, 0.8],
    ],
  });
  draw(options);
  assert.equal(paths.length, 2);
  assert.equal(paths[1][0], 400);
  draw({ ...options, fitted: { width: 400, height: 225 } });
  assert.equal(paths.length, 3);
  draw({ ...options, draft: rect });
  draw({
    ...options,
    draft: {
      ...rect,
      points: [
        [0, 0],
        [1, 1],
      ],
    },
  });
  assert.equal(paths.length, 7);
});

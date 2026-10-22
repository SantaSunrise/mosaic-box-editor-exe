import assert from "node:assert/strict";
import test from "node:test";
import {
  coverage,
  formatTime,
  isAuthError,
  isCovered,
  sortResults,
  summarize,
} from "../src/check.ts";

const rect = (x0, y0, x1, y1, mode = "add") => ({
  tool: "rect",
  mode,
  points: [
    [x0, y0],
    [x1, y1],
  ],
});
const detection = (box) => ({ label: "性器", score: 0.9, box });
const result = (name, verdict, boxes = [], inputTokens = 0) => ({
  name,
  kind: "video",
  source: "original",
  key: name,
  verdict,
  model: "m",
  inputTokens,
  frames: [{ index: 0, time: 0.5, detections: boxes.map(detection) }],
});

test("a detection inside the saved rectangle is covered", () => {
  const box = [0.4, 0.4, 0.6, 0.6];
  assert.equal(coverage(box, [rect(0.3, 0.3, 0.7, 0.7)]), 1);
  assert.ok(isCovered(detection(box), [rect(0.3, 0.3, 0.7, 0.7)]));
  assert.equal(coverage(box, []), 0);
});

test("partial and erased coverage are measured, not rounded up", () => {
  const box = [0.4, 0.4, 0.6, 0.6];
  assert.equal(coverage(box, [rect(0, 0, 0.5, 1)]), 0.5);
  assert.equal(
    coverage(box, [rect(0, 0, 1, 1), rect(0, 0, 1, 1, "subtract")]),
    0,
  );
  assert.ok(!isCovered(detection(box), [rect(0, 0, 0.5, 1)]));
});

test("lasso and brush strokes count like the export mask", () => {
  const box = [0.45, 0.45, 0.55, 0.55];
  const lasso = {
    tool: "lasso",
    mode: "add",
    points: [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
    ],
  };
  const brush = {
    tool: "brush",
    mode: "add",
    size: 0.3,
    points: [
      [0.2, 0.5],
      [0.8, 0.5],
    ],
  };
  assert.equal(coverage(box, [lasso]), 1);
  assert.equal(coverage(box, [brush]), 1);
});

test("summary counts verdicts, tokens and NG files outside the selection", () => {
  const results = [
    result("a", "ng", [[0.4, 0.4, 0.6, 0.6]], 7000),
    result("b", "ng", [[0.1, 0.1, 0.2, 0.2]], 7000),
    result("c", "ok", [], 7000),
    result("d", "error"),
  ];
  const summary = summarize(results, (r) =>
    r.name === "a" || r.name === "b" ? [rect(0.3, 0.3, 0.7, 0.7)] : [],
  );
  assert.deepEqual(summary, {
    ok: 1,
    ng: 2,
    error: 1,
    uncovered: 1,
    inputTokens: 21000,
    frames: 4,
  });
  assert.deepEqual(
    sortResults([results[2], results[3], results[0]]).map((r) => r.name),
    ["a", "d", "c"],
  );
});

test("helpers", () => {
  assert.ok(isAuthError("AUTH_REQUIRED: ログインしてください"));
  assert.ok(!isAuthError("HTTP 500"));
  assert.equal(formatTime(null), "画像");
  assert.equal(formatTime(65.25), "1:05.3");
});

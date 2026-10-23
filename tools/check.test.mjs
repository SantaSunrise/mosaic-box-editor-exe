import assert from "node:assert/strict";
import test from "node:test";
import {
  aiFilterVerdict,
  candidateFor,
  candidateLabel,
  countVerdicts,
  coverage,
  formatTime,
  isAuthError,
  isCovered,
  sortResults,
  summarize,
  toPixels,
  unionBox,
} from "../src/check.ts";

const rect = (x0, y0, x1, y1, mode = "add") => ({
  tool: "rect",
  mode,
  points: [
    [x0, y0],
    [x1, y1],
  ],
});
const detection = (box, score = 0.9, located = true) => ({
  label: "性器",
  score,
  box,
  located,
});
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
    review: 0,
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

test("union of several boxes is the smallest rectangle around all of them", () => {
  assert.deepEqual(
    unionBox([
      detection([0.4, 0.4, 0.5, 0.5]),
      detection([0.45, 0.5, 0.6, 0.7]),
      detection([0.3, 0.45, 0.42, 0.55]),
    ]),
    [0.3, 0.4, 0.6, 0.7],
  );
  assert.deepEqual(
    unionBox([detection([0.2, 0.2, 0.3, 0.3])]),
    [0.2, 0.2, 0.3, 0.3],
  );
});

test("the union is clamped to the frame and tolerates swapped edges", () => {
  assert.deepEqual(
    unionBox([
      detection([-0.1, 0.2, 0.3, 0.4]),
      detection([0.9, 1.2, 0.7, 0.5]),
    ]),
    [0, 0.2, 0.9, 1],
  );
});

test("no usable box means no candidate", () => {
  assert.equal(unionBox([]), null);
  // Whole-frame fallbacks (not located), empty and non-finite boxes are skipped.
  assert.equal(
    unionBox([
      detection([0, 0, 1, 1], 0.9, false),
      detection([0.5, 0.5, 0.5, 0.6]),
      detection([NaN, 0, 1, 1]),
      detection([1.2, 0.1, 1.5, 0.3]),
    ]),
    null,
  );
  assert.equal(candidateFor(result("a", "ok")), null);
});

test("pixel conversion uses the original resolution and never shrinks the box", () => {
  assert.deepEqual(toPixels([0.3, 0.4, 0.6, 0.7], 1920, 1080), {
    x: 576,
    y: 432,
    width: 576,
    height: 324,
  });
  assert.deepEqual(toPixels([0.333, 0.5, 0.667, 1], 1000, 999), {
    x: 333,
    y: 499,
    width: 334,
    height: 500,
  });
});

test("the candidate covers the NG frames only, in normalized and source pixels", () => {
  const withFrames = (frames, extra = {}) => ({
    ...result("a", "ng"),
    width: 3840,
    height: 2160,
    frames: frames.map((detections, index) => ({
      index,
      time: index,
      detections,
    })),
    ...extra,
  });
  const candidate = candidateFor(
    withFrames([
      [detection([0.4, 0.4, 0.5, 0.5], 0.95)],
      [],
      [detection([0.45, 0.5, 0.6, 0.7], 0.85)],
      // Needs-a-look detections (0.5 to 0.8) do not widen the candidate.
      [detection([0.0, 0.0, 1.0, 1.0], 0.6)],
    ]),
  );
  assert.deepEqual(candidate.box, [0.4, 0.4, 0.6, 0.7]);
  assert.equal(candidate.detections, 2);
  assert.deepEqual(candidate.pixels, {
    x: 1536,
    y: 864,
    width: 768,
    height: 648,
  });
  // Without a known video size only the normalized box is available.
  const unsized = candidateFor(
    withFrames([[detection([0.1, 0.1, 0.2, 0.2], 0.9)]], {
      width: null,
      height: null,
    }),
  );
  assert.equal(unsized.pixels, null);
  assert.equal(candidate.basis, "ng");
  assert.equal(candidate.frameIndex, 0);
  // OK and error files have no candidate even if a stray box is present.
  for (const verdict of ["ok", "error"])
    assert.equal(
      candidateFor(
        withFrames([[detection([0.1, 0.1, 0.2, 0.2], 0.9)]], { verdict }),
      ),
      null,
    );
});

test("a review file gets a candidate around every located box from 0.5 up", () => {
  const review = {
    ...result("a", "review"),
    width: 1000,
    height: 500,
    frames: [
      { index: 0, time: 0, detections: [] },
      {
        index: 1,
        time: 1,
        detections: [
          detection([0.2, 0.2, 0.3, 0.3], 0.55),
          // Not located: ignored, like for NG files.
          detection([0, 0, 1, 1], 0.7, false),
        ],
      },
      {
        index: 2,
        time: 2,
        detections: [detection([0.5, 0.4, 0.6, 0.6], 0.75)],
      },
    ],
  };
  const candidate = candidateFor(review);
  assert.equal(candidate.basis, "review");
  assert.equal(candidate.frameIndex, 1);
  assert.equal(candidate.detections, 2);
  assert.deepEqual(candidate.box, [0.2, 0.2, 0.6, 0.6]);
  assert.deepEqual(candidate.pixels, {
    x: 200,
    y: 100,
    width: 400,
    height: 200,
  });
  assert.equal(candidateLabel(candidate), "モザイク候補（要確認）");
  assert.equal(candidateLabel({ basis: "ng" }), "モザイク候補");
  // Only unlocated boxes: nothing to show.
  assert.equal(
    candidateFor({
      ...review,
      frames: [
        {
          index: 0,
          time: 0,
          detections: [detection([0, 0, 1, 1], 0.6, false)],
        },
      ],
    }),
    null,
  );
});

test("AI library filters select by verdict and count per verdict", () => {
  assert.equal(aiFilterVerdict("ai-ng"), "ng");
  assert.equal(aiFilterVerdict("ai-review"), "review");
  assert.equal(aiFilterVerdict("ai-ok"), "ok");
  for (const other of ["all", "missing", "ready", "exported", "stale", ""])
    assert.equal(aiFilterVerdict(other), null);
  const results = new Map([
    ["a", result("a", "ng")],
    ["b", result("b", "review")],
    ["c", result("c", "review")],
    ["d", result("d", "ok")],
  ]);
  assert.deepEqual(countVerdicts(["a", "b", "c", "d", "unchecked"], results), {
    ok: 1,
    review: 2,
    ng: 1,
    error: 0,
  });
  // No results yet: every counter is zero.
  assert.deepEqual(countVerdicts(["a", "b"], new Map()), {
    ok: 0,
    review: 0,
    ng: 0,
    error: 0,
  });
});

// AI mosaic check results: verdict summary and how detections relate to the
// selection saved in the editor. Pure functions so the Node tests can cover them.
import type { Detection, FileCheckResult, MaskOperation, Point } from "./types";

/** A detection this much covered by the saved selection counts as handled. */
export const COVERED_RATIO = 0.9;
const SAMPLES = 12;

function inPolygon(x: number, y: number, points: Point[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function segmentDistance(x: number, y: number, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
/** Same hit test as the export mask (src-tauri/src/mask.rs). */
function hit(op: MaskOperation, x: number, y: number) {
  const p = op.points;
  if (op.tool === "rect" && p.length >= 2)
    return (
      x >= Math.min(p[0][0], p[1][0]) &&
      x <= Math.max(p[0][0], p[1][0]) &&
      y >= Math.min(p[0][1], p[1][1]) &&
      y <= Math.max(p[0][1], p[1][1])
    );
  if (op.tool === "lasso" && p.length >= 3) return inPolygon(x, y, p);
  if (op.tool === "brush" && p.length) {
    const radius = (op.size ?? 0.04) / 2;
    if (p.length === 1) return segmentDistance(x, y, p[0], p[0]) <= radius;
    for (let i = 1; i < p.length; i++)
      if (segmentDistance(x, y, p[i - 1], p[i]) <= radius) return true;
  }
  return false;
}

/** Share of the detection box inside the saved selection, 0–1. */
export function coverage(
  box: Detection["box"],
  operations: MaskOperation[],
): number {
  if (!operations.length) return 0;
  const [x0, y0, x1, y1] = box;
  let covered = 0;
  for (let row = 0; row < SAMPLES; row++)
    for (let col = 0; col < SAMPLES; col++) {
      const x = x0 + ((col + 0.5) / SAMPLES) * (x1 - x0),
        y = y0 + ((row + 0.5) / SAMPLES) * (y1 - y0);
      let inside = false;
      for (const op of operations)
        if (hit(op, x, y)) inside = op.mode !== "subtract";
      if (inside) covered++;
    }
  return covered / (SAMPLES * SAMPLES);
}

export const isCovered = (detection: Detection, operations: MaskOperation[]) =>
  coverage(detection.box, operations) >= COVERED_RATIO;

export type CheckSummary = {
  ok: number;
  ng: number;
  error: number;
  /** NG files where some detection lies outside the saved selection. */
  uncovered: number;
  inputTokens: number;
  frames: number;
};

export function summarize(
  results: FileCheckResult[],
  operationsFor: (result: FileCheckResult) => MaskOperation[],
): CheckSummary {
  const summary: CheckSummary = {
    ok: 0,
    ng: 0,
    error: 0,
    uncovered: 0,
    inputTokens: 0,
    frames: 0,
  };
  for (const result of results) {
    summary[result.verdict]++;
    summary.inputTokens += result.inputTokens;
    summary.frames += result.frames.length;
    const operations = operationsFor(result);
    if (
      result.frames.some((f) =>
        f.detections.some((d) => !isCovered(d, operations)),
      )
    )
      summary.uncovered++;
  }
  return summary;
}

/** NG first, then errors, then OK; names keep their order within a group. */
export function sortResults(results: FileCheckResult[]) {
  const rank = { ng: 0, error: 1, ok: 2 } as const;
  return [...results].sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

export const isAuthError = (error: unknown) =>
  String(error).includes("AUTH_REQUIRED");

export const formatTime = (seconds: number | null) =>
  seconds === null
    ? "画像"
    : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

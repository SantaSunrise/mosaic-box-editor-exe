// AI mosaic check results: verdict summary and how detections relate to the
// selection saved in the editor. Pure functions so the Node tests can cover them.
import type {
  Candidate,
  Detection,
  FileCheckResult,
  MaskOperation,
  Point,
  Verdict,
} from "./types";

/** Same rule as ng_check.py: from this probability a detection is NG; weaker ones need a look. */
export const NG_SCORE = 0.8;
/** The Worker's own threshold: weaker detections are not returned at all. */
export const REVIEW_SCORE = 0.5;

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
  review: number;
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
    review: 0,
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

/** NG first, then errors, then "needs a look", then OK; names keep their order. */
export function sortResults(results: FileCheckResult[]) {
  const rank: Record<Verdict, number> = { ng: 0, error: 1, review: 2, ok: 3 };
  return [...results].sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

export const verdictLabel: Record<Verdict, string> = {
  ok: "OK",
  review: "要確認",
  ng: "NG",
  error: "エラー",
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Smallest rectangle containing every box, clamped to the frame. Boxes the
 * model could not place (`located: false`, whole frame) and malformed boxes
 * are ignored; with nothing left there is no rectangle.
 */
export function unionBox(
  detections: Pick<Detection, "box" | "located">[],
): Detection["box"] | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const { box, located } of detections) {
    if (!located || box.length !== 4 || !box.every(Number.isFinite)) continue;
    const bx0 = clamp01(Math.min(box[0], box[2])),
      bx1 = clamp01(Math.max(box[0], box[2])),
      by0 = clamp01(Math.min(box[1], box[3])),
      by1 = clamp01(Math.max(box[1], box[3]));
    if (bx1 <= bx0 || by1 <= by0) continue;
    x0 = Math.min(x0, bx0);
    y0 = Math.min(y0, by0);
    x1 = Math.max(x1, bx1);
    y1 = Math.max(y1, by1);
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** Normalized box to pixels of the original video; the rectangle only grows when rounded. */
export function toPixels(
  box: Detection["box"],
  width: number,
  height: number,
): NonNullable<Candidate["pixels"]> {
  const x = Math.floor(box[0] * width),
    y = Math.floor(box[1] * height);
  return {
    x,
    y,
    width: Math.min(width, Math.ceil(box[2] * width)) - x,
    height: Math.min(height, Math.ceil(box[3] * height)) - y,
  };
}

/**
 * "モザイク候補" of one video: the rectangle around the boxes of the frames
 * that decided the verdict, because the position drifts as the body moves.
 * NG video: every located box with score >= NG_SCORE. 要確認 video: every
 * located box from REVIEW_SCORE up (NG-grade ones included). OK and error
 * videos have no candidate. Boxes are normalized, so resizing frames before
 * sending (long edge 1024px) does not change them; `pixels` converts to the
 * original resolution.
 */
export function candidateFor(result: FileCheckResult): Candidate | null {
  if (result.verdict !== "ng" && result.verdict !== "review") return null;
  const minScore = result.verdict === "ng" ? NG_SCORE : REVIEW_SCORE;
  const used = result.frames.flatMap((f) =>
    f.detections
      .filter((d) => d.score >= minScore && d.located)
      .map((d) => ({ detection: d, frameIndex: f.index })),
  );
  const detections = used.map((u) => u.detection);
  const box = unionBox(detections);
  if (!box) return null;
  const { width, height } = result;
  return {
    basis: result.verdict,
    frameIndex: used[0].frameIndex,
    box,
    pixels:
      width && height && width > 0 && height > 0
        ? toPixels(box, width, height)
        : null,
    detections: detections.length,
  };
}

/** "モザイク候補", marked when it comes from 要確認 frames only. */
export const candidateLabel = (candidate: Pick<Candidate, "basis">) =>
  candidate.basis === "review" ? "モザイク候補（要確認）" : "モザイク候補";

/** Library filter values that select by the AI verdict instead of the status. */
export const AI_FILTERS = {
  "ai-ng": "ng",
  "ai-review": "review",
  "ai-ok": "ok",
} as const;

/** The verdict an AI filter selects, or null for the status filters. */
export const aiFilterVerdict = (filter: string): Verdict | null =>
  (AI_FILTERS as Record<string, Verdict>)[filter] ?? null;

/** Number of clips per verdict, for the AI filter counters. */
export function countVerdicts(
  keys: string[],
  results: ReadonlyMap<string, Pick<FileCheckResult, "verdict">>,
): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { ok: 0, review: 0, ng: 0, error: 0 };
  for (const key of keys) {
    const verdict = results.get(key)?.verdict;
    if (verdict) counts[verdict]++;
  }
  return counts;
}

export const isAuthError = (error: unknown) =>
  String(error).includes("AUTH_REQUIRED");

export const formatTime = (seconds: number | null) =>
  seconds === null
    ? "画像"
    : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

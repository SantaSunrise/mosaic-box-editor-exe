// Data exchanged with the Tauri commands. Coordinates are normalized to 0–1.
export type Point = [number, number];
export type MaskOperation = {
  tool: "rect" | "lasso" | "brush";
  mode: "add" | "subtract";
  points: Point[];
  size?: number;
};
export type SelectionData = {
  id: string;
  src: string;
  label: string;
  box?: number[];
  mask?: MaskOperation[];
  savedAt: string;
};
export type ExportResult = { path: string; encoder: string };
export type VideoEntry = {
  id: string;
  name: string;
  path: string;
  boxKey: string;
  exported: boolean;
  stale: boolean;
  box: SelectionData | null;
};

// AI mosaic check (src-tauri/src/check.rs, src-tauri/src/auth.rs).
export type AuthInfo = {
  apiBase: string;
  email: string | null;
  expiresAt: number | null;
};
export type CheckScope = "original" | "mosaic";
export type CheckTarget = {
  name: string;
  path: string;
  kind: "image" | "video";
  source: CheckScope;
  key: string;
};
export type Detection = {
  label: string;
  score: number;
  /** Normalized [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  boxConfidence?: number;
};
export type FrameResult = {
  index: number;
  time: number | null;
  detections: Detection[];
  error?: string;
};
export type FileCheckResult = {
  name: string;
  kind: "image" | "video";
  source: CheckScope;
  key: string;
  verdict: "ok" | "ng" | "error";
  frames: FrameResult[];
  model: string;
  inputTokens: number;
};

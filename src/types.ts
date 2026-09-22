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

import type { MaskOperation } from "./types";
import type { Size } from "./viewport";
type RenderOptions = {
  fitted: Size;
  operations: MaskOperation[];
  draft: MaskOperation | null;
  previewMode: "region" | "mosaic";
  rangeColor: { rgb: string };
  rangeOpacity: { alpha: number };
};

/** Reuse offscreen surfaces while drawing a selection or mosaic preview. */
export function createRenderer(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
) {
  const ctx = canvas.getContext("2d")!;
  const maskCanvas = document.createElement("canvas"),
    maskCtx = maskCanvas.getContext("2d")!;
  const pixelCanvas = document.createElement("canvas"),
    pixelCtx = pixelCanvas.getContext("2d")!;
  const blockMaskCanvas = document.createElement("canvas"),
    blockMaskCtx = blockMaskCanvas.getContext("2d")!;
  const cellCanvas = document.createElement("canvas"),
    cellCtx = cellCanvas.getContext("2d", { willReadFrequently: true })!;
  function pathOperation(
    target: CanvasRenderingContext2D,
    op: MaskOperation,
    w: number,
    h: number,
  ) {
    if (!op.points.length) return;
    target.beginPath();
    if (op.tool === "rect" && op.points.length > 1) {
      const [a, b] = op.points;
      target.rect(a[0] * w, a[1] * h, (b[0] - a[0]) * w, (b[1] - a[1]) * h);
      target.fill();
    } else if (op.tool === "lasso") {
      target.moveTo(op.points[0][0] * w, op.points[0][1] * h);
      for (const p of op.points.slice(1)) target.lineTo(p[0] * w, p[1] * h);
      target.closePath();
      target.fill();
    } else {
      target.lineWidth = (op.size ?? 0.04) * Math.max(w, h);
      target.lineCap = "round";
      target.lineJoin = "round";
      target.moveTo(op.points[0][0] * w, op.points[0][1] * h);
      for (const p of op.points.slice(1)) target.lineTo(p[0] * w, p[1] * h);
      target.stroke();
      if (op.points.length === 1) {
        target.beginPath();
        target.arc(
          op.points[0][0] * w,
          op.points[0][1] * h,
          target.lineWidth / 2,
          0,
          Math.PI * 2,
        );
        target.fill();
      }
    }
  }
  function buildMask(
    w: number,
    h: number,
    operations: MaskOperation[],
    draft: MaskOperation | null,
  ) {
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      maskCanvas.width = w;
      maskCanvas.height = h;
    }
    maskCtx.clearRect(0, 0, w, h);
    maskCtx.fillStyle = "#fff";
    maskCtx.strokeStyle = "#fff";
    for (const op of [...operations, ...(draft ? [draft] : [])]) {
      maskCtx.globalCompositeOperation =
        op.mode === "add" ? "source-over" : "destination-out";
      pathOperation(maskCtx, op, w, h);
    }
    maskCtx.globalCompositeOperation = "source-over";
  }
  function blockifyMask(w: number, h: number, cols: number, rows: number) {
    cellCanvas.width = cols;
    cellCanvas.height = rows;
    cellCtx.clearRect(0, 0, cols, rows);
    cellCtx.imageSmoothingEnabled = true;
    cellCtx.drawImage(maskCanvas, 0, 0, cols, rows);
    const cells = cellCtx.getImageData(0, 0, cols, rows).data;
    blockMaskCanvas.width = w;
    blockMaskCanvas.height = h;
    blockMaskCtx.fillStyle = "#fff";
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        if (cells[(y * cols + x) * 4 + 3] > 0) {
          const x0 = Math.floor((x * w) / cols),
            y0 = Math.floor((y * h) / rows),
            x1 = Math.ceil(((x + 1) * w) / cols),
            y1 = Math.ceil(((y + 1) * h) / rows);
          blockMaskCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
  }
  function draw({
    fitted,
    operations,
    draft,
    previewMode,
    rangeColor,
    rangeOpacity,
  }: RenderOptions) {
    const w = Math.max(1, Math.round(fitted.width)),
      h = Math.max(1, Math.round(fitted.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (!operations.length && !draft) return;
    buildMask(w, h, operations, draft);
    if (
      previewMode === "mosaic" &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      const block = Math.max(
          4,
          Math.round(Math.max(video.videoWidth, video.videoHeight) / 100),
        ),
        cols = Math.max(1, Math.ceil(video.videoWidth / block)),
        rows = Math.max(1, Math.ceil(video.videoHeight / block));
      pixelCanvas.width = cols;
      pixelCanvas.height = rows;
      pixelCtx.imageSmoothingEnabled = true;
      pixelCtx.drawImage(video, 0, 0, cols, rows);
      blockifyMask(w, h, cols, rows);
      ctx.save();
      ctx.drawImage(blockMaskCanvas, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pixelCanvas, 0, 0, cols, rows, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.save();
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = `rgba(${rangeColor.rgb},${rangeOpacity.alpha})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  return draw;
}

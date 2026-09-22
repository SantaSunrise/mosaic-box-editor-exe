import { createRenderer } from "./renderer";
import { LoopPlayer } from "./loop-player";
import { editorTemplate } from "./ui/editor";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { refreshIcons, setButtonIcon } from "./ui/icons";
import { pendingExports, runBatch } from "./batch-export";
import "./style.css";
import "./icons.css";
import {
  constrainView,
  fitSize,
  zoomAt,
  type Viewport,
  type Size,
} from "./viewport";

import type {
  Point,
  MaskOperation,
  SelectionData,
  ExportResult,
  VideoEntry,
} from "./types";
import { rangeColors, rangeOpacities } from "./appearance";
let rangeColor = rangeColors[4],
  rangeOpacity = rangeOpacities[1];
try {
  const saved = JSON.parse(
    localStorage.getItem("mosaic-range-appearance") || "null",
  );
  rangeColor = rangeColors.find((c) => c.id === saved?.color) || rangeColor;
  rangeOpacity =
    rangeOpacities.find((o) => o.id === saved?.opacity) || rangeOpacity;
} catch {
  /* Storage can be unavailable; use the default appearance. */
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = editorTemplate;

const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`#${id}`)!;

refreshIcons();
let video = $("video") as HTMLVideoElement;
const canvas = $("overlay") as HTMLCanvasElement;
const standby = document.createElement("video");
standby.className = "loop-standby";
video.parentElement!.insertBefore(standby, canvas);
const player = new LoopPlayer([video, standby], {
  change(active, event) {
    video = active;
    if (["play", "playing", "swap"].includes(event)) animate();
    if (["pause", "ended", "source"].includes(event))
      cancelAnimationFrame(animationFrame);
    if (
      [
        "loadedmetadata",
        "loadeddata",
        "seeked",
        "swap",
        "pause",
        "ended",
      ].includes(event)
    )
      draw();
    updateTransport();
  },
  error(error) {
    $("state").textContent = "再生できませんでした：" + String(error);
  },
});
const renderPreview = createRenderer(canvas, () => video);
let root = "",
  entries: VideoEntry[] = [],
  current: VideoEntry | null = null,
  filter = "all",
  dirty = false,
  autosaveTimer = 0;
let lastMask: MaskOperation[] = [];
let operations: MaskOperation[] = [],
  draft: MaskOperation | null = null;
let tool: MaskOperation["tool"] = "rect",
  editMode: MaskOperation["mode"] = "add",
  previewMode: "region" | "mosaic" = "region",
  animationFrame = 0;
let playbackRate = 1;
let exporting = false,
  cancelBatch = false;
let saveInFlight: Promise<SelectionData | null> = Promise.resolve(null);
let view: Viewport = { zoom: 1, x: 0, y: 0 };
let fitted: Size = { width: 1, height: 1 };
let pan: { pointerId: number; x: number; y: number; start: Viewport } | null =
  null;

function legacyOperations(data: SelectionData | null): MaskOperation[] {
  if (data?.mask?.length) return structuredClone(data.mask);
  if (data?.box?.length === 4) {
    const [x0, y0, x1, y1] = data.box;
    return [
      {
        tool: "rect",
        mode: "add",
        points: [
          [x0, y0],
          [x1, y1],
        ],
      },
    ];
  }
  return [];
}
function draw() {
  fitVideo();
  renderPreview({
    fitted,
    operations,
    draft,
    previewMode,
    rangeColor,
    rangeOpacity,
  });
}
function animate() {
  cancelAnimationFrame(animationFrame);
  const frame = () => {
    draw();
    if (!video.paused && !video.ended)
      animationFrame = requestAnimationFrame(frame);
  };
  animationFrame = requestAnimationFrame(frame);
}
function markChanged() {
  dirty = true;
  $("state").textContent = "変更を自動保存します…";
  $("undo").toggleAttribute("disabled", operations.length === 0);
  draw();
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveCurrent(true), 700);
}
function statusOf(e: VideoEntry) {
  if (!e.box) return ["未設定", "missing", "circle-dashed"];
  if (e.stale) return ["更新あり", "stale", "refresh-cw"];
  if (e.exported) return ["出力済み", "exported", "circle-check"];
  return ["設定済み", "ready", "check"];
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function renderList() {
  const visible = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => filter === "all" || statusOf(e)[1] === filter);
  $("videos").innerHTML =
    visible
      .map(({ e, i }) => {
        const [label, status, icon] = statusOf(e);
        return `<button class="video-row ${e === current ? "active" : ""}" data-i="${i}" aria-current="${e === current}" title="${escapeHtml(e.name)} — ${label}"><span class="file-status-icon ${status}" aria-hidden="true"><i data-lucide="${icon}"></i></span><span class="file-details"><span class="file-name">${escapeHtml(e.name)}</span><span class="status-badge ${status}"><i data-lucide="${icon}"></i>${label}</span></span></button>`;
      })
      .join("") || '<p class="list-empty">該当する動画はありません</p>';
  $("countAll").textContent = String(entries.length);
  for (const [id, status] of [
    ["countMissing", "missing"],
    ["countReady", "ready"],
    ["countExported", "exported"],
    ["countStale", "stale"],
  ]) {
    $(id).textContent = String(
      entries.filter((e) => statusOf(e)[1] === status).length,
    );
  }
  document
    .querySelectorAll<HTMLButtonElement>(".video-row")
    .forEach(
      (el) => (el.onclick = () => select(entries[Number(el.dataset.i)])),
    );
  refreshIcons($("videos"));
  updateBatchButton();
}
async function select(entry: VideoEntry) {
  if (exporting || entry === current) return;
  if (current && dirty) await saveCurrent(true);
  if (operations.length) lastMask = structuredClone(operations);
  current = entry;
  resetView();
  operations = legacyOperations(entry.box);
  if (
    !operations.length &&
    lastMask.length &&
    ($("inherit") as HTMLInputElement).checked
  ) {
    operations = structuredClone(lastMask);
    dirty = true;
    $("state").textContent = "前の選択範囲を引き継ぎました（自動保存）";
    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => saveCurrent(true), 300);
  } else {
    dirty = false;
    $("state").textContent = operations.length
      ? "保存済みの選択を表示中"
      : "動画上をドラッグして選択";
  }
  draft = null;
  player.load(convertFileSrc(entry.path));
  $("workspace").classList.remove("empty");
  for (const id of ["saveSelection", "saveNext", "exportVideo", "clear"])
    $(id).removeAttribute("disabled");
  $("undo").toggleAttribute("disabled", !operations.length);
  renderList();
}

let openingProject = false;
async function openProject(selected: string) {
  if (openingProject || exporting) return;
  openingProject = true;
  updateBatchButton();
  for (const id of ["choose", "dropZone"]) $(id).setAttribute("disabled", "");
  $("state").textContent = "フォルダ内の動画を読み込んでいます…";
  try {
    clearTimeout(autosaveTimer);
    if (current && dirty) await saveCurrent(true);
    const scanned = await invoke<VideoEntry[]>("scan_project", {
      root: selected,
    });
    player.pause();
    root = selected;
    entries = scanned;
    $("batchProgress").hidden = true;
    $("batchErrors").hidden = true;
    $("project").textContent = root;
    $("project").title = root;
    current = null;
    operations = [];
    lastMask = [];
    dirty = false;
    draft = null;
    resetView();
    filter = "all";
    document
      .querySelectorAll<HTMLButtonElement>(".filter")
      .forEach((button) => {
        const active = button.dataset.filter === filter;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    $("videos").scrollTop = 0;
    renderList();
    if (entries[0]) await select(entries[0]);
    else {
      player.load(null);
      $("workspace").classList.add("empty");
      for (const id of [
        "saveSelection",
        "saveNext",
        "exportVideo",
        "clear",
        "undo",
      ])
        $(id).setAttribute("disabled", "");
      $("dropTitle").textContent = "このフォルダには動画がありません";
      $("dropDescription").textContent =
        "MP4・MOV・WebMが入った別のフォルダをドロップしてください。";
      $("state").textContent = "このフォルダ以下に動画がありません";
      draw();
    }
  } catch (error) {
    $("state").textContent = "フォルダを開けませんでした：" + String(error);
    if (!current) {
      $("dropTitle").textContent = "動画が入ったフォルダを選んでください";
      $("dropDescription").textContent =
        "フォルダを読み込めませんでした。フォルダ全体をドロップするか、クリックして選び直してください。";
    }
  } finally {
    openingProject = false;
    updateBatchButton();
    for (const id of ["choose", "dropZone"]) $(id).removeAttribute("disabled");
  }
}
async function chooseProject() {
  if (exporting) return;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "動画を含むフォルダを選択",
    });
    if (selected) await openProject(selected);
  } catch (error) {
    $("state").textContent = "フォルダを選択できませんでした：" + String(error);
  }
}
$("choose").onclick = chooseProject;
$("dropZone").onclick = chooseProject;
if (isTauri()) {
  getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      $("stage").classList.toggle(
        "drag-over",
        payload.type === "enter" || payload.type === "over",
      );
      if (payload.type === "drop") {
        if (payload.paths.length === 1) void openProject(payload.paths[0]);
        else $("state").textContent = "フォルダを1つずつドロップしてください";
      }
    })
    .catch(() => {
      $("dropTitle").textContent = "動画が入ったフォルダを開く";
      $("dropDescription").textContent =
        "クリックしてフォルダを選ぶと、中の動画が左側に一覧表示されます。";
      $("state").textContent =
        "ドラッグ＆ドロップを利用できません。クリックしてフォルダを開いてください。";
    });
}

document.querySelectorAll<HTMLButtonElement>(".filter").forEach(
  (el) =>
    (el.onclick = () => {
      filter = el.dataset.filter ?? "all";
      $("videos").scrollTop = 0;
      document
        .querySelectorAll(".filter")
        .forEach((x) => x.classList.toggle("active", x === el));
      renderList();
    }),
);
document.querySelectorAll<HTMLButtonElement>(".tool").forEach(
  (el) =>
    (el.onclick = () => {
      tool = el.dataset.tool as typeof tool;
      document
        .querySelectorAll(".tool")
        .forEach((x) => x.classList.toggle("active", x === el));
      $("brushSize").parentElement!.classList.toggle(
        "visible",
        tool === "brush",
      );
      canvas.classList.toggle("brush-mode", tool === "brush");
      updateBrushCursor();
    }),
);
document.querySelectorAll<HTMLButtonElement>(".mode").forEach(
  (el) =>
    (el.onclick = () => {
      editMode = el.dataset.mode as typeof editMode;
      document
        .querySelectorAll(".mode")
        .forEach((x) => x.classList.toggle("active", x === el));
      draw();
    }),
);
const brushSize = $("brushSize") as HTMLInputElement,
  brushCursor = $("brushCursor");
brushSize.oninput = () => {
  $("brushSizeValue").textContent =
    `${Math.round(Number(brushSize.value) * 100)}%`;
  updateBrushCursor();
  showBrushSizePreview();
};
brushSize.onfocus = showBrushSizePreview;
brushSize.onpointerdown = showBrushSizePreview;
brushSize.onblur = hideBrushSizePreview;
function updateBrushCursor(e?: { clientX: number; clientY: number }) {
  if (tool !== "brush") {
    brushCursor.classList.remove("visible");
    hideBrushSizePreview();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const d = Number(brushSize.value) * Math.max(rect.width, rect.height);
  brushCursor.style.width = `${d}px`;
  brushCursor.style.height = `${d}px`;
  brushCursor.classList.toggle("subtract", editMode === "subtract");
  if (e) {
    const stage = $("stage").getBoundingClientRect();
    brushCursor.style.left = `${e.clientX - stage.left}px`;
    brushCursor.style.top = `${e.clientY - stage.top}px`;
    brushCursor.classList.add("visible");
  }
}
function point(e: PointerEvent): Point {
  const r = canvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  ];
}
canvas.onpointerdown = (e) => {
  if (exporting || !current || e.button !== 0 || pan) return;
  draft = {
    tool,
    mode: editMode,
    points: [point(e)],
    ...(tool === "brush" ? { size: Number(brushSize.value) } : {}),
  };
  canvas.setPointerCapture(e.pointerId);
  draw();
};
canvas.onpointermove = (e) => {
  updateBrushCursor(e);
  if (!draft) return;
  const p = point(e);
  if (draft.tool === "rect") draft.points[1] = p;
  else draft.points.push(p);
  draw();
};
canvas.onpointerenter = (e) => {
  hideBrushSizePreview();
  updateBrushCursor(e);
};
canvas.onpointerleave = () => brushCursor.classList.remove("visible");
canvas.onpointercancel = () => {
  draft = null;
  draw();
};
canvas.onpointerup = () => {
  if (!draft) return;
  if (draft.tool === "rect" && draft.points.length === 1)
    draft.points.push(draft.points[0]);
  operations.push(draft);
  draft = null;
  markChanged();
};
$("undo").onclick = () => {
  operations.pop();
  markChanged();
};
$("clear").onclick = () => {
  operations = [];
  lastMask = [];
  draft = null;
  markChanged();
};
function saveCurrent(quiet = false): Promise<SelectionData | null> {
  saveInFlight = saveInFlight
    .catch(() => null)
    .then(() => performSaveCurrent(quiet));
  return saveInFlight;
}
async function performSaveCurrent(quiet = false) {
  if (!current) return null;
  const target = current;
  if (!operations.length) {
    if (!dirty && !quiet) throw new Error("保存する選択範囲がありません");
    await invoke("delete_selection", { root, boxKey: target.boxKey });
    target.box = null;
    if (target.exported) target.stale = true;
    if (target === current) dirty = false;
    renderList();
    if (quiet && target === current)
      $("state").textContent = "選択範囲を削除しました";
    return null;
  }
  const snapshot = structuredClone(operations);
  const saved = await invoke<SelectionData>("save_selection", {
    root,
    id: target.id,
    src: target.name,
    boxKey: target.boxKey,
    mask: snapshot,
  });
  target.box = saved;
  if (target.exported) target.stale = true;
  if (target === current) dirty = false;
  renderList();
  if (quiet && target === current) $("state").textContent = "自動保存しました";
  return saved;
}
$("saveSelection").onclick = async () => {
  try {
    await saveCurrent();
    $("state").textContent = "選択範囲を保存しました";
  } catch (error) {
    $("state").textContent = String(error);
  }
};
$("saveNext").onclick = async () => {
  try {
    await saveCurrent();
    const i = current ? entries.indexOf(current) : -1;
    const next = entries.slice(i + 1).find((e) => !e.box) ?? entries[i + 1];
    if (next) await select(next);
    else $("state").textContent = "最後の動画まで保存しました";
  } catch (error) {
    $("state").textContent = String(error);
  }
};
function updateBatchButton() {
  const count = pendingExports(entries).length;
  $("batchCount").textContent = String(count);
  $("exportBatch").toggleAttribute(
    "disabled",
    exporting || openingProject || count === 0,
  );
  $("exportBatch").setAttribute(
    "aria-label",
    "未出力の動画をまとめて書き出す（" + count + "本）",
  );
}
function setExporting(busy: boolean) {
  exporting = busy;
  document.querySelector<HTMLElement>(".editbar")!.inert = busy;
  $("videos").inert = busy;
  for (const id of [
    "choose",
    "dropZone",
    "saveSelection",
    "saveNext",
    "exportVideo",
  ]) {
    $(id).toggleAttribute(
      "disabled",
      busy || (!["choose", "dropZone"].includes(id) && !current),
    );
  }
  updateBatchButton();
}
async function flushSelection() {
  clearTimeout(autosaveTimer);
  await saveInFlight;
  if (current && dirty) await saveCurrent(true);
}
$("exportVideo").onclick = async () => {
  if (exporting || !current || !operations.length) {
    if (!exporting) $("state").textContent = "モザイク範囲がありません";
    return;
  }
  setExporting(true);
  player.pause();
  setButtonIcon("exportVideo", "wand-sparkles", "書き出し中…");
  try {
    await flushSelection();
    const target = current;
    const mask = structuredClone(operations);
    $("state").textContent = "GPUエンコーダーを確認して書き出しています";
    const output = await invoke<ExportResult>("export_video", {
      root,
      source: target.path,
      outputKey: target.name,
      width: video.videoWidth,
      height: video.videoHeight,
      mask,
    });
    target.exported = true;
    target.stale = false;
    renderList();
    $("state").textContent =
      "書き出しました（" + output.encoder + "）：" + output.path;
  } catch (error) {
    $("state").textContent = "書き出し失敗：" + String(error);
  } finally {
    setExporting(false);
    setButtonIcon("exportVideo", "wand-sparkles", "モザイク動画を書き出す");
  }
};
$("cancelBatch").onclick = () => {
  cancelBatch = true;
  $("cancelBatch").setAttribute("disabled", "");
  $("batchStatus").textContent = "この動画の完了後に停止します";
};
$("exportBatch").onclick = async () => {
  if (exporting || openingProject) return;
  setExporting(true);
  player.pause();
  cancelBatch = false;
  $("batchErrors").hidden = true;
  $("batchErrorList").replaceChildren();
  $("batchProgress").hidden = false;
  $("cancelBatch").hidden = false;
  $("cancelBatch").removeAttribute("disabled");
  const meter = $("batchMeter") as HTMLProgressElement;
  meter.value = 0;
  try {
    await flushSelection();
    const queue = pendingExports(entries);
    meter.max = Math.max(1, queue.length);
    const report = await runBatch(queue, {
      cancelled: () => cancelBatch,
      progress: (done, total, item) => {
        meter.value = done;
        if (item) {
          const message =
            "書き出し " + (done + 1) + "/" + total + "：" + item.name;
          $("batchStatus").textContent = message;
          $("batchStatus").title = message;
          $("state").textContent = message;
        }
      },
      exportItem: async (entry) => {
        await invoke<ExportResult>("export_saved_video", {
          root,
          outputKey: entry.name,
        });
        entry.exported = true;
        entry.stale = false;
        renderList();
      },
    });
    const summary =
      "一括書き出し：完了 " +
      report.completed.length +
      "本・失敗 " +
      report.failed.length +
      "本" +
      (report.remaining ? "・中止 " + report.remaining + "本" : "");
    $("batchStatus").textContent = summary;
    $("batchStatus").title = summary;
    $("state").textContent = summary + " ／ 保存先：" + root + "/mosaic";
    for (const failure of report.failed) {
      const li = document.createElement("li");
      li.textContent = failure.item.name + "：" + failure.error;
      $("batchErrorList").append(li);
    }
    $("batchErrors").hidden = report.failed.length === 0;
  } catch (error) {
    $("batchStatus").textContent = "書き出しを開始できませんでした";
    $("state").textContent = "一括書き出し失敗：" + String(error);
  } finally {
    $("cancelBatch").hidden = true;
    setExporting(false);
  }
};
updateBatchButton();

const seek = $("seek") as HTMLInputElement,
  volume = $("volume") as HTMLInputElement;
const formatTime = (s: number) =>
  Number.isFinite(s)
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "0:00";
function updateTransport() {
  setButtonIcon(
    "play",
    player.paused ? "play" : "pause",
    player.paused ? "再生" : "一時停止",
  );
  $("time").textContent =
    `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  if (video.duration) seek.value = String(video.currentTime / video.duration);
  setButtonIcon(
    "mute",
    video.muted || video.volume === 0 ? "volume-x" : "volume-2",
  );
}
$("play").onclick = () => {
  if (player.paused) void player.play();
  else player.pause();
};
const stepFrame = (d: number) => {
  player.pause();
  player.seek(
    Math.max(0, Math.min(video.duration || 0, video.currentTime + d / 30)),
  );
  draw();
};
$("frameBack").onclick = () => stepFrame(-1);
$("frameNext").onclick = () => stepFrame(1);
seek.oninput = () => {
  if (video.duration) {
    player.seek(Number(seek.value) * video.duration);
    draw();
  }
};
volume.oninput = () => {
  player.setVolume(Number(volume.value), false);
};
$("mute").onclick = () => {
  player.setVolume(video.volume, !video.muted);
};
$("loop").onclick = () => {
  player.setLoop(!player.looping);
  $("loop").classList.toggle("active", player.looping);
};
document.addEventListener("keydown", (e) => {
  if (exporting) return;
  if (/input|button/i.test((e.target as HTMLElement).tagName)) return;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === "s") {
    e.preventDefault();
    saveCurrent();
  } else if (e.ctrlKey && key === "z") {
    e.preventDefault();
    operations.pop();
    markChanged();
  } else if (e.code === "Space") {
    e.preventDefault();
    if (player.paused) void player.play();
    else player.pause();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepFrame(e.shiftKey ? -30 : -1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stepFrame(e.shiftKey ? 30 : 1);
  } else if (key === "r" || key === "l" || key === "b") {
    (
      document.querySelector(
        `[data-tool="${key === "r" ? "rect" : key === "l" ? "lasso" : "brush"}"]`,
      ) as HTMLButtonElement
    )?.click();
  } else if (key === "a" || key === "e") {
    (
      document.querySelector(
        `[data-mode="${key === "a" ? "add" : "subtract"}"]`,
      ) as HTMLButtonElement
    )?.click();
  } else if (key === "m")
    setPreviewMode(previewMode === "region" ? "mosaic" : "region");
});
window.onresize = draw;

// The video and overlay share one transform. Canvas backing pixels stay at
// fitted resolution, avoiding huge allocations when zooming to 800%.
function fitVideo() {
  const stage = $("stage");
  const next = fitSize(
    { width: stage.clientWidth, height: stage.clientHeight },
    (video.videoWidth || 16) / (video.videoHeight || 9),
  );
  if (fitted.width > 1) {
    view.x *= next.width / fitted.width;
    view.y *= next.height / fitted.height;
  }
  fitted = next;
  view = constrainView(view, fitted, {
    width: stage.clientWidth,
    height: stage.clientHeight,
  });
  const plane = $("videoPlane");
  plane.style.width = fitted.width + "px";
  plane.style.height = fitted.height + "px";
  plane.style.left = (stage.clientWidth - fitted.width) / 2 + view.x + "px";
  plane.style.top = (stage.clientHeight - fitted.height) / 2 + view.y + "px";
  plane.style.transform = "scale(" + view.zoom + ")";
  $("zoomValue").textContent = Math.round(view.zoom * 100) + "%";
  $("resetZoom").toggleAttribute("disabled", view.zoom === 1);
  syncBrushSizePreview();
}
function resetView() {
  view = { zoom: 1, x: 0, y: 0 };
  pan = null;
  $("stage").classList.remove("panning");
  $("brushCursor").classList.remove("visible");
  hideBrushSizePreview();
}
$("resetZoom").onclick = () => {
  resetView();
  draw();
};
$("stage").addEventListener(
  "wheel",
  (e) => {
    if (!current || !video.videoWidth) return;
    e.preventDefault();
    if (draft || pan) return;
    const stage = $("stage"),
      bounds = stage.getBoundingClientRect();
    const delta =
      e.deltaY *
      (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1);
    view = zoomAt(
      view,
      view.zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.002),
      {
        x: e.clientX - bounds.left - bounds.width / 2,
        y: e.clientY - bounds.top - bounds.height / 2,
      },
      fitted,
      { width: stage.clientWidth, height: stage.clientHeight },
    );
    draw();
    updateBrushCursor(e);
  },
  { passive: false },
);
// Middle drag navigates the enlarged frame without adding mask operations.
$("stage").addEventListener("pointerdown", (e) => {
  if (e.button !== 1 || !current || view.zoom === 1 || draft) return;
  e.preventDefault();
  pan = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    start: { ...view },
  };
  $("stage").setPointerCapture(e.pointerId);
  $("stage").classList.add("panning");
  $("brushCursor").classList.remove("visible");
});
$("stage").addEventListener("pointermove", (e) => {
  if (!pan || pan.pointerId !== e.pointerId) return;
  view = {
    ...view,
    x: pan.start.x + e.clientX - pan.x,
    y: pan.start.y + e.clientY - pan.y,
  };
  draw();
});
function endPan(e: PointerEvent) {
  if (pan?.pointerId !== e.pointerId) return;
  if ($("stage").hasPointerCapture(e.pointerId))
    $("stage").releasePointerCapture(e.pointerId);
  pan = null;
  $("stage").classList.remove("panning");
}
for (const event of [
  "pointerup",
  "pointercancel",
  "lostpointercapture",
] as const)
  $("stage").addEventListener(event, endPan);
$("stage").addEventListener("auxclick", (e) => {
  if (e.button === 1) e.preventDefault();
});
function setPreviewMode(mode: typeof previewMode) {
  previewMode = mode;
  $("rangeAppearance").toggleAttribute("disabled", mode !== "region");
  if (mode !== "region") closeAppearance();
  document
    .querySelectorAll<HTMLButtonElement>(".preview-mode")
    .forEach((button) => {
      const selected = button.dataset.preview === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  draw();
}
document
  .querySelectorAll<HTMLButtonElement>(".preview-mode")
  .forEach((button) => {
    button.onclick = () =>
      setPreviewMode(button.dataset.preview as typeof previewMode);
  });
document.querySelectorAll<HTMLButtonElement>(".speed").forEach((button) => {
  button.onclick = () => {
    playbackRate = Number(button.dataset.speed);
    player.setRate(playbackRate);
    document.querySelectorAll<HTMLButtonElement>(".speed").forEach((option) => {
      const selected = option === button;
      option.classList.toggle("active", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
  };
});
new ResizeObserver(() => {
  draw();
  updateBrushCursor();
}).observe($("stage"));
for (const selector of [
  ".tool",
  ".mode",
  ".filter",
  ".preview-mode",
  ".speed",
]) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(selector);
  const sync = () =>
    buttons.forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.classList.contains("active")),
      ),
    );
  buttons.forEach((button) =>
    button.addEventListener("click", () => {
      sync();
      updateBrushCursor();
    }),
  );
  sync();
}
for (const id of ["loop"]) {
  $(id).setAttribute("aria-pressed", "false");
  $(id).addEventListener("click", () =>
    $(id).setAttribute(
      "aria-pressed",
      String($(id).classList.contains("active")),
    ),
  );
}
$("loop").setAttribute("aria-label", "ループ再生");

$("seek").setAttribute("aria-label", "再生位置");
$("volume").setAttribute("aria-label", "音量");
$("play").setAttribute("aria-label", "再生");
$("state").setAttribute("role", "status");

function closeAppearance() {
  $("appearancePanel").hidden = true;
  $("rangeAppearance").setAttribute("aria-expanded", "false");
}
function syncAppearance() {
  document.documentElement.style.setProperty(
    "--range-color",
    "rgb(" + rangeColor.rgb + ")",
  );
  document.documentElement.style.setProperty(
    "--range-cursor-fill",
    "rgba(" + rangeColor.rgb + ",.12)",
  );
  $("rangeAppearance").setAttribute(
    "aria-label",
    "範囲の色と濃さ：" + rangeColor.label + "・" + rangeOpacity.label,
  );
  for (const [selector, value, key] of [
    [".range-color", rangeColor.id, "color"],
    [".range-opacity", rangeOpacity.id, "opacity"],
  ]) {
    document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      const selected = button.dataset[key] === value;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
}
function saveAppearance() {
  syncAppearance();
  draw();
  try {
    localStorage.setItem(
      "mosaic-range-appearance",
      JSON.stringify({ color: rangeColor.id, opacity: rangeOpacity.id }),
    );
  } catch {
    /* Keep working with session settings. */
  }
}
$("rangeAppearance").onclick = () => {
  const panel = $("appearancePanel");
  panel.hidden = !panel.hidden;
  $("rangeAppearance").setAttribute("aria-expanded", String(!panel.hidden));
};
document.querySelectorAll<HTMLButtonElement>(".range-color").forEach(
  (button) =>
    (button.onclick = () => {
      rangeColor = rangeColors.find((c) => c.id === button.dataset.color)!;
      saveAppearance();
    }),
);
document.querySelectorAll<HTMLButtonElement>(".range-opacity").forEach(
  (button) =>
    (button.onclick = () => {
      rangeOpacity = rangeOpacities.find(
        (o) => o.id === button.dataset.opacity,
      )!;
      saveAppearance();
    }),
);
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as Element).closest(".range-appearance"))
    closeAppearance();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("appearancePanel").hidden) {
    closeAppearance();
    $("rangeAppearance").focus();
  }
});
syncAppearance();

function syncBrushSizePreview() {
  if ($("brushSizePreview").hidden) return;
  const bounds = canvas.getBoundingClientRect();
  const diameter =
    Number(brushSize.value) * Math.max(bounds.width, bounds.height);
  const ring = $("brushPreviewRing");
  ring.style.width = diameter + "px";
  ring.style.height = diameter + "px";
  $("brushPreviewLabel").textContent =
    "ブラシの大きさ " +
    Math.round(Number(brushSize.value) * 100) +
    "%（画面上 約" +
    Math.round(diameter) +
    "px）";
}
function showBrushSizePreview() {
  if (tool !== "brush" || !current || !video.videoWidth) return;
  $("brushCursor").classList.remove("visible");
  $("brushSizePreview").hidden = false;
  syncBrushSizePreview();
}
function hideBrushSizePreview() {
  $("brushSizePreview").hidden = true;
}

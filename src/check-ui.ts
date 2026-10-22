// AI check dialog: Access login, sequential checks and the result list.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { runBatch } from "./batch-export";
import {
  formatTime,
  isAuthError,
  isCovered,
  sortResults,
  summarize,
} from "./check";
import { refreshIcons } from "./ui/icons";
import type {
  AuthInfo,
  CheckScope,
  CheckTarget,
  FileCheckResult,
  FrameResult,
  MaskOperation,
} from "./types";

export type CheckHost = {
  root(): string;
  /** Exporting or opening a folder; the check must not start meanwhile. */
  busy(): boolean;
  setChecking(checking: boolean): void;
  operationsFor(key: string): MaskOperation[];
  /** False when the clip is not in the editor's video list. */
  canOpen(key: string): boolean;
  openDetections(key: string, frame: FrameResult): Promise<void>;
  resultsChanged(results: ReadonlyMap<string, FileCheckResult>): void;
};

const API_KEY = "mosaic-check-api";
const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`#${id}`)!;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const verdictLabel = { ok: "OK", ng: "NG", error: "エラー" } as const;

export function setupCheckPanel(host: CheckHost) {
  const dialog = $("checkDialog") as HTMLDialogElement;
  const apiBase = $("apiBase") as HTMLInputElement;
  let auth: AuthInfo | null = null;
  let scope: CheckScope = "original";
  let checking = false,
    cancelled = false;
  let checkedRoot = "";
  let results: FileCheckResult[] = [];
  // Original-folder results by key, for badges in the video list.
  const byKey = new Map<string, FileCheckResult>();

  try {
    apiBase.value =
      localStorage.getItem(API_KEY) || import.meta.env.VITE_CHECK_API_URL || "";
  } catch {
    apiBase.value = import.meta.env.VITE_CHECK_API_URL || "";
  }

  function renderAuth() {
    const expires = auth?.expiresAt
      ? new Date(auth.expiresAt * 1000).toLocaleString()
      : "";
    $("authState").textContent = auth
      ? `${auth.email ?? "ログイン済み"}（${expires} まで）`
      : "未ログイン";
    $("login").hidden = !!auth;
    $("logout").hidden = !auth;
    apiBase.disabled = !!auth || checking;
    $("startCheck").toggleAttribute(
      "disabled",
      !auth || checking || !host.root(),
    );
  }

  async function refreshAuth() {
    auth = await invoke<AuthInfo | null>("auth_status").catch(() => null);
    renderAuth();
  }

  function renderResults() {
    const root = $("checkResults");
    if (!results.length) {
      root.innerHTML = `<p class="list-empty">${
        host.root()
          ? "判定結果はまだありません"
          : "先に動画フォルダを開いてください"
      }</p>`;
      $("checkSummary").hidden = true;
      return;
    }
    const summary = summarize(results, (r) =>
      r.source === "original" ? host.operationsFor(r.key) : [],
    );
    $("checkSummary").hidden = false;
    $("checkSummary").innerHTML =
      `<b class="verdict ng">NG ${summary.ng}</b><b class="verdict ok">OK ${summary.ok}</b><b class="verdict error">エラー ${summary.error}</b>` +
      `<span>未モザイク疑い ${summary.uncovered}件</span><span>判定 ${summary.frames}フレーム・入力 ${summary.inputTokens.toLocaleString()}トークン</span>`;
    root.innerHTML = sortResults(results)
      .map((result) => {
        const index = results.indexOf(result);
        const operations =
          result.source === "original" ? host.operationsFor(result.key) : [];
        const hitFrames = result.frames.filter((f) => f.detections.length);
        const uncovered = hitFrames.some((f) =>
          f.detections.some((d) => !isCovered(d, operations)),
        );
        const openable = result.kind === "video" && host.canOpen(result.key);
        const frames = result.frames
          .filter((f) => f.detections.length || f.error)
          .map((frame) => {
            const detections = frame.detections
              .map((d) => {
                const covered = isCovered(d, operations);
                return `<span class="detection ${covered ? "covered" : "uncovered"}">${escapeHtml(d.label)} ${Math.round(d.score * 100)}%・${covered ? "範囲指定済み" : "未モザイク疑い"}</span>`;
              })
              .join("");
            const error = frame.error
              ? `<span class="frame-error">${escapeHtml(frame.error)}</span>`
              : "";
            const jump =
              openable && frame.detections.length
                ? `<button class="quiet jump" data-result="${index}" data-frame="${frame.index}"><i data-lucide="crosshair"></i><span>編集画面で表示</span></button>`
                : "";
            return `<li><span class="frame-time">${formatTime(frame.time)}</span>${detections}${error}${jump}</li>`;
          })
          .join("");
        const preview =
          result.kind === "image" && hitFrames.length
            ? `<figure class="image-preview"><img src="${convertFileSrc(checkedPath(result))}" alt="" />${hitFrames[0].detections
                .map(
                  (d) =>
                    `<span class="${isCovered(d, operations) ? "covered" : "uncovered"}" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"></span>`,
                )
                .join("")}</figure>`
            : "";
        const detail =
          result.verdict === "ng"
            ? `NG ${hitFrames.length}/${result.frames.length}フレーム`
            : result.verdict === "error"
              ? "判定できないフレームがあります"
              : `${result.frames.length}フレーム検出なし`;
        return `<details class="check-row ${result.verdict}" ${result.verdict === "ok" ? "" : "open"}><summary><b class="verdict ${result.verdict}">${verdictLabel[result.verdict]}</b><span class="check-name" title="${escapeHtml(result.name)}">${escapeHtml(result.name)}</span><span class="check-detail">${detail}</span>${uncovered ? '<span class="suspect">未モザイク疑い</span>' : ""}</summary>${frames || preview ? `<ul>${frames}</ul>${preview}` : ""}</details>`;
      })
      .join("");
    root.querySelectorAll<HTMLButtonElement>(".jump").forEach((button) => {
      button.onclick = async () => {
        const result = results[Number(button.dataset.result)];
        const frame = result.frames.find(
          (f) => f.index === Number(button.dataset.frame),
        )!;
        dialog.close();
        await host.openDetections(result.key, frame);
      };
    });
    refreshIcons(root);
  }

  function checkedPath(result: FileCheckResult) {
    const base =
      result.source === "mosaic" ? checkedRoot + "/mosaic" : checkedRoot;
    return base + "/" + result.name;
  }

  function setChecking(busy: boolean) {
    checking = busy;
    host.setChecking(busy);
    $("cancelCheck").hidden = !busy;
    $("cancelCheck").removeAttribute("disabled");
    for (const button of document.querySelectorAll<HTMLButtonElement>(".scope"))
      button.disabled = busy;
    $("logout").toggleAttribute("disabled", busy);
    renderAuth();
  }

  async function start() {
    if (checking || host.busy() || !auth || !host.root()) return;
    const root = host.root();
    setChecking(true);
    cancelled = false;
    const meter = $("checkMeter") as HTMLProgressElement;
    meter.hidden = false;
    meter.value = 0;
    try {
      const targets = await invoke<CheckTarget[]>("list_check_targets", {
        root,
        scope,
      });
      checkedRoot = root;
      results = [];
      if (scope === "original") byKey.clear();
      renderResults();
      if (!targets.length) {
        $("checkStatus").textContent =
          scope === "mosaic"
            ? "mosaic フォルダに書き出し済みの動画がありません"
            : "判定できる画像・動画がありません";
        return;
      }
      meter.max = targets.length;
      let authFailed = "";
      const report = await runBatch(targets, {
        cancelled: () => cancelled || !!authFailed,
        progress: (done, total, item) => {
          meter.value = done;
          if (item)
            $("checkStatus").textContent =
              `判定 ${done + 1}/${total}：${item.name}`;
        },
        exportItem: async (target) => {
          try {
            const result = await invoke<FileCheckResult>("check_media", {
              root,
              scope,
              name: target.name,
            });
            results.push(result);
            if (scope === "original") byKey.set(result.key, result);
            renderResults();
            host.resultsChanged(byKey);
          } catch (error) {
            if (isAuthError(error)) authFailed = String(error);
            throw error;
          }
        },
      });
      for (const failure of report.failed)
        if (!isAuthError(failure.error))
          results.push({
            name: failure.item.name,
            kind: failure.item.kind,
            source: failure.item.source,
            key: failure.item.key,
            verdict: "error",
            frames: [
              { index: 0, time: null, detections: [], error: failure.error },
            ],
            model: "",
            inputTokens: 0,
          });
      renderResults();
      if (authFailed) {
        await refreshAuth();
        $("checkStatus").textContent =
          "ログインの有効期限が切れたため中断しました。ログインし直してください";
      } else {
        $("checkStatus").textContent =
          `判定完了：${report.completed.length}件` +
          (report.failed.length ? `・失敗 ${report.failed.length}件` : "") +
          (report.remaining ? `・中止 ${report.remaining}件` : "");
      }
    } catch (error) {
      $("checkStatus").textContent = "判定を開始できませんでした：" + error;
    } finally {
      meter.hidden = true;
      setChecking(false);
    }
  }

  $("openCheck").onclick = () => {
    renderResults();
    void refreshAuth();
    dialog.showModal();
  };
  $("closeCheck").onclick = () => dialog.close();
  $("login").onclick = async () => {
    $("login").setAttribute("disabled", "");
    $("authState").textContent = "ブラウザでログインしてください（5分以内）…";
    try {
      auth = await invoke<AuthInfo>("auth_login", { apiBase: apiBase.value });
      apiBase.value = auth.apiBase;
      try {
        localStorage.setItem(API_KEY, auth.apiBase);
      } catch {
        /* The URL can be typed again next time. */
      }
      renderAuth();
    } catch (error) {
      renderAuth();
      $("authState").textContent = "ログインできませんでした：" + error;
    } finally {
      $("login").removeAttribute("disabled");
    }
  };
  $("logout").onclick = async () => {
    await invoke("auth_logout");
    auth = null;
    renderAuth();
  };
  $("startCheck").onclick = start;
  $("cancelCheck").onclick = () => {
    cancelled = true;
    $("cancelCheck").setAttribute("disabled", "");
    $("checkStatus").textContent = "処理中のファイルの完了後に停止します";
  };
  document.querySelectorAll<HTMLButtonElement>(".scope").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scope));
    button.onclick = () => {
      scope = button.dataset.scope as CheckScope;
      document.querySelectorAll<HTMLButtonElement>(".scope").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-pressed", String(b === button));
      });
    };
  });
  // Escape would close the dialog mid-run; keep it open while checking.
  dialog.addEventListener("cancel", (event) => {
    if (checking) event.preventDefault();
  });

  return {
    /** Results belong to one folder; forget them when another is opened. */
    reset() {
      results = [];
      byKey.clear();
      host.resultsChanged(byKey);
      $("checkStatus").textContent = "";
      renderAuth();
    },
    get checking() {
      return checking;
    },
  };
}

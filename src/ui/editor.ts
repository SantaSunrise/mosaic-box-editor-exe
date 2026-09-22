import { rangeColors, rangeOpacities } from "../appearance";

export const editorTemplate = /* HTML */ ` <header>
    <div class="brand">
      <img src="/mosaic-icon.png" alt="" />
      <div>
        <span class="eyebrow">LOCAL VIDEO STUDIO</span>
        <h1>Mosaic Box Editor</h1>
      </div>
    </div>
    <button id="choose">
      <i data-lucide="folder-open"></i><span>動画フォルダを開く</span>
    </button>
  </header>
  <section class="workspace empty" id="workspace">
    <aside aria-label="動画ライブラリ">
      <div class="library-heading">
        動画ライブラリ<span>選択範囲の状態</span>
      </div>
      <div class="project" id="project">フォルダが選択されていません</div>
      <div class="filters" role="group" aria-label="動画の絞り込み">
        <button class="filter active" data-filter="all">
          すべて <b id="countAll">0</b></button
        ><button class="filter" data-filter="missing">
          未設定 <b id="countMissing">0</b></button
        ><button class="filter" data-filter="ready">
          設定済み <b id="countReady">0</b></button
        ><button class="filter" data-filter="exported">
          出力済み <b id="countExported">0</b></button
        ><button class="filter" data-filter="stale">
          更新あり <b id="countStale">0</b>
        </button>
      </div>
      <div id="videos" class="videos">
        <p class="list-empty">
          動画フォルダを開くと<br />中の動画がここに並びます
        </p>
      </div>
      <div class="batch-panel">
        <button
          id="exportBatch"
          disabled
          title="選択範囲が保存済みで、まだ出力していない動画が対象です"
        >
          <span>まとめて書き出す</span><b id="batchCount">0</b></button
        ><span class="batch-help">範囲保存済み・未出力のみ</span>
        <div id="batchProgress" hidden>
          <progress
            id="batchMeter"
            max="1"
            value="0"
            aria-label="一括書き出しの進捗"
          ></progress
          ><span id="batchStatus" role="status"></span
          ><button id="cancelBatch" class="quiet">残りを中止</button>
        </div>
        <details id="batchErrors" hidden>
          <summary>失敗した動画</summary>
          <ul id="batchErrorList"></ul>
        </details>
      </div>
    </aside>
    <article>
      <div class="editbar">
        <div class="tool-section">
          <span class="group-label">選択ツール</span>
          <div class="button-group" role="group" aria-label="選択ツール">
            <button class="tool active" data-tool="rect" title="矩形（R）">
              <i data-lucide="rectangle-horizontal"></i
              ><span>矩形</span></button
            ><button class="tool" data-tool="lasso" title="投げ縄（L）">
              <i data-lucide="lasso-select"></i><span>投げ縄</span></button
            ><button class="tool" data-tool="brush" title="ブラシ（B）">
              <i data-lucide="brush"></i><span>ブラシ</span>
            </button>
          </div>
        </div>
        <div class="tool-section">
          <span class="group-label">範囲</span>
          <div class="button-group" role="group" aria-label="範囲の編集方法">
            <button
              class="mode active add"
              data-mode="add"
              title="選択範囲に追加（A）"
            >
              <i data-lucide="plus"></i><span>追加</span></button
            ><button
              class="mode subtract"
              data-mode="subtract"
              title="選択範囲から消去（E）"
            >
              <i data-lucide="eraser"></i><span>消去</span>
            </button>
          </div>
        </div>
        <label class="brush-size"
          >太さ
          <input
            id="brushSize"
            type="range"
            min="0.005"
            max="0.15"
            step="0.005"
            value="0.04"
          /><span id="brushSizeValue">4%</span></label
        >
        <div class="edit-options">
          <label
            class="inherit"
            title="未設定の動画を開いたとき、直前の選択範囲をコピーします"
            ><input id="inherit" type="checkbox" role="switch" checked /><span
              class="switch-track"
              aria-hidden="true"
            ></span
            ><span>前の範囲を引き継ぐ</span></label
          ><button id="undo" class="quiet" disabled title="元に戻す（Ctrl+Z）">
            <i data-lucide="undo-2"></i><span>元に戻す</span></button
          ><button id="clear" class="quiet" disabled>
            <i data-lucide="trash-2"></i><span>すべて消す</span>
          </button>
        </div>
      </div>
      <div class="stage" id="stage">
        <div class="video-plane" id="videoPlane">
          <video id="video" playsinline></video
          ><canvas id="overlay" aria-label="動画のモザイク範囲を選択"></canvas>
        </div>
        <div id="brushCursor"></div>
        <div
          id="brushSizePreview"
          class="brush-size-preview"
          aria-hidden="true"
          hidden
        >
          <span id="brushPreviewRing" class="brush-preview-ring"></span
          ><span id="brushPreviewLabel" class="brush-preview-label"></span>
        </div>
        <button
          class="placeholder drop-zone"
          id="dropZone"
          aria-label="動画が入ったフォルダを開く"
        >
          <strong id="dropTitle">3つのステップで、動画にモザイク</strong
          ><span id="dropDescription"
            >動画ファイルではなく、動画が入ったフォルダを選んで始めます。</span
          ><span class="workflow-steps"
            ><span class="workflow-step"
              ><b class="workflow-heading"
                ><i data-lucide="folder-open"></i><span>フォルダを選択</span></b
              ><span>中の動画が左側に一覧表示されます。</span></span
            ><i class="workflow-arrow" data-lucide="arrow-right"></i
            ><span class="workflow-step"
              ><b class="workflow-heading"
                ><i data-lucide="scan-line"></i
                ><span>モザイク範囲を指定</span></b
              ><span
                >動画を選んで範囲を指定。範囲は自動保存されます。</span
              ></span
            ><i class="workflow-arrow" data-lucide="arrow-right"></i
            ><span class="workflow-step"
              ><b class="workflow-heading"
                ><i data-lucide="download"></i><span>動画を書き出す</span></b
              ><span
                >選んだフォルダ内の <code>mosaic</code> に保存されます。</span
              ></span
            ></span
          ><span class="drop-action"
            >ここにフォルダをドロップ ／ クリックして選ぶ</span
          ><span class="drop-formats"
            >MP4・MOV・WebM ／ サブフォルダ内の動画にも対応</span
          >
        </button>
        <div class="drop-overlay" aria-hidden="true">
          <i data-lucide="folder-open"></i
          ><strong>フォルダをドロップして開く</strong
          ><span>中の動画を一覧に読み込みます</span>
        </div>
      </div>
      <div class="playback-panel">
        <div class="view-controls">
          <div class="tool-section">
            <span class="control-label">表示</span>
            <div
              class="button-group compact-group"
              role="group"
              aria-label="表示モード"
            >
              <button
                class="preview-mode active"
                data-preview="region"
                title="選択範囲を表示（Mで切り替え）"
              >
                <i data-lucide="scan-line"></i><span>選択範囲</span></button
              ><button
                class="preview-mode"
                data-preview="mosaic"
                title="モザイクを表示（Mで切り替え）"
              >
                <i data-lucide="grid-2-x-2"></i><span>モザイク</span>
              </button>
            </div>
          </div>
          <div class="tool-section">
            <span class="control-label">速度</span>
            <div
              class="button-group compact-group speed-group"
              role="group"
              aria-label="再生速度"
            >
              ${[0.5, 0.75, 1, 1.5, 2]
                .map(
                  (rate) =>
                    `<button class="speed ${rate === 1 ? "active" : ""}" data-speed="${rate}" aria-label="再生速度 ${rate.toFixed(2)}倍">×${rate.toFixed(2)}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="range-appearance">
            <button
              id="rangeAppearance"
              class="quiet appearance-trigger"
              aria-expanded="false"
              aria-controls="appearancePanel"
              title="選択範囲の色と濃さ"
            >
              <i data-lucide="palette"></i
              ><span class="appearance-swatch" aria-hidden="true"></span
              ><span class="appearance-label">範囲の色</span>
            </button>
            <div
              id="appearancePanel"
              class="appearance-panel"
              role="group"
              aria-label="範囲表示の設定"
              hidden
            >
              <span class="appearance-heading">範囲表示の色と濃さ</span>
              <div
                class="button-group compact-group color-group"
                role="group"
                aria-label="範囲の色"
              >
                ${rangeColors
                  .map(
                    (c) =>
                      `<button class="range-color" data-color="${c.id}" title="${c.label}" aria-label="範囲の色：${c.label}"><span class="color-swatch" style="background:rgb(${c.rgb})" aria-hidden="true"></span>${c.label}</button>`,
                  )
                  .join("")}
              </div>
              <div
                class="button-group compact-group opacity-group"
                role="group"
                aria-label="範囲の濃さ"
              >
                ${rangeOpacities
                  .map(
                    (o) =>
                      `<button class="range-opacity" data-opacity="${o.id}" aria-label="範囲の濃さ：${o.label}">${o.label}</button>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
          <button
            id="resetZoom"
            class="zoom-reset quiet"
            title="全体を表示（ホイールで拡大縮小・中ボタンドラッグで移動）"
            aria-label="ズームをリセット"
            disabled
          >
            <i data-lucide="search"></i><span id="zoomValue">100%</span
            ><span class="zoom-fit-label">全体表示</span>
          </button>
        </div>
        <div class="transport">
          <button id="play" class="transport-button">
            <i data-lucide="play"></i><span>再生</span></button
          ><button
            id="frameBack"
            class="icon-button"
            title="1フレーム戻る"
            aria-label="1フレーム戻る"
          >
            <i data-lucide="step-back"></i></button
          ><button
            id="frameNext"
            class="icon-button"
            title="1フレーム進む"
            aria-label="1フレーム進む"
          >
            <i data-lucide="step-forward"></i></button
          ><span id="time">0:00 / 0:00</span
          ><input
            id="seek"
            class="seek"
            type="range"
            min="0"
            max="1"
            step="0.001"
            value="0"
          /><button
            id="mute"
            class="icon-button"
            title="ミュート"
            aria-label="ミュート"
          >
            <i data-lucide="volume-2"></i></button
          ><input
            id="volume"
            class="volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value="1"
          /><button id="loop" class="toggle-button">
            <i data-lucide="repeat-2"></i><span>ループ</span>
          </button>
        </div>
      </div>
      <footer>
        <span id="state">動画フォルダを開いて編集を開始</span
        ><button id="saveSelection" class="quiet" disabled>
          <i data-lucide="save"></i><span>選択範囲を保存</span></button
        ><button id="saveNext" class="quiet" disabled>
          <i data-lucide="step-forward"></i><span>保存して次へ</span></button
        ><button id="exportVideo" class="primary" disabled>
          <i data-lucide="wand-sparkles"></i><span>モザイク動画を書き出す</span>
        </button>
      </footer>
    </article>
  </section>`;

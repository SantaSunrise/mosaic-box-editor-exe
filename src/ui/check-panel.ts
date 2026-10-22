export const checkPanelTemplate = /* HTML */ `<dialog
  id="checkDialog"
  class="check-dialog"
  aria-labelledby="checkTitle"
>
  <div class="check-head">
    <div>
      <span class="eyebrow">AI CHECK</span>
      <h2 id="checkTitle">モザイク漏れのAI判定</h2>
    </div>
    <button id="closeCheck" class="icon-button quiet" aria-label="閉じる">
      <i data-lucide="x"></i>
    </button>
  </div>
  <section class="check-auth" aria-label="ログイン">
    <label class="api-field"
      >判定API
      <input
        id="apiBase"
        type="url"
        spellcheck="false"
        placeholder="https://mosaic-check.example.com"
    /></label>
    <button id="login"><i data-lucide="log-in"></i><span>ログイン</span></button
    ><button id="logout" class="quiet" hidden>
      <i data-lucide="log-out"></i><span>ログアウト</span>
    </button>
    <span id="authState" class="auth-state">未ログイン</span>
  </section>
  <section class="check-run" aria-label="判定の実行">
    <div class="button-group compact-group" role="group" aria-label="判定対象">
      <button class="scope active" data-scope="original">元の画像・動画</button
      ><button class="scope" data-scope="mosaic">書き出し済み（mosaic）</button>
    </div>
    <button id="startCheck" class="primary" disabled>
      <i data-lucide="scan-search"></i><span>判定を開始</span></button
    ><button id="cancelCheck" class="quiet" hidden>残りを中止</button>
    <progress
      id="checkMeter"
      max="1"
      value="0"
      aria-label="判定の進捗"
      hidden
    ></progress>
    <span id="checkStatus" class="check-status" role="status"></span>
  </section>
  <p class="check-rule">
    動画は均等な10フレーム、画像は1枚を判定します。1フレームでも検出されたらNGです。
    赤い点線は保存済みの範囲の外にある検出（未モザイク疑い）です。
  </p>
  <div id="checkSummary" class="check-summary" hidden></div>
  <div id="checkResults" class="check-results">
    <p class="list-empty">ログインしてから判定を開始してください</p>
  </div>
</dialog>`;

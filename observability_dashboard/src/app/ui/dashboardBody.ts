export function buildDashboardBody(effectiveRefreshSeconds: number): string {
  return `
    <header>
      <h1>EEG Data Platform — Observability</h1>
      <div class="stats">
        <div>更新間隔: <strong id="refresh-interval">${effectiveRefreshSeconds}秒</strong></div>
        <div>最終更新: <strong id="last-updated">同期中…</strong></div>
      </div>
    </header>
    <main class="layout">
      <section class="panel span-2" id="graph-panel">
        <div class="panel-header">
          <h2>データフロー・ライブマップ</h2>
          <span class="meta" id="graph-meta">同期中…</span>
        </div>
        <div class="graph-wrapper" id="graph-shell">
          <svg id="graph"></svg>
        </div>
        <div class="legend">
          <span data-kind="gateway">ゲートウェイ</span>
          <span data-kind="service">サービス</span>
          <span data-kind="broker">ブローカー</span>
          <span data-kind="queue">キュー</span>
          <span data-kind="database">DB</span>
          <span data-kind="storage">ストレージ</span>
        </div>
        <div class="graph-meta">
          <span id="graph-status">リンク強調のためにノードを選択してください</span>
          <span id="graph-summary"></span>
        </div>
      </section>
      <section class="panel" id="service-panel">
        <div class="panel-header">
          <div>
            <h2>システムステータス</h2>
            <p class="panel-subtitle">RabbitMQ・PostgreSQL・MinIO・各サービスの稼働状況を俯瞰</p>
          </div>
        </div>
        <div class="metrics-grid" id="system-overview">
          <div class="metric-card" data-kind="rabbitmq">
            <h4>RabbitMQ</h4>
            <div class="metric-value" id="rabbit-status">同期中…</div>
            <div class="metric-meta" id="rabbit-meta">管理APIの接続状態を取得しています</div>
          </div>
          <div class="metric-card" data-kind="postgres">
            <h4>PostgreSQL</h4>
            <div class="metric-value" id="postgres-status">同期中…</div>
            <div class="metric-meta" id="postgres-meta">バージョンおよび応答時間を取得しています</div>
          </div>
          <div class="metric-card" data-kind="minio">
            <h4>MinIO</h4>
            <div class="metric-value" id="minio-status">同期中…</div>
            <div class="metric-meta" id="minio-meta">バケット状況を取得しています</div>
          </div>
        </div>
        <div>
          <h3 class="muted" style="margin: 8px 0 6px">キューの健全性</h3>
          <div class="queue-grid" id="queue-metrics"></div>
        </div>
        <div>
          <h3 class="muted" style="margin: 12px 0 6px">サービス一覧</h3>
          <ul class="service-list" id="service-list"></ul>
        </div>
      </section>
      <section class="panel" id="selection-panel">
        <div class="panel-header">
          <div>
            <h2 id="selection-title">ノード詳細</h2>
            <p class="panel-subtitle" id="selection-subtitle">左のグラフまたはサービス一覧からノードを選択してください</p>
          </div>
          <span class="status-pill status-unknown" id="selection-status">未選択</span>
        </div>
        <div class="detail-body" id="selection-body">
          <p class="muted">ノードを選択すると、データフローや直近のメトリクスを表示します。</p>
        </div>
      </section>
      <section class="panel span-2">
        <div class="split-panel">
          <div class="card">
            <h3>エクスポートタスクの進行状況</h3>
            <div class="tasks-grid" id="tasks-list">
              <p class="muted">同期中…</p>
            </div>
            <p class="muted" id="tasks-summary"></p>
          </div>
          <div class="card">
            <h3>MinIO バケット概況</h3>
            <div class="storage-grid" id="storage-grid">
              <p class="muted">同期中…</p>
            </div>
            <p class="muted" id="buckets-summary"></p>
          </div>
        </div>
      </section>
      <section class="panel span-2" id="database-panel">
        <div class="panel-header">
          <div>
            <h2>データベースエクスプローラ</h2>
            <p class="panel-subtitle">
              監査者はブラウザからテーブルメタデータと最新レコードのスナップショットを確認できます。機密データを扱うため、閲覧時はアクセス権限に注意してください。
            </p>
          </div>
          <span class="status-pill status-ok" style="display: none" id="table-refresh-status">OK</span>
        </div>
        <div class="table-explorer">
          <div class="table-pane">
            <div class="search-row">
              <input type="search" id="table-search" placeholder="テーブル名・スキーマでフィルタ" autocomplete="off" />
              <label class="muted" style="display: flex; align-items: center; gap: 6px">
                サンプル件数
                <select id="table-limit">
                  <option value="25">25</option>
                  <option value="50" selected>50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                </select>
              </label>
            </div>
            <div class="table-wrapper">
              <table id="db-table-list">
                <thead>
                  <tr>
                    <th>スキーマ</th>
                    <th>テーブル</th>
                    <th>推定行数</th>
                    <th>サイズ</th>
                    <th>最終 ANALYZE</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
            <p class="muted" id="tables-summary">同期中…</p>
          </div>
          <div class="table-pane">
            <div class="panel-header">
              <div>
                <h3 id="table-detail-title">テーブル詳細</h3>
                <p class="panel-subtitle" id="table-detail-meta">テーブルを選択すると列定義とサンプルを表示します</p>
              </div>
            </div>
            <div class="detail-body" id="table-detail-body">
              <p class="muted">左の一覧からテーブルを選択してください。</p>
            </div>
          </div>
        </div>
      </section>
    </main>
    <footer>
      このダッシュボードは ${effectiveRefreshSeconds} 秒ごとに自動更新され、EEG データパイプラインのリアルタイムな流れと保存データの中身を可視化します。
    </footer>
    <div id="tooltip" class="tooltip hidden"></div>
  `;
}

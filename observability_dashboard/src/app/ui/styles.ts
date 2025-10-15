export const dashboardStyles = `
      :root {
        color-scheme: dark;
        font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        --bg: #050c1d;
        --panel: #101a33;
        --panel-alt: #1a2849;
        --panel-glass: rgba(23, 33, 64, 0.75);
        --border: rgba(94, 114, 179, 0.2);
        --text: #e2e8f0;
        --muted: #94a3b8;
        --muted-strong: #cbd5f5;
        --ok: #22c55e;
        --degraded: #fbbf24;
        --error: #f87171;
        --unknown: #64748b;
        --accent: #38bdf8;
        --accent-strong: #60a5fa;
        --edge-http: rgba(96, 165, 250, 0.65);
        --edge-queue: rgba(250, 204, 21, 0.65);
        --edge-storage: rgba(52, 211, 153, 0.65);
        --edge-database: rgba(248, 113, 113, 0.65);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background: radial-gradient(circle at 20% -10%, #1d2b4d, var(--bg) 55%);
        color: var(--text);
      }
      header {
        padding: 28px 40px 12px;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 24px;
        flex-wrap: wrap;
      }
      header h1 {
        margin: 0;
        font-size: 2rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      header .stats {
        display: flex;
        gap: 18px;
        flex-wrap: wrap;
        font-size: 0.95rem;
        color: var(--muted);
        align-items: center;
      }
      header .stats strong {
        font-weight: 600;
        color: var(--muted-strong);
      }
      main.layout {
        flex: 1;
        display: grid;
        grid-template-columns: minmax(0, 2.4fr) minmax(0, 1.6fr);
        gap: 24px;
        padding: 0 40px 40px;
        align-content: start;
      }
      section.panel {
        background: linear-gradient(145deg, rgba(19, 31, 59, 0.95), rgba(9, 16, 33, 0.92));
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        box-shadow: 0 24px 45px rgba(2, 8, 23, 0.55);
        position: relative;
        overflow: hidden;
      }
      section.panel::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: linear-gradient(160deg, rgba(56, 189, 248, 0.08), transparent 45%);
        pointer-events: none;
      }
      section.panel > * {
        position: relative;
        z-index: 1;
      }
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      .panel-header h2,
      .panel-header h3 {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .panel-header .meta {
        font-size: 0.85rem;
        color: var(--muted);
      }
      .panel-subtitle {
        margin: 4px 0 0;
        font-size: 0.85rem;
        color: var(--muted);
        line-height: 1.4;
      }
      .legend {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .legend span::before {
        content: '';
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }
      .legend span[data-kind='gateway']::before {
        background: var(--accent);
      }
      .legend span[data-kind='service']::before {
        background: #a855f7;
      }
      .legend span[data-kind='broker']::before {
        background: var(--edge-queue);
      }
      .legend span[data-kind='queue']::before {
        background: #f97316;
      }
      .legend span[data-kind='database']::before {
        background: var(--edge-database);
      }
      .legend span[data-kind='storage']::before {
        background: var(--edge-storage);
      }
      .graph-wrapper {
        position: relative;
        width: 100%;
        aspect-ratio: 3 / 1;
        min-height: 360px;
        max-height: 560px;
        background: rgba(10, 17, 36, 0.75);
        border-radius: 16px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        overflow: hidden;
      }
      #graph {
        width: 100%;
        height: 100%;
        display: block;
      }
      .graph-meta {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        font-size: 0.82rem;
        color: var(--muted);
        flex-wrap: wrap;
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      .metric-card {
        background: var(--panel-glass);
        border: 1px solid rgba(71, 85, 105, 0.35);
        border-radius: 12px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .metric-card h4 {
        margin: 0;
        font-size: 0.9rem;
        font-weight: 600;
      }
      .metric-value {
        font-size: 1.35rem;
        font-weight: 600;
        color: var(--muted-strong);
      }
      .metric-meta {
        font-size: 0.75rem;
        color: var(--muted);
        line-height: 1.35;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        font-weight: 600;
        text-transform: uppercase;
      }
      .status-pill.status-ok {
        background: rgba(34, 197, 94, 0.12);
        color: var(--ok);
      }
      .status-pill.status-degraded {
        background: rgba(251, 191, 36, 0.14);
        color: var(--degraded);
      }
      .status-pill.status-error {
        background: rgba(248, 113, 113, 0.14);
        color: var(--error);
      }
      .status-pill.status-unknown {
        background: rgba(100, 116, 139, 0.14);
        color: var(--unknown);
      }
      .service-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .service-item {
        background: var(--panel-glass);
        border: 1px solid rgba(71, 85, 105, 0.25);
        border-radius: 12px;
        padding: 12px 14px;
        text-align: left;
        color: inherit;
        display: flex;
        flex-direction: column;
        gap: 8px;
        cursor: pointer;
        transition: border-color 0.2s ease, transform 0.2s ease;
      }
      .service-item:hover,
      .service-item:focus-visible {
        border-color: rgba(96, 165, 250, 0.6);
        outline: none;
        transform: translateY(-1px);
      }
      .service-item.selected {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.35);
      }
      .service-item-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .service-label {
        font-size: 0.95rem;
        font-weight: 600;
      }
      .service-description {
        font-size: 0.8rem;
        color: var(--muted);
        line-height: 1.4;
      }
      .service-meta {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .queue-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .queue-card {
        background: rgba(251, 191, 36, 0.08);
        border: 1px solid rgba(251, 191, 36, 0.25);
        border-radius: 12px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        cursor: pointer;
        transition: border-color 0.2s ease;
      }
      .queue-card:hover {
        border-color: rgba(251, 191, 36, 0.45);
      }
      .queue-name {
        font-size: 0.88rem;
        font-weight: 600;
      }
      .queue-metric {
        font-size: 0.75rem;
        color: var(--muted);
        display: flex;
        justify-content: space-between;
      }
      .detail-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-size: 0.82rem;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .detail-card {
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 12px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .detail-card strong {
        font-size: 0.75rem;
        color: var(--muted);
        letter-spacing: 0.05em;
      }
      .detail-card span {
        font-size: 0.9rem;
      }
      .flow-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 0.78rem;
      }
      .flow-list-item {
        border-left: 2px solid rgba(148, 163, 184, 0.3);
        padding-left: 8px;
        color: var(--muted);
      }
      .flow-list-item strong {
        color: var(--muted-strong);
      }
      .split-panel {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 18px;
      }
      .card {
        background: rgba(15, 23, 42, 0.55);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 14px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .card h3 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .tasks-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
      }
      .task-card {
        background: rgba(30, 41, 59, 0.55);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .task-card strong {
        font-size: 0.85rem;
      }
      .muted {
        color: var(--muted);
        font-size: 0.8rem;
      }
      .error {
        color: var(--error);
        font-size: 0.85rem;
      }
      .progress-bar {
        position: relative;
        height: 6px;
        background: rgba(148, 163, 184, 0.18);
        border-radius: 999px;
        overflow: hidden;
      }
      .progress-bar span {
        display: block;
        height: 100%;
        background: linear-gradient(135deg, var(--accent), rgba(129, 140, 248, 0.85));
      }
      .storage-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      .table-explorer {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
        gap: 18px;
      }
      .table-pane {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .table-wrapper {
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 12px;
        max-height: 320px;
        overflow: auto;
        max-width: 100%;
      }
      table {
        width: 100%;
        min-width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
      }
      thead {
        background: rgba(148, 163, 184, 0.08);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      th,
      td {
        padding: 8px 10px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
        text-align: left;
        white-space: nowrap;
      }
      tbody tr:hover {
        background: rgba(56, 189, 248, 0.08);
      }
      tbody tr.selected {
        background: rgba(56, 189, 248, 0.15);
      }
      .data-grid {
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 12px;
        overflow: auto;
        max-width: 100%;
      }
      .data-grid table {
        min-width: 720px;
      }
      .data-grid tbody tr:nth-child(odd) {
        background: rgba(15, 23, 42, 0.35);
      }
      .search-row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      input[type='search'],
      select {
        background: rgba(15, 23, 42, 0.75);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 10px;
        padding: 8px 10px;
        color: var(--text);
        font-size: 0.85rem;
      }
      input[type='search']:focus,
      select:focus {
        outline: none;
        border-color: rgba(96, 165, 250, 0.6);
      }
      footer {
        padding: 18px 40px;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .tooltip {
        position: fixed;
        pointer-events: none;
        background: rgba(10, 16, 33, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 0.75rem;
        color: var(--text);
        box-shadow: 0 12px 32px rgba(2, 8, 23, 0.5);
        max-width: 280px;
        line-height: 1.5;
        z-index: 9999;
      }
      .tooltip.hidden {
        display: none;
      }
      .span-2 {
        grid-column: span 2;
      }
      svg .node-circle {
        transition: stroke 0.25s ease, r 0.25s ease, filter 0.25s ease, opacity 0.25s ease;
        stroke-width: 2;
      }
      svg .node-circle.status-ok {
        stroke: rgba(34, 197, 94, 0.65);
        fill: rgba(34, 197, 94, 0.18);
      }
      svg .node-circle.status-degraded {
        stroke: rgba(251, 191, 36, 0.65);
        fill: rgba(251, 191, 36, 0.15);
      }
      svg .node-circle.status-error {
        stroke: rgba(248, 113, 113, 0.75);
        fill: rgba(248, 113, 113, 0.2);
      }
      svg .node-circle.status-unknown {
        stroke: rgba(100, 116, 139, 0.6);
        fill: rgba(100, 116, 139, 0.18);
      }
      svg .node-circle.kind-gateway {
        fill: rgba(56, 189, 248, 0.16);
      }
      svg .node-group.hovered .node-circle {
        stroke-width: 3.2;
        filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.55));
      }
      svg .node-group.dimmed .node-circle {
        opacity: 0.35;
      }
      svg .node-label {
        fill: var(--text);
        font-size: 0.78rem;
        text-anchor: middle;
        pointer-events: none;
        font-weight: 600;
        transition: opacity 0.25s ease;
      }
      svg .node-description {
        fill: var(--muted);
        font-size: 0.65rem;
        text-anchor: middle;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }
      svg .node-group.dimmed .node-label,
      svg .node-group.dimmed .node-description {
        opacity: 0.45;
      }
      svg .node-group.hovered .node-label {
        opacity: 1;
      }
      svg .flow-path {
        fill: none;
        stroke: rgba(148, 163, 184, 0.4);
        stroke-linecap: round;
        marker-end: url(#arrowhead);
        stroke-dasharray: 10 18;
        animation: flow var(--flow-speed, 4s) linear infinite;
        transition: stroke-width 0.3s ease, stroke 0.3s ease, opacity 0.3s ease, filter 0.3s ease;
        stroke-width: var(--base-width, 2.2);
      }
      svg .flow-path.kind-http {
        stroke: var(--edge-http);
      }
      svg .flow-path.kind-queue {
        stroke: var(--edge-queue);
      }
      svg .flow-path.kind-database {
        stroke: var(--edge-database);
      }
      svg .flow-path.kind-storage {
        stroke: var(--edge-storage);
      }
      svg .flow-path.has-traffic {
        stroke-dasharray: 2 12;
        filter: drop-shadow(0 0 10px rgba(96, 165, 250, 0.55));
        animation: activeFlow var(--flow-speed, 2s) linear infinite;
      }
      svg .flow-path.highlight,
      svg .flow-path.hovered {
        opacity: 1;
        stroke-width: calc(var(--base-width, 2.2) + 1.4);
      }
      svg .flow-path.dimmed {
        opacity: 0.25;
        filter: none;
      }
      svg .flow-pulse {
        fill: var(--accent-strong);
        opacity: 0.9;
        transition: opacity 0.3s ease, r 0.3s ease;
        pointer-events: none;
      }
      svg .flow-pulse.kind-queue {
        fill: rgba(251, 191, 36, 0.9);
      }
      svg .flow-pulse.kind-database {
        fill: rgba(248, 113, 113, 0.9);
      }
      svg .flow-pulse.kind-storage {
        fill: rgba(52, 211, 153, 0.95);
      }
      svg .flow-pulse.hovered,
      svg .flow-pulse.highlight {
        opacity: 1;
        r: 5;
      }
      svg .flow-pulse.dimmed {
        opacity: 0.25;
      }
      svg .node-group.selected .node-circle {
        stroke-width: 3.5;
        r: calc(var(--node-radius, 30) + 2);
      }
      @keyframes flow {
        from {
          stroke-dashoffset: 0;
        }
        to {
          stroke-dashoffset: -36;
        }
      }
      @keyframes activeFlow {
        from {
          stroke-dashoffset: 0;
        }
        to {
          stroke-dashoffset: -60;
        }
      }
      @media (max-width: 1320px) {
        main.layout {
          grid-template-columns: 1fr;
        }
        .span-2 {
          grid-column: span 1;
        }
        .table-explorer {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 720px) {
        header {
          padding: 24px 24px 14px;
        }
        main.layout {
          padding: 0 24px 28px;
        }
        footer {
          padding: 16px 24px;
        }
        .graph-wrapper {
          aspect-ratio: 2.2 / 1;
          min-height: 320px;
        }
      }
`;

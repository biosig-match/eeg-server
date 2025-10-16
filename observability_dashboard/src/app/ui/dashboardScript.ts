export function buildDashboardScript(effectiveRefreshMs: number): string {
  return `
      const REFRESH_INTERVAL = ${effectiveRefreshMs};
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const XLINK_NS = 'http://www.w3.org/1999/xlink';
      const KIND_ORDER = ['gateway', 'broker', 'database', 'service', 'queue', 'storage'];
      const KIND_LABELS = {
        gateway: 'ゲートウェイ層',
        broker: 'メッセージブローカー層',
        database: 'データベース層',
        service: 'アプリサービス層',
        queue: 'キュー層',
        storage: 'ストレージ層',
      };
      const GRID_LAYOUT = {
        columnGap: 1220,
        rowGap: 420,
        marginX: 420,
        marginY: 220,
        minWidth: 1920,
        minHeight: 1040,
        relaxPasses: 3,
        maxColumnsPerRow: 5,
        labelColumnWidth: 240,
      };
      const layoutRuntime = {
        columnGap: GRID_LAYOUT.columnGap,
        rowGap: GRID_LAYOUT.rowGap,
        marginX: GRID_LAYOUT.marginX,
        marginY: GRID_LAYOUT.marginY,
        labelColumnWidth: GRID_LAYOUT.labelColumnWidth,
        maxColumnsPerRow: GRID_LAYOUT.maxColumnsPerRow,
      };
      const NODE_DIMENSIONS = {
        gateway: { width: 864, height: 360 },
        broker: { width: 864, height: 360 },
        database: { width: 884, height: 372 },
        service: { width: 912, height: 380 },
        queue: { width: 872, height: 364 },
        storage: { width: 884, height: 372 },
      };
      const NODE_DEFAULT_DIMENSIONS = { width: 876, height: 368 };
      const TITLE_TEXT_PADDING = 196;
      const TITLE_AVG_CHAR_WIDTH = 15.8;
      const SUBTITLE_LEFT_PADDING = 32;
      const SUBTITLE_RIGHT_PADDING = 224;
      const SUBTITLE_AVG_CHAR_WIDTH = 30.5;
      const SUBTITLE_VERTICAL_PADDING = 64;
      const EDGE_START_OUTSET = 0;
      const EDGE_END_PADDING = 0;
      const LANE_SPACING = 52;
      const LANE_LIMIT_MARGIN = 72;
      const EDGE_CLEARANCE = 128;
      const TURN_MIN_DISTANCE = 96;
      const WALKWAY_EXTENSION_SLOTS = 1;
      const ALIGN_TOLERANCE = 4;

      const state = {
        snapshot: null,
        selectedNodeId: null,
        graphElements: { nodes: new Map(), edges: new Map(), pulses: new Map() },
        tables: [],
        filteredTables: [],
        tableSelection: null,
        tableLimit: 50,
        tableCache: new Map(),
        history: new Map(),
      };

      const tooltip = document.getElementById('tooltip');

      const serviceList = document.getElementById('service-list');
      const queueMetrics = document.getElementById('queue-metrics');
      const systemOverview = document.getElementById('system-overview');
      const selectionTitle = document.getElementById('selection-title');
      const selectionSubtitle = document.getElementById('selection-subtitle');
      const selectionStatus = document.getElementById('selection-status');
      const selectionBody = document.getElementById('selection-body');
      const graphMeta = document.getElementById('graph-meta');
      const graphStatus = document.getElementById('graph-status');
      const graphSummary = document.getElementById('graph-summary');
      const tableSearch = document.getElementById('table-search');
      const tableLimitSelect = document.getElementById('table-limit');
      const tableListBody = document.querySelector('#db-table-list tbody');
      const tablesSummary = document.getElementById('tables-summary');
      const tableDetailTitle = document.getElementById('table-detail-title');
      const tableDetailMeta = document.getElementById('table-detail-meta');
      const tableDetailBody = document.getElementById('table-detail-body');
      const lastUpdated = document.getElementById('last-updated');
      const graphSvg = document.getElementById('graph');
      const graphShell = document.getElementById('graph-shell');
      const tasksList = document.getElementById('tasks-list');
      const tasksSummary = document.getElementById('tasks-summary');
      const storageGrid = document.getElementById('storage-grid');
      const bucketsSummary = document.getElementById('buckets-summary');

      function statusClass(level) {
        switch (level) {
          case 'ok':
            return 'status-ok';
          case 'degraded':
            return 'status-degraded';
          case 'error':
            return 'status-error';
          default:
            return 'status-unknown';
        }
      }

      function statusLabel(level) {
        switch (level) {
          case 'ok':
            return '正常';
          case 'degraded':
            return '注意';
          case 'error':
            return '障害';
          default:
            return '不明';
        }
      }

      function formatDate(isoString) {
        if (!isoString) return '—';
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return isoString;
        return date.toLocaleString();
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '—';
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
      }

      function formatNumber(value) {
        if (value === null || value === undefined) return '—';
        if (typeof value === 'number') return value.toLocaleString();
        return String(value);
      }

      function setGraphMeta(text) {
        if (graphMeta) graphMeta.textContent = text;
      }

      function showTooltip(html, event) {
        if (!(tooltip instanceof HTMLDivElement)) return;
        tooltip.classList.remove('hidden');
        tooltip.innerHTML = html;
        updateTooltipPosition(event);
      }

      function hideTooltip() {
        if (!(tooltip instanceof HTMLDivElement)) return;
        tooltip.classList.add('hidden');
      }

      function updateTooltipPosition(event) {
        if (!(tooltip instanceof HTMLDivElement)) return;
        const offset = 18;
        tooltip.style.left = String(event.pageX + offset) + 'px';
        tooltip.style.top = String(event.pageY + offset) + 'px';
      }

      function nodeDimensions(kind) {
        return NODE_DIMENSIONS[kind] ?? NODE_DEFAULT_DIMENSIONS;
      }

      function clearGraph() {
        if (!(graphSvg instanceof SVGElement)) return;
        while (graphSvg.firstChild) {
          graphSvg.removeChild(graphSvg.firstChild);
        }
        state.graphElements.nodes = new Map();
        state.graphElements.edges = new Map();
        state.graphElements.pulses = new Map();
      }

      function showGraphError(message) {
        clearGraph();
        if (!(graphSvg instanceof SVGElement)) return;
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', '50%');
        text.setAttribute('y', '50%');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#f87171');
        text.setAttribute('font-size', '16');
        text.setAttribute('font-weight', '600');
        text.textContent = message;
        graphSvg.appendChild(text);
        setGraphMeta('エラー: ' + message);
        graphStatus.textContent = 'エラーの詳細はブラウザコンソールを参照してください';
      }

      function renderGraph(snapshot) {
        if (!(graphSvg instanceof SVGElement) || !(graphShell instanceof HTMLElement)) {
          return showGraphError('描画コンテナを初期化できませんでした');
        }
        if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
          return showGraphError('表示するノードがありません');
        }

        const shellWidth = graphShell.clientWidth || GRID_LAYOUT.minWidth;
        const shellHeight = graphShell.clientHeight || GRID_LAYOUT.minHeight;
        const layout = computeGridLayout(snapshot.nodes, snapshot.edges ?? [], shellWidth, shellHeight);
        const {
          positions,
          width,
          height,
          rowKinds,
          columnSlots,
          columnSpan,
          minColumn,
          maxColumn,
          maxRow,
          columnBaseX,
        } = layout;

        graphSvg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        graphSvg.setAttribute('width', String(width));
        graphSvg.setAttribute('height', String(height));
        if (graphSvg instanceof SVGSVGElement && !graphSvg.hasAttribute('xmlns:xlink')) {
          graphSvg.setAttribute('xmlns:xlink', XLINK_NS);
        }
        const scaleX = shellWidth / width;
        const scaleY = shellHeight / height;
        const displayScale = Math.min(scaleX, scaleY, 1);
        const typeScale = displayScale < 1 ? Math.min(1.2, 1 / Math.max(displayScale, 0.82)) : 1;
        graphSvg.style.setProperty('--type-scale', typeScale.toFixed(3));
        clearGraph();

        const defs = document.createElementNS(SVG_NS, 'defs');
        const marker = document.createElementNS(SVG_NS, 'marker');
        marker.setAttribute('id', 'arrowhead');
        marker.setAttribute('viewBox', '0 -5 10 10');
        marker.setAttribute('refX', '10');
        marker.setAttribute('refY', '0');
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('orient', 'auto');
        const markerPath = document.createElementNS(SVG_NS, 'path');
        markerPath.setAttribute('d', 'M0,-5L10,0L0,5');
        markerPath.setAttribute('fill', 'rgba(148,163,184,0.55)');
        marker.appendChild(markerPath);
        defs.appendChild(marker);
        const gradient = document.createElementNS(SVG_NS, 'linearGradient');
        gradient.setAttribute('id', 'graph-surface-gradient');
        gradient.setAttribute('x1', '0%');
        gradient.setAttribute('y1', '0%');
        gradient.setAttribute('x2', '100%');
        gradient.setAttribute('y2', '100%');
        const gStop1 = document.createElementNS(SVG_NS, 'stop');
        gStop1.setAttribute('offset', '0%');
        gStop1.setAttribute('stop-color', 'rgba(30, 41, 59, 0.88)');
        const gStop2 = document.createElementNS(SVG_NS, 'stop');
        gStop2.setAttribute('offset', '55%');
        gStop2.setAttribute('stop-color', 'rgba(15, 23, 42, 0.65)');
        const gStop3 = document.createElementNS(SVG_NS, 'stop');
        gStop3.setAttribute('offset', '100%');
        gStop3.setAttribute('stop-color', 'rgba(2, 6, 23, 0.75)');
        gradient.appendChild(gStop1);
        gradient.appendChild(gStop2);
        gradient.appendChild(gStop3);
        defs.appendChild(gradient);
        graphSvg.appendChild(defs);

        const backgroundGroup = document.createElementNS(SVG_NS, 'g');
        backgroundGroup.setAttribute('class', 'graph-backdrop');
        graphSvg.appendChild(backgroundGroup);

        const surface = document.createElementNS(SVG_NS, 'rect');
        surface.setAttribute('x', '0');
        surface.setAttribute('y', '0');
        surface.setAttribute('width', String(width));
        surface.setAttribute('height', String(height));
        surface.setAttribute('class', 'graph-surface');
        surface.setAttribute('fill', 'url(#graph-surface-gradient)');
        backgroundGroup.appendChild(surface);

        const gridGroup = document.createElementNS(SVG_NS, 'g');
        gridGroup.setAttribute('class', 'graph-grid');
        backgroundGroup.appendChild(gridGroup);

        for (let slotIndex = 0; slotIndex < columnSlots; slotIndex++) {
          const x = columnBaseX + slotIndex * (layoutRuntime.columnGap / 2);
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', String(x));
          line.setAttribute('x2', String(x));
          line.setAttribute('y1', String(layoutRuntime.marginY - 56));
          line.setAttribute('y2', String(height - layoutRuntime.marginY + 56));
          line.setAttribute('class', 'grid-line vertical');
          gridGroup.appendChild(line);
        }

        const rowUsage = new Map();
        rowKinds.forEach(({ kind, position }) => {
          const y = layoutRuntime.marginY + position * (layoutRuntime.rowGap / 2);
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', String(layoutRuntime.marginX - 72));
          line.setAttribute('x2', String(width - layoutRuntime.marginX + 72));
          line.setAttribute('y1', String(y));
          line.setAttribute('y2', String(y));
          line.setAttribute('class', 'grid-line horizontal');
          gridGroup.appendChild(line);

          const usage = (rowUsage.get(kind) ?? 0) + 1;
          rowUsage.set(kind, usage);
          const labelText = (KIND_LABELS[kind] ?? kind) + (usage > 1 ? ' #' + usage : '');

          const label = document.createElementNS(SVG_NS, 'text');
          label.setAttribute('x', String(layoutRuntime.marginX + layoutRuntime.labelColumnWidth / 2));
          label.setAttribute('y', String(y + 5));
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('class', 'row-label kind-' + kind);
          label.textContent = labelText;
          gridGroup.appendChild(label);
        });

        const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));

        const edgeGroup = document.createElementNS(SVG_NS, 'g');
        edgeGroup.setAttribute('class', 'edges');
        graphSvg.appendChild(edgeGroup);
        const pulsesGroup = document.createElementNS(SVG_NS, 'g');
        pulsesGroup.setAttribute('class', 'edge-pulses');
        graphSvg.appendChild(pulsesGroup);

        const edges = snapshot.edges ?? [];
        const routing = computeEdgeRouting(edges, positions, minColumn, maxColumn);
        const flowStats = edges.reduce(
          (acc, edge) => {
            const metrics = edge.metrics ?? {};
            const rate = Math.max(metrics.publishRate ?? 0, metrics.deliverRate ?? 0);
            const backlog = Math.max(metrics.messagesReady ?? 0, metrics.messages ?? 0);
            return {
              maxRate: Math.max(acc.maxRate, rate),
              maxBacklog: Math.max(acc.maxBacklog, backlog),
            };
          },
          { maxRate: 0, maxBacklog: 0 },
        );
        const maxRate = Math.max(flowStats.maxRate, 1);
        const maxBacklog = Math.max(flowStats.maxBacklog, 1);
        let activeEdges = 0;

        for (const edge of edges) {
          const fromPos = positions.get(edge.from);
          const toPos = positions.get(edge.to);
          const fromNode = nodeMap.get(edge.from);
          const toNode = nodeMap.get(edge.to);
          const route = routing.get(edge.id);
          if (!fromPos || !toPos || !fromNode || !toNode || !route) continue;
          const startPoint = projectRectBoundary(
            fromPos,
            route.startDirection,
            route.startOffset,
            EDGE_START_OUTSET,
          );
          const endPoint = projectRectBoundary(
            toPos,
            route.endDirection,
            route.endOffset,
            EDGE_END_PADDING,
          );
          const pathId = 'edge-path-' + edge.id;
          const path = document.createElementNS(SVG_NS, 'path');
          const pathData = buildRoutedPath(startPoint, endPoint, route, fromPos, toPos, minColumn, maxColumn, maxRow);
          path.setAttribute('d', pathData);
          path.setAttribute('id', pathId);
          path.setAttribute('class', 'flow-path kind-' + edge.kind);
          path.dataset.edgeId = edge.id;
          path.dataset.from = edge.from;
          path.dataset.to = edge.to;

          const metrics = edge.metrics ?? {};
          const rate = Math.max(metrics.publishRate ?? 0, metrics.deliverRate ?? 0);
          const backlog = Math.max(metrics.messagesReady ?? 0, metrics.messages ?? 0);
          const intensity = rate > 0 ? rate / maxRate : backlog / Math.max(maxBacklog, 1);
          if (intensity > 0.08) {
            path.classList.add('has-traffic');
            activeEdges += 1;
          }
          const baseWidth = 2 + Math.min(2.5, intensity * 2.5);
          path.style.setProperty('--base-width', baseWidth.toFixed(2));
          const speed = Math.max(0.9, 3.6 - intensity * 2.8);
          path.style.setProperty('--flow-speed', speed.toFixed(2) + 's');

          path.addEventListener('mouseenter', (event) => {
            const info = edge.metrics ?? {};
            const tooltipParts = [
              '<strong>' + (nodeMap.get(edge.from)?.label ?? edge.from) + '</strong> → <strong>' + (nodeMap.get(edge.to)?.label ?? edge.to) + '</strong>',
              edge.description,
              'レート: ' + formatNumber(info.publishRate ?? info.deliverRate ?? 0) + '/s',
              '待機メッセージ: ' + formatNumber(info.messagesReady ?? info.messages ?? 0),
              'コンシューマー: ' + formatNumber(info.consumers ?? 0),
            ];
            showTooltip(tooltipParts.join('<br />'), event);
            highlightEdge(edge.id);
          });
          path.addEventListener('mousemove', updateTooltipPosition);
          path.addEventListener('mouseleave', () => {
            hideTooltip();
            applySelectionHighlight();
          });

          edgeGroup.appendChild(path);
          state.graphElements.edges.set(edge.id, path);

          if (intensity > 0.08) {
            const pulse = document.createElementNS(SVG_NS, 'circle');
            pulse.setAttribute('r', '4');
            pulse.setAttribute('class', 'flow-pulse kind-' + edge.kind);
            pulse.dataset.edgeId = edge.id;
            const motion = document.createElementNS(SVG_NS, 'animateMotion');
            motion.setAttribute('dur', Math.max(0.6, speed * 0.75).toFixed(2) + 's');
            motion.setAttribute('repeatCount', 'indefinite');
            const mpath = document.createElementNS(SVG_NS, 'mpath');
            mpath.setAttributeNS(XLINK_NS, 'href', '#' + pathId);
            motion.appendChild(mpath);
            pulse.appendChild(motion);
            pulsesGroup.appendChild(pulse);
            state.graphElements.pulses.set(edge.id, pulse);
          }
        }

        const nodeGroup = document.createElementNS(SVG_NS, 'g');
        nodeGroup.setAttribute('class', 'nodes');
        graphSvg.appendChild(nodeGroup);

        for (const node of snapshot.nodes) {
          const pos = positions.get(node.id);
          if (!pos) continue;
          const group = document.createElementNS(SVG_NS, 'g');
          group.setAttribute('class', 'node-group');
          group.dataset.nodeId = node.id;
          group.dataset.kind = node.kind;
          group.style.setProperty('--node-width', String(pos.width));
          group.style.setProperty('--node-height', String(pos.height));

          const card = document.createElementNS(SVG_NS, 'rect');
          card.setAttribute('x', String(pos.x - pos.width / 2));
          card.setAttribute('y', String(pos.y - pos.height / 2));
          card.setAttribute('width', String(pos.width));
          card.setAttribute('height', String(pos.height));
          card.setAttribute('rx', '18');
          card.setAttribute('ry', '18');
          card.setAttribute('class', 'node-card ' + statusClass(node.status?.level) + ' kind-' + node.kind);
          group.appendChild(card);

          const title = document.createElementNS(SVG_NS, 'text');
          title.setAttribute('x', String(pos.x));
          const titleBaseY = pos.y - pos.height / 2 + 56;
          title.setAttribute('y', String(titleBaseY));
          title.setAttribute('class', 'node-title');
          const rawTitleLines = wrapText(node.label ?? '', titleCapacityFromWidth(pos.width));
          const titleLines = rawTitleLines.filter((line) => line.trim().length > 0);
          if (titleLines.length === 0) {
            titleLines.push(node.label ?? '');
          }
          titleLines.forEach((line, lineIndex) => {
            const tspan = document.createElementNS(SVG_NS, 'tspan');
            tspan.setAttribute('x', String(pos.x));
            tspan.setAttribute('dy', lineIndex === 0 ? '0' : '1.18em');
            tspan.textContent = line;
            title.appendChild(tspan);
          });
          group.appendChild(title);

        const subtitleText = node.description ?? '';
        if (subtitleText) {
          const subtitle = document.createElementNS(SVG_NS, 'text');
          const subtitleX = pos.x - pos.width / 2 + SUBTITLE_LEFT_PADDING;
          subtitle.setAttribute('x', String(subtitleX));
          const subtitleBaseY =
            titleBaseY + Math.max(titleLines.length, 1) * 28 + SUBTITLE_VERTICAL_PADDING;
          subtitle.setAttribute('y', String(subtitleBaseY));
          subtitle.setAttribute('class', 'node-subtitle');
          const lines = wrapText(subtitleText, subtitleCapacityFromWidth(pos.width));
          lines.forEach((line, lineIndex) => {
            const tspan = document.createElementNS(SVG_NS, 'tspan');
            tspan.setAttribute('x', String(subtitleX));
            tspan.setAttribute('dy', lineIndex === 0 ? '0' : '1.32em');
            tspan.textContent = line;
            subtitle.appendChild(tspan);
          });
          subtitle.setAttribute('text-anchor', 'start');
          group.appendChild(subtitle);
        }

          group.addEventListener('mouseenter', (event) => {
            const statusDetail = node.status?.detail ? '<br />詳細: ' + node.status.detail : '';
            const latency = node.status?.latencyMs ? '<br />遅延: ' + node.status.latencyMs + ' ms' : '';
            const attributes = node.attributes
              ? '<br />属性: ' +
                Object.entries(node.attributes)
                  .map(([key, value]) => key + '=' + formatNumber(value))
                  .join(', ')
              : '';
            showTooltip(
              '<strong>' +
                node.label +
                '</strong><br />' +
                (node.description ?? '—') +
                '<br />ステータス: ' +
                statusLabel(node.status?.level ?? 'unknown') +
                statusDetail +
                latency +
                attributes,
              event,
            );
            highlightNode(node.id);
          });
          group.addEventListener('mousemove', updateTooltipPosition);
          group.addEventListener('mouseleave', () => {
            hideTooltip();
            applySelectionHighlight();
          });
          group.addEventListener('click', () => selectNode(node.id));
          nodeGroup.appendChild(group);
          state.graphElements.nodes.set(node.id, group);
        }

        setGraphMeta('グリッド: ' + rowKinds.length + '行×' + columnSpan + '列');
        graphSummary.textContent =
          snapshot.nodes.length +
          ' ノード / ' +
          (snapshot.edges?.length ?? 0) +
          ' エッジ (アクティブ: ' +
          activeEdges +
          ') — グリッド ' +
          rowKinds.length +
          '行×' +
          columnSpan +
          '列';
        applySelectionHighlight();

        function computeGridLayout(nodes, edges, shellWidth, shellHeight) {
          layoutRuntime.columnGap = GRID_LAYOUT.columnGap;
          layoutRuntime.rowGap = GRID_LAYOUT.rowGap;
          layoutRuntime.marginX = GRID_LAYOUT.marginX;
          layoutRuntime.marginY = GRID_LAYOUT.marginY;
          layoutRuntime.labelColumnWidth = GRID_LAYOUT.labelColumnWidth;
          layoutRuntime.maxColumnsPerRow = GRID_LAYOUT.maxColumnsPerRow;

          const adjacency = buildAdjacency(nodes, edges);
          const buckets = new Map();
          for (const node of nodes) {
            if (!buckets.has(node.kind)) buckets.set(node.kind, []);
            buckets.get(node.kind).push(node);
          }

          let orderedKinds = [];
          for (const kind of KIND_ORDER) {
            if (buckets.has(kind) && buckets.get(kind).length > 0) orderedKinds.push(kind);
          }
          for (const [kind, list] of buckets.entries()) {
            if (!orderedKinds.includes(kind) && list.length > 0) {
              orderedKinds.push(kind);
            }
          }

          const orderMap = new Map();
          for (const kind of orderedKinds) {
            const bucket = (buckets.get(kind) ?? []).slice().sort((a, b) => a.label.localeCompare(b.label, 'ja'));
            orderMap.set(kind, bucket);
          }

          let previousColumns = new Map();
          let finalColumns = new Map();
          for (let pass = 0; pass < GRID_LAYOUT.relaxPasses; pass++) {
            finalColumns = new Map();
            for (const kind of orderedKinds) {
              const list = orderMap.get(kind) ?? [];
              if (list.length === 0) continue;
              const rowUsed = new Set();
              const scored = list.map((node, index) => {
                const neighbors = adjacency.get(node.id) ?? new Set();
                const neighborColumns = [];
                neighbors.forEach((neighborId) => {
                  if (finalColumns.has(neighborId)) neighborColumns.push(finalColumns.get(neighborId));
                  else if (previousColumns.has(neighborId)) neighborColumns.push(previousColumns.get(neighborId));
                });
                const avg = neighborColumns.length > 0
                    ? neighborColumns.reduce((sum, value) => sum + value, 0) / neighborColumns.length
                    : previousColumns.has(node.id)
                      ? previousColumns.get(node.id)
                      : index;
                return { node, avg, index };
              });
              scored.sort((a, b) => {
                if (Number.isFinite(a.avg) && Number.isFinite(b.avg) && a.avg !== b.avg) {
                  return a.avg - b.avg;
                }
                return a.index - b.index;
              });
              const ordered = [];
              scored.forEach((entry) => {
                let desired = entry.avg;
                if (!Number.isFinite(desired)) desired = entry.index;
                let column = Math.round(desired);
                if (!Number.isFinite(column)) column = entry.index;
                let offset = 0;
                while (rowUsed.has(column)) {
                  offset += 1;
                  const direction = offset % 2 === 0 ? -1 : 1;
                  column = Math.round(desired) + direction * Math.ceil(offset / 2);
                  if (!Number.isFinite(column)) {
                    column = entry.index + offset;
                  }
                }
                rowUsed.add(column);
                finalColumns.set(entry.node.id, column);
                ordered.push(entry.node);
              });
              orderMap.set(kind, ordered);
            }
            previousColumns = finalColumns;
          }

          for (const kind of orderedKinds) {
            const list = orderMap.get(kind) ?? [];
            list.forEach((node, index) => {
              if (!finalColumns.has(node.id)) {
                finalColumns.set(node.id, index);
              }
            });
          }

          if (layoutRuntime.maxColumnsPerRow > 0) {
            const aspectRatio = shellWidth > 0 && shellHeight > 0 ? shellWidth / shellHeight : 1;
            const aspectLimit =
              aspectRatio < 1
                ? Math.max(1, Math.round(GRID_LAYOUT.maxColumnsPerRow * Math.max(aspectRatio, 0.38)))
                : GRID_LAYOUT.maxColumnsPerRow;
            layoutRuntime.maxColumnsPerRow = Math.max(1, Math.min(GRID_LAYOUT.maxColumnsPerRow, aspectLimit));

            const expandedKinds = [];
            for (const kind of orderedKinds) {
              const list = (orderMap.get(kind) ?? []).slice();
              list.sort((a, b) => {
                const colA = finalColumns.get(a.id) ?? 0;
                const colB = finalColumns.get(b.id) ?? 0;
                return colA - colB;
              });
              if (list.length <= layoutRuntime.maxColumnsPerRow) {
                list.forEach((node, index) => {
                  finalColumns.set(node.id, index);
                });
                orderMap.set(kind, list);
                expandedKinds.push(kind);
                continue;
              }
              for (let index = 0; index < list.length; index += layoutRuntime.maxColumnsPerRow) {
                const slice = list.slice(index, index + layoutRuntime.maxColumnsPerRow);
                const overflowIndex = Math.floor(index / layoutRuntime.maxColumnsPerRow);
                const key = overflowIndex === 0 ? kind : kind + '-overflow-' + overflowIndex;
                slice.forEach((node, sliceIndex) => {
                  finalColumns.set(node.id, sliceIndex);
                });
                orderMap.set(key, slice);
                expandedKinds.push(key);
              }
            }
            orderedKinds = expandedKinds;
          }

          const scaledColumns = new Map();
          let minColumn = Infinity;
          let maxColumn = -Infinity;
          finalColumns.forEach((value, key) => {
            const scaled = Number.isFinite(value) ? value * 2 : 0;
            scaledColumns.set(key, scaled);
            if (scaled < minColumn) minColumn = scaled;
            if (scaled > maxColumn) maxColumn = scaled;
          });
          if (!Number.isFinite(minColumn) || !Number.isFinite(maxColumn)) {
            minColumn = 0;
            maxColumn = 0;
          }
          finalColumns = scaledColumns;

          const columnSlots = maxColumn - minColumn + 1;
          const columnBaseX = layoutRuntime.marginX + layoutRuntime.labelColumnWidth + layoutRuntime.columnGap;
          const positions = new Map();
          const rowLabels = [];
          let maxRowIndex = 0;
          orderedKinds.forEach((originalKind, rowIndex) => {
            const baseKind = originalKind.split('-overflow-')[0];
            const rowPosition = rowIndex * 2;
            maxRowIndex = Math.max(maxRowIndex, rowPosition);
            rowLabels.push({ kind: baseKind, position: rowPosition });
            const list = orderMap.get(originalKind) ?? orderMap.get(baseKind) ?? [];
            list.sort((a, b) => {
              const colA = finalColumns.get(a.id) ?? 0;
              const colB = finalColumns.get(b.id) ?? 0;
              return colA - colB;
            });
            list.forEach((node) => {
              const column = finalColumns.get(node.id) ?? 0;
              const x = columnBaseX + (column - minColumn) * (layoutRuntime.columnGap / 2);
              const y = layoutRuntime.marginY + rowPosition * (layoutRuntime.rowGap / 2);
              const size = nodeDimensions(node.kind);
              positions.set(node.id, {
                x,
                y,
                width: size.width,
                height: size.height,
                column,
                row: rowPosition,
                kind: node.kind,
              });
            });
          });

          const effectiveColumns = Math.max(1, Math.floor(columnSlots / 2) + 1);
          const totalRowSlots = maxRowIndex + 1;

          const slotSpan = Math.max(totalRowSlots - 1 + WALKWAY_EXTENSION_SLOTS * 2, 0);
          const targetHeight = Math.max(shellHeight, GRID_LAYOUT.minHeight);
          const availableForGaps = targetHeight - layoutRuntime.marginY * 2 - NODE_DEFAULT_DIMENSIONS.height;
          if (slotSpan > 0 && availableForGaps > 0) {
            const candidateRowGap = (availableForGaps / slotSpan) * 2;
            if (candidateRowGap > layoutRuntime.rowGap + ALIGN_TOLERANCE) {
              layoutRuntime.rowGap = candidateRowGap;
            }
          }

          positions.forEach((pos) => {
            pos.y = layoutRuntime.marginY + pos.row * (layoutRuntime.rowGap / 2);
          });

          const width = Math.max(
            shellWidth,
            layoutRuntime.marginX * 2 +
              layoutRuntime.labelColumnWidth +
              layoutRuntime.columnGap / 2 +
              Math.max(columnSlots - 1 + WALKWAY_EXTENSION_SLOTS * 2, 0) * (layoutRuntime.columnGap / 2) +
              NODE_DEFAULT_DIMENSIONS.width,
          );
          const height = Math.max(
            shellHeight,
            layoutRuntime.marginY * 2 +
              Math.max(totalRowSlots - 1 + WALKWAY_EXTENSION_SLOTS * 2, 0) * (layoutRuntime.rowGap / 2) +
              NODE_DEFAULT_DIMENSIONS.height,
          );

          const maxRow = maxRowIndex;
            return {
              positions,
              width,
              height,
              rowKinds: rowLabels,
              columnSlots,
              columnSpan: effectiveColumns,
              minColumn,
              maxColumn,
              maxRow,
              columnBaseX,
            };
        }

        function buildAdjacency(nodes, edges) {
          const adjacency = new Map();
          nodes.forEach((node) => adjacency.set(node.id, new Set()));
          edges.forEach((edge) => {
            if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
            if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
            adjacency.get(edge.from).add(edge.to);
            adjacency.get(edge.to).add(edge.from);
          });
          return adjacency;
        }

        function projectRectBoundary(node, direction, offset = 0, padding = 0) {
          const halfWidth = node.width / 2;
          const halfHeight = node.height / 2;
          if (direction === 'left' || direction === 'right') {
            const sign = direction === 'right' ? 1 : -1;
            const limit = Math.max(4, halfHeight - LANE_LIMIT_MARGIN);
            const clampedOffset = clamp(offset, -limit, limit);
            return {
              x: node.x + sign * (halfWidth + padding),
              y: node.y + clampedOffset,
            };
          }
          const sign = direction === 'down' ? 1 : -1;
          const limit = Math.max(6, halfWidth - LANE_LIMIT_MARGIN);
          const clampedOffset = clamp(offset, -limit, limit);
          return {
            x: node.x + clampedOffset,
            y: node.y + sign * (halfHeight + padding),
          };
        }

        function buildRoutedPath(start, end, route, sourceNode, targetNode, minColumn, maxColumn, maxRow) {
          const points = [start];
          const { fromColumn, fromRow, toColumn, toRow, startDirection, endDirection } = route;
        
          const isVerticalTravel = fromColumn === toColumn && fromRow !== toRow;
          const isHorizontalTravel = fromRow === toRow && fromColumn !== toColumn;
        
          // Condition for a simple U-shaped path for nodes in the same column.
          // This applies only when exiting and entering from the same side (e.g., left-to-left).
          const simpleVerticalPath = isVerticalTravel && 
                                     startDirection === endDirection &&
                                     (startDirection === 'left' || startDirection === 'right');
        
          // Condition for a simple U-shaped path for nodes in the same row.
          // This applies only when exiting and entering from the same side (e.g., top-to-top).
          const simpleHorizontalPath = isHorizontalTravel &&
                                       startDirection === endDirection &&
                                       (startDirection === 'up' || startDirection === 'down');
        
          if (simpleVerticalPath) {
            // For simple side-to-side connections in the same column, create a U-bend.
            const goRight = fromColumn < (minColumn + maxColumn) / 2;
            const walkwayX = columnWalkway(fromColumn, goRight ? 'right' : 'left', minColumn, maxColumn);
            points.push({ x: walkwayX, y: start.y });
            points.push({ x: walkwayX, y: end.y });
          } else if (simpleHorizontalPath) {
            // For simple top-to-bottom connections in the same row, create a U-bend.
            const goDown = fromRow < maxRow / 2;
            const walkwayY = rowWalkway(fromRow, goDown ? 'down' : 'up', maxRow);
            points.push({ x: start.x, y: walkwayY });
            points.push({ x: end.x, y: walkwayY });
          } else if (fromColumn !== toColumn || fromRow !== toRow) {
            // This block now handles diagonal connections AND complex same-row/same-column connections.
            const startsHorizontal = startDirection === 'left' || startDirection === 'right';
            const endsHorizontal = endDirection === 'left' || endDirection === 'right';
        
            // Determine routing direction. Use a heuristic for same-column/row cases.
            const goRight = toColumn > fromColumn ? true : (toColumn < fromColumn ? false : fromColumn < (minColumn + maxColumn) / 2);
            const goDown = toRow > fromRow ? true : (toRow < fromRow ? false : fromRow < maxRow / 2);
             
            const vWalkwayStart = columnWalkway(fromColumn, goRight ? 'right' : 'left', minColumn, maxColumn);
            const hWalkwayStart = rowWalkway(fromRow, goDown ? 'down' : 'up', maxRow);
            const vWalkwayEnd = columnWalkway(toColumn, goRight ? 'left' : 'right', minColumn, maxColumn);
            const hWalkwayEnd = rowWalkway(toRow, goDown ? 'up' : 'down', maxRow);
            
            if (startsHorizontal) {
              points.push({ x: vWalkwayStart, y: start.y });
              if (endsHorizontal) { // H -> H
                points.push({ x: vWalkwayStart, y: hWalkwayStart });
                points.push({ x: vWalkwayEnd, y: hWalkwayStart });
                points.push({ x: vWalkwayEnd, y: end.y });
              } else { // H -> V
                points.push({ x: vWalkwayStart, y: hWalkwayEnd });
                points.push({ x: end.x, y: hWalkwayEnd });
              }
            } else { // startsVertical
              points.push({ x: start.x, y: hWalkwayStart });
              if (endsHorizontal) { // V -> H
                points.push({ x: vWalkwayEnd, y: hWalkwayStart });
                points.push({ x: vWalkwayEnd, y: end.y });
              } else { // V -> V
                points.push({ x: vWalkwayStart, y: hWalkwayStart });
                points.push({ x: vWalkwayStart, y: hWalkwayEnd });
                points.push({ x: end.x, y: hWalkwayEnd });
              }
            }
          }
        
          points.push(end);
          return polyline(points);
        }

        function computeEdgeRouting(edges, positions, minColumn = 0, maxColumn = 0) {
          const startGroups = new Map();
          const endGroups = new Map();
          const routing = new Map();
          for (const edge of edges) {
            const fromPos = positions.get(edge.from);
            const toPos = positions.get(edge.to);
            if (!fromPos || !toPos) continue;
            const startDirection = dominantDirection(fromPos, toPos);
            const endDirection = dominantDirection(toPos, fromPos);
            const startKey = ['out', edge.from, startDirection].join(':');
            const endKey = ['in', edge.to, endDirection].join(':');
            if (!startGroups.has(startKey)) startGroups.set(startKey, []);
            if (!endGroups.has(endKey)) endGroups.set(endKey, []);
            startGroups.get(startKey).push(edge.id);
            endGroups.get(endKey).push(edge.id);
            routing.set(edge.id, {
              startDirection,
              endDirection,
              startOffset: 0,
              endOffset: 0,
              source: fromPos,
              target: toPos,
              fromColumn: fromPos.column,
              toColumn: toPos.column,
              fromRow: fromPos.row,
              toRow: toPos.row,
            });
          }
          const assignOffsets = (groups, accessor) => {
            for (const [key, edgeIds] of groups) {
              if (!edgeIds || edgeIds.length === 0) continue;
              const offsets = computeLaneOffsets(edgeIds.length);
              edgeIds.forEach((edgeId, index) => {
                const info = routing.get(edgeId);
                if (!info) return;
                accessor(info, offsets[index]);
              });
            }
          };
          assignOffsets(startGroups, (info, offset) => {
            info.startOffset = offset;
          });
          assignOffsets(endGroups, (info, offset) => {
            info.endOffset = offset;
          });
          return routing;
        }

        function dominantDirection(source, target) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          if (Math.abs(dx) >= Math.abs(dy)) {
            return dx >= 0 ? 'right' : 'left';
          }
          return dy >= 0 ? 'down' : 'up';
        }

        function computeLaneOffsets(count) {
          // Edges should connect to the midpoint of the card's side,
          // so we return an array of zeros to avoid any offset.
          return new Array(count).fill(0);
        }

        function columnWalkway(column, direction, minColumn, maxColumn) {
          if (!Number.isFinite(column)) return null;
          const step = direction === 'right' ? 1 : direction === 'left' ? -1 : 0;
          if (step === 0) return null;
          const minSlot = (minColumn ?? column) - WALKWAY_EXTENSION_SLOTS * 2;
          const maxSlot = (maxColumn ?? column) + WALKWAY_EXTENSION_SLOTS * 2;
          const desired = clamp(column + step, minSlot, maxSlot);
          return columnBaseX + (desired - minColumn) * (layoutRuntime.columnGap / 2);
        }

        function rowWalkway(row, direction, maxRow) {
          if (!Number.isFinite(row)) return null;
          const step = direction === 'down' ? 1 : direction === 'up' ? -1 : 0;
          if (step === 0) return null;
          const minSlot = -WALKWAY_EXTENSION_SLOTS * 2;
          const maxSlot = (maxRow ?? row) + WALKWAY_EXTENSION_SLOTS * 2;
          const desired = clamp(row + step, minSlot, maxSlot);
          return layoutRuntime.marginY + desired * (layoutRuntime.rowGap / 2);
        }

        function enforceColumnClearance(value, direction, sourceNode, targetNode, minColumn, maxColumn) {
          if (!Number.isFinite(value)) return value;
          const slotToX = (slot) => columnBaseX + (slot - minColumn) * (layoutRuntime.columnGap / 2);
          const minLimit = slotToX(minColumn - WALKWAY_EXTENSION_SLOTS * 2);
          const maxLimit = slotToX(maxColumn + WALKWAY_EXTENSION_SLOTS * 2);
          let adjusted = value;
          if (direction === 'right') {
            const bounds = [];
            if (sourceNode) bounds.push(sourceNode.x + sourceNode.width / 2 + EDGE_CLEARANCE);
            if (targetNode) bounds.push(targetNode.x + targetNode.width / 2 + EDGE_CLEARANCE);
            const minBound = bounds.length > 0 ? Math.max(...bounds) : minLimit;
            adjusted = Math.max(adjusted, minBound);
          } else if (direction === 'left') {
            const bounds = [];
            if (sourceNode) bounds.push(sourceNode.x - sourceNode.width / 2 - EDGE_CLEARANCE);
            if (targetNode) bounds.push(targetNode.x - targetNode.width / 2 - EDGE_CLEARANCE);
            const maxBound = bounds.length > 0 ? Math.min(...bounds) : maxLimit;
            adjusted = Math.min(adjusted, maxBound);
          }
          return clamp(adjusted, minLimit, maxLimit);
        }

        function enforceRowClearance(value, direction, sourceNode, targetNode, maxRow) {
          if (!Number.isFinite(value)) return value;
          const minLimit = layoutRuntime.marginY - WALKWAY_EXTENSION_SLOTS * layoutRuntime.rowGap;
          const maxLimit = layoutRuntime.marginY + (maxRow + WALKWAY_EXTENSION_SLOTS) * layoutRuntime.rowGap;
          let adjusted = value;
          if (direction === 'down') {
            const bounds = [];
            if (sourceNode) bounds.push(sourceNode.y + sourceNode.height / 2 + EDGE_CLEARANCE);
            if (targetNode) bounds.push(targetNode.y + targetNode.height / 2 + EDGE_CLEARANCE);
            const minBound = bounds.length > 0 ? Math.max(...bounds) : minLimit;
            adjusted = Math.max(adjusted, minBound);
          } else if (direction === 'up') {
            const bounds = [];
            if (sourceNode) bounds.push(sourceNode.y - sourceNode.height / 2 - EDGE_CLEARANCE);
            if (targetNode) bounds.push(targetNode.y - targetNode.height / 2 - EDGE_CLEARANCE);
            const maxBound = bounds.length > 0 ? Math.min(...bounds) : maxLimit;
            adjusted = Math.min(adjusted, maxBound);
          }
          return clamp(adjusted, minLimit, maxLimit);
        }

        function polyline(points) {
          if (!Array.isArray(points) || points.length === 0) return '';
          const filtered = [];
          points.forEach((point) => {
            if (!point) return;
            const x = Number(point.x);
            const y = Number(point.y);
            const prev = filtered[filtered.length - 1];
            if (prev && Math.abs(prev.x - x) <= ALIGN_TOLERANCE && Math.abs(prev.y - y) <= ALIGN_TOLERANCE) {
              // skip point if it's too close to the previous one
            } else {
              filtered.push({ x, y });
            }
          });
          const segments = [];
          filtered.forEach((point, index) => {
            const prefix = index === 0 ? 'M' : 'L';
            segments.push(prefix, point.x.toFixed ? Number(point.x.toFixed(2)) : point.x, point.y.toFixed ? Number(point.y.toFixed(2)) : point.y);
          });
          return segments.join(' ');
        }

        function clamp(value, min, max) {
          return Math.min(max, Math.max(min, value));
        }

        function titleCapacityFromWidth(width) {
          if (!Number.isFinite(width)) return 18;
          const usableWidth = Math.max(width - TITLE_TEXT_PADDING, 140);
          const estimatedCapacity = Math.floor(usableWidth / TITLE_AVG_CHAR_WIDTH);
          return Math.max(10, estimatedCapacity);
        }

        function subtitleCapacityFromWidth(width) {
          if (!Number.isFinite(width)) return 28;
          const usableWidth = Math.max(width - (SUBTITLE_LEFT_PADDING + SUBTITLE_RIGHT_PADDING), 160);
          const estimatedCapacity = Math.floor(usableWidth / SUBTITLE_AVG_CHAR_WIDTH) - 1;
          return Math.max(8, estimatedCapacity);
        }

        function wrapText(text, maxCharsPerLine) {
          if (!text) return [''];
          const limit = Math.max(8, maxCharsPerLine ?? 24);
          const words = String(text).split(/\\s+/);
          const lines = [];
          let current = '';
          const flushCurrent = () => {
            if (current) {
              lines.push(current);
              current = '';
            }
          };
          for (const word of words) {
            if (!word) continue;
            if (word.length > limit) {
              flushCurrent();
              for (let index = 0; index < word.length; index += limit) {
                lines.push(word.slice(index, index + limit));
              }
              continue;
            }
            if (!current) {
              current = word;
              continue;
            }
            if ((current + ' ' + word).length <= limit) {
              current += ' ' + word;
            } else {
              flushCurrent();
              current = word;
            }
          }
          flushCurrent();
          return lines.length > 0 ? lines : [''];
        }
      }

      function highlightEdge(edgeId) {
        for (const [id, edgeEl] of state.graphElements.edges) {
          const isTarget = id === edgeId;
          edgeEl.classList.toggle('hovered', isTarget);
          if (isTarget) {
            edgeEl.classList.remove('dimmed');
          } else if (!state.selectedNodeId) {
            edgeEl.classList.remove('dimmed');
          }
          const pulse = state.graphElements.pulses.get(id);
          if (pulse) {
            pulse.classList.toggle('hovered', isTarget);
            if (isTarget) {
              pulse.classList.remove('dimmed');
            } else if (!state.selectedNodeId) {
              pulse.classList.remove('dimmed');
            }
          }
        }
      }

      function highlightNode(nodeId) {
        for (const [id, nodeEl] of state.graphElements.nodes) {
          const isTarget = id === nodeId;
          nodeEl.classList.toggle('hovered', isTarget);
          if (isTarget) {
            nodeEl.classList.remove('dimmed');
          } else if (!state.selectedNodeId) {
            nodeEl.classList.remove('dimmed');
          }
        }
        for (const [id, edgeEl] of state.graphElements.edges) {
          const isConnected = edgeEl.dataset.from === nodeId || edgeEl.dataset.to === nodeId;
          edgeEl.classList.toggle('hovered', isConnected);
          if (isConnected) {
            edgeEl.classList.remove('dimmed');
          } else if (!state.selectedNodeId) {
            edgeEl.classList.remove('dimmed');
          }
          const pulse = state.graphElements.pulses.get(id);
          if (pulse) {
            pulse.classList.toggle('hovered', isConnected);
            if (isConnected) {
              pulse.classList.remove('dimmed');
            } else if (!state.selectedNodeId) {
              pulse.classList.remove('dimmed');
            }
          }
        }
      }

      function applySelectionHighlight() {
        const selected = state.selectedNodeId;
        const connectedNodes = new Set();
        const connectedEdges = new Set();
        if (selected && state.snapshot) {
          for (const edge of state.snapshot.edges ?? []) {
            if (edge.from === selected || edge.to === selected) {
              connectedEdges.add(edge.id);
              connectedNodes.add(edge.from);
              connectedNodes.add(edge.to);
            }
          }
        }
        for (const [id, nodeEl] of state.graphElements.nodes) {
          const isSelected = selected === id;
          const isConnected = selected ? connectedNodes.has(id) : false;
          nodeEl.classList.toggle('selected', isSelected);
          nodeEl.classList.toggle('dimmed', Boolean(selected && !isSelected && !isConnected));
          nodeEl.classList.remove('hovered');
        }
        for (const [id, edgeEl] of state.graphElements.edges) {
          const isConnected = selected ? connectedEdges.has(id) : false;
          edgeEl.classList.toggle('highlight', Boolean(selected && isConnected));
          edgeEl.classList.toggle('dimmed', Boolean(selected && !isConnected));
          edgeEl.classList.remove('hovered');
          const pulse = state.graphElements.pulses.get(id);
          if (pulse) {
            pulse.classList.toggle('highlight', Boolean(selected && isConnected));
            pulse.classList.toggle('dimmed', Boolean(selected && !isConnected));
            pulse.classList.remove('hovered');
          }
        }
        if (!selected) {
          for (const [, pulse] of state.graphElements.pulses) {
            pulse.classList.remove('dimmed');
            pulse.classList.remove('highlight');
            pulse.classList.remove('hovered');
          }
          graphStatus.textContent = 'ノードをクリックすると関連するデータフローが強調表示されます';
        }
      }

      function selectNode(nodeId) {
        state.selectedNodeId = nodeId;
        applySelectionHighlight();
        if (serviceList) {
          const buttons = serviceList.querySelectorAll('.service-item');
          buttons.forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            button.classList.toggle('selected', button.dataset.id === nodeId);
          });
        }
        const node = state.snapshot?.nodes.find((item) => item.id === nodeId);
        updateSelectionPanel(node ?? null);
        graphStatus.textContent = node ? node.label + ' の入出力をハイライトしています' : 'ノードをクリックすると関連するデータフローが強調表示されます';
      }

      function updateSystemOverviewCards(snapshot) {
        if (!snapshot) return;
        const rabbitStatus = document.getElementById('rabbit-status');
        const rabbitMeta = document.getElementById('rabbit-meta');
        const postgresStatus = document.getElementById('postgres-status');
        const postgresMeta = document.getElementById('postgres-meta');
        const minioStatus = document.getElementById('minio-status');
        const minioMeta = document.getElementById('minio-meta');
        if (rabbitStatus) {
          rabbitStatus.textContent = snapshot.rabbit.healthy ? '正常' : '障害';
          rabbitStatus.className = 'metric-value';
          rabbitStatus.classList.add(snapshot.rabbit.healthy ? 'status-ok' : 'status-error');
        }
        if (rabbitMeta) {
          rabbitMeta.textContent = snapshot.rabbit.healthy
            ? '最終確認: ' + formatDate(snapshot.rabbit.checkedAt)
            : 'エラー: ' + (snapshot.rabbit.error ?? '未知のエラー');
        }
        if (postgresStatus) {
          postgresStatus.textContent = snapshot.postgres.healthy ? '正常' : '障害';
          postgresStatus.className = 'metric-value';
          postgresStatus.classList.add(snapshot.postgres.healthy ? 'status-ok' : 'status-error');
        }
        if (postgresMeta) {
          postgresMeta.textContent = snapshot.postgres.healthy
            ? 'バージョン: ' +
              (snapshot.postgres.version ?? '不明') +
              ' / 最終確認: ' +
              formatDate(snapshot.postgres.checkedAt)
            : 'エラー: ' + (snapshot.postgres.error ?? '未知のエラー');
        }
        if (minioStatus) {
          minioStatus.textContent = snapshot.minio.healthy ? '正常' : '障害';
          minioStatus.className = 'metric-value';
          minioStatus.classList.add(snapshot.minio.healthy ? 'status-ok' : 'status-error');
        }
        if (minioMeta) {
          minioMeta.textContent = snapshot.minio.healthy
            ? 'バケット数: ' + snapshot.minio.buckets.length + ' / 最終確認: ' + formatDate(snapshot.minio.checkedAt)
            : 'エラー: ' + (snapshot.minio.error ?? '未知のエラー');
        }
      }

      function renderQueueMetrics(snapshot) {
        if (!(queueMetrics instanceof HTMLElement)) return;
        queueMetrics.innerHTML = '';
        const queueNodes = snapshot.nodes.filter((node) => node.kind === 'queue');
        if (queueNodes.length === 0) {
          queueMetrics.innerHTML = '<p class="muted">登録済みキューが見つかりません。</p>';
          return;
        }
        queueNodes.forEach((node) => {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'queue-card';
          card.dataset.id = node.id;
          const name = document.createElement('div');
          name.className = 'queue-name';
          name.textContent = node.label;
          const metrics = node.attributes ?? {};
          const ready = metrics.messagesReady ?? metrics.messages ?? 0;
          const consumers = metrics.consumers ?? 0;
          const publishRate = metrics.publishRate ?? metrics.deliverRate ?? 0;
          const history = state.history.get(node.id) ?? { ready: [] };
          if (!history.ready) history.ready = [];
          history.ready.push(ready);
          if (history.ready.length > 12) history.ready.shift();
          state.history.set(node.id, history);
          const previous = history.ready.length > 1 ? history.ready[history.ready.length - 2] : ready;
          const diff = ready - previous;
          const trend =
            diff > 0 ? '▲+' + diff.toLocaleString() : diff < 0 ? '▼' + diff.toLocaleString() : '＝0';
          const readyRow = document.createElement('div');
          readyRow.className = 'queue-metric';
          readyRow.innerHTML = '<span>待機メッセージ</span><span>' + ready.toLocaleString() + ' (' + trend + ')</span>';
          const consumerRow = document.createElement('div');
          consumerRow.className = 'queue-metric';
          consumerRow.innerHTML = '<span>コンシューマー</span><span>' + consumers + '</span>';
          const rateRow = document.createElement('div');
          rateRow.className = 'queue-metric';
          rateRow.innerHTML = '<span>流量</span><span>' + publishRate.toFixed(1) + '/s</span>';
          card.appendChild(name);
          card.appendChild(readyRow);
          card.appendChild(consumerRow);
          card.appendChild(rateRow);
          card.addEventListener('click', () => selectNode(node.id));
          queueMetrics.appendChild(card);
        });
      }

      function renderServiceList(snapshot) {
        if (!(serviceList instanceof HTMLElement)) return;
        serviceList.innerHTML = '';
        snapshot.nodes
          .filter((node) => node.kind !== 'queue')
          .sort((a, b) => a.label.localeCompare(b.label, 'ja'))
          .forEach((node) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'service-item';
            button.dataset.id = node.id;

            const header = document.createElement('div');
            header.className = 'service-item-header';
            const label = document.createElement('span');
            label.className = 'service-label';
            label.textContent = node.label;
            const pill = document.createElement('span');
            pill.className = 'status-pill ' + statusClass(node.status?.level);
            pill.textContent = statusLabel(node.status?.level ?? 'unknown');
            header.appendChild(label);
            header.appendChild(pill);

            const desc = document.createElement('div');
            desc.className = 'service-description';
            desc.textContent = node.description;

            const meta = document.createElement('div');
            meta.className = 'service-meta';
            if (node.status?.latencyMs !== undefined) {
              const latency = document.createElement('span');
              latency.textContent = '遅延: ' + node.status.latencyMs + 'ms';
              meta.appendChild(latency);
            }
            if (node.status?.checkedAt) {
              const checked = document.createElement('span');
              checked.textContent = '最終確認: ' + formatDate(node.status.checkedAt);
              meta.appendChild(checked);
            }
            if (node.status?.detail && node.status.detail !== 'ok') {
              const detail = document.createElement('span');
              detail.textContent = '詳細: ' + node.status.detail;
              meta.appendChild(detail);
            }

            button.appendChild(header);
            button.appendChild(desc);
            if (meta.childNodes.length > 0) button.appendChild(meta);
            button.addEventListener('click', () => selectNode(node.id));
            serviceList.appendChild(button);
          });
        applySelectionHighlight();
      }

      function updateSelectionPanel(node) {
        if (!node) {
          selectionTitle.textContent = 'ノード詳細';
          selectionSubtitle.textContent = '左のグラフまたはサービス一覧からノードを選択してください';
          selectionStatus.textContent = '未選択';
          selectionStatus.className = 'status-pill status-unknown';
          selectionBody.innerHTML = '<p class="muted">ノードを選択すると、直近のステータスと関連フローがここに表示されます。</p>';
          return;
        }
        selectionTitle.textContent = node.label;
        selectionSubtitle.textContent = node.description;
        selectionStatus.textContent = statusLabel(node.status?.level ?? 'unknown');
        selectionStatus.className = 'status-pill ' + statusClass(node.status?.level);

        const detailFragments = [];
        const statusCard =
          '<div class="detail-card"><strong>ヘルスチェック</strong><span>' +
          statusLabel(node.status?.level ?? 'unknown') +
          '</span>' +
          (node.status?.checkedAt ? '<span class="muted">最終確認: ' + formatDate(node.status.checkedAt) + '</span>' : '') +
          (node.status?.latencyMs !== undefined ? '<span class="muted">遅延: ' + node.status.latencyMs + 'ms</span>' : '') +
          (node.status?.detail ? '<span class="muted">詳細: ' + node.status.detail + '</span>' : '') +
          '</div>';
        detailFragments.push(statusCard);
        if (node.attributes && Object.keys(node.attributes).length > 0) {
          const attributes =
            '<div class="detail-card"><strong>属性</strong><span>' +
            Object.entries(node.attributes)
              .map(([key, value]) => key + ': ' + formatNumber(value))
              .join('<br />') +
            '</span></div>';
          detailFragments.push(attributes);
        }
        const incomingEdges = state.snapshot?.edges.filter((edge) => edge.to === node.id) ?? [];
        const outgoingEdges = state.snapshot?.edges.filter((edge) => edge.from === node.id) ?? [];
        const incomingHtml =
          '<div><strong class="muted">受信中 (' +
          incomingEdges.length +
          ')</strong><div class="flow-list">' +
          incomingEdges
            .map((edge) => {
              const source = state.snapshot?.nodes.find((candidate) => candidate.id === edge.from);
              return (
                '<div class="flow-list-item"><strong>' +
                (source?.label ?? edge.from) +
                '</strong><br />' +
                edge.description +
                '</div>'
              );
            })
            .join('') +
          '</div></div>';
        const outgoingHtml =
          '<div><strong class="muted">送信中 (' +
          outgoingEdges.length +
          ')</strong><div class="flow-list">' +
          outgoingEdges
            .map((edge) => {
              const target = state.snapshot?.nodes.find((candidate) => candidate.id === edge.to);
              return (
                '<div class="flow-list-item"><strong>' +
                (target?.label ?? edge.to) +
                '</strong><br />' +
                edge.description +
                '</div>'
              );
            })
            .join('') +
          '</div></div>';
        selectionBody.innerHTML =
          '<div class="detail-grid">' + detailFragments.join('') + '</div><div class="split-panel">' + incomingHtml + outgoingHtml + '</div>';
      }

      function renderTasks(payload) {
        if (!(tasksList instanceof HTMLElement)) return;
        if (!payload || !Array.isArray(payload.tasks)) {
          tasksList.innerHTML = '<p class="error">タスク情報の取得に失敗しました。</p>';
          tasksSummary.textContent = payload?.error ?? '';
          return;
        }
        if (payload.tasks.length === 0) {
          tasksList.innerHTML = '<p class="muted">エクスポートタスクは登録されていません。</p>';
          tasksSummary.textContent = '';
          return;
        }
        tasksList.innerHTML = '';
        payload.tasks.forEach((task) => {
          const card = document.createElement('div');
          card.className = 'task-card';
          const title = document.createElement('div');
          title.innerHTML = '<strong>タスク ' + task.taskId + '</strong>';
          const status = document.createElement('div');
          status.className = 'muted';
          status.textContent = 'ステータス: ' + task.status + ' / 実験: ' + task.experimentId;
          const progress = document.createElement('div');
          progress.className = 'progress-bar';
          const bar = document.createElement('span');
          bar.style.width = Math.max(0, Math.min(100, task.progress ?? 0)) + '%';
          progress.appendChild(bar);
          const updated = document.createElement('div');
          updated.className = 'muted';
          updated.textContent = '更新: ' + formatDate(task.updatedAt);
          card.appendChild(title);
          card.appendChild(status);
          card.appendChild(progress);
          card.appendChild(updated);
          if (task.errorMessage) {
            const err = document.createElement('div');
            err.className = 'error';
            err.textContent = 'エラー: ' + task.errorMessage;
            card.appendChild(err);
          } else if (task.resultFilePath) {
            const path = document.createElement('div');
            path.className = 'muted';
            path.textContent = '成果物: ' + task.resultFilePath;
            card.appendChild(path);
          }
          tasksList.appendChild(card);
        });
        tasksSummary.textContent =
          payload.tasks.length +
          ' 件 / ' +
          (payload.generatedAt ? '取得: ' + formatDate(payload.generatedAt) : '同期済み');
      }

      function renderBuckets(health) {
        if (!(storageGrid instanceof HTMLElement)) return;
        if (!health) {
          storageGrid.innerHTML = '<p class="error">MinIO 状況の取得に失敗しました。</p>';
          return;
        }
        if (!health.healthy) {
          storageGrid.innerHTML = '<p class="error">MinIO に接続できません: ' + (health.error ?? '原因不明') + '</p>';
          bucketsSummary.textContent = '';
          return;
        }
        if (!Array.isArray(health.buckets) || health.buckets.length === 0) {
          storageGrid.innerHTML = '<p class="muted">バケットが存在しません。</p>';
          bucketsSummary.textContent = '';
          return;
        }
        storageGrid.innerHTML = '';
        health.buckets.forEach((bucket) => {
          const card = document.createElement('div');
          card.className = 'detail-card';
          const name = document.createElement('strong');
          name.textContent = bucket.name;
          const created = document.createElement('span');
          created.className = 'muted';
          created.textContent = bucket.createdAt ? '作成: ' + formatDate(bucket.createdAt) : '作成日時: 不明';
          card.appendChild(name);
          card.appendChild(created);
          if (Array.isArray(bucket.objectSample) && bucket.objectSample.length > 0) {
            const list = document.createElement('div');
            list.className = 'muted';
            list.innerHTML =
              bucket.objectSample
                .slice(0, 5)
                .map((obj) => obj.name + ' (' + formatBytes(obj.size) + ')')
                .join('<br />') || '';
            card.appendChild(list);
          }
          storageGrid.appendChild(card);
        });
        bucketsSummary.textContent =
          health.buckets.length + ' バケット / 最終確認: ' + (health.checkedAt ? formatDate(health.checkedAt) : '不明');
      }

      function renderTables(payload) {
        if (!(tableListBody instanceof HTMLElement)) return;
        if (!payload || !Array.isArray(payload.tables)) {
          tableListBody.innerHTML = '<tr><td colspan="5" class="error">テーブル一覧の取得に失敗しました。</td></tr>';
          tablesSummary.textContent = payload?.error ?? '';
          return;
        }
        state.tables = payload.tables;
        applyTableFilter();
        tablesSummary.textContent =
          '全 ' + payload.tables.length + ' テーブル (生成: ' + formatDate(payload.generatedAt) + ')';
      }

      function applyTableFilter() {
        if (!(tableListBody instanceof HTMLElement)) return;
        const query = (tableSearch?.value ?? '').trim().toLowerCase();
        state.filteredTables = state.tables.filter((table) => {
          const fullName = table.schema + '.' + table.name;
          return fullName.toLowerCase().includes(query);
        });
        tableListBody.innerHTML = '';
        if (state.filteredTables.length === 0) {
          tableListBody.innerHTML = '<tr><td colspan="5" class="muted">該当するテーブルがありません。</td></tr>';
          return;
        }
        state.filteredTables.slice(0, 120).forEach((table) => {
          const tr = document.createElement('tr');
          tr.dataset.schema = table.schema;
          tr.dataset.table = table.name;
          tr.innerHTML =
            '<td>' +
            table.schema +
            '</td><td><strong>' +
            table.name +
            '</strong></td><td>' +
            table.rowEstimate.toLocaleString() +
            '</td><td>' +
            formatBytes(table.totalBytes) +
            '</td><td>' +
            (table.lastAnalyzed ?? '—') +
            '</td>';
          tr.addEventListener('click', () => {
            selectTable(table.schema, table.name);
          });
          tableListBody.appendChild(tr);
        });
        highlightSelectedTable();
      }

      function highlightSelectedTable() {
        if (!(tableListBody instanceof HTMLElement)) return;
        const rows = tableListBody.querySelectorAll('tr');
        rows.forEach((row) => {
          if (!(row instanceof HTMLElement)) return;
          const selected =
            state.tableSelection &&
            row.dataset.schema === state.tableSelection.schema &&
            row.dataset.table === state.tableSelection.table;
          row.classList.toggle('selected', Boolean(selected));
        });
      }

      function selectTable(schema, table) {
        state.tableSelection = { schema, table };
        highlightSelectedTable();
        loadTableDetail(schema, table);
      }

      async function loadTableDetail(schema, table) {
        tableDetailTitle.textContent = schema + '.' + table;
        tableDetailMeta.textContent =
          'サンプル件数 ' + state.tableLimit + ' 行 (取得には多少時間がかかることがあります)';
        tableDetailBody.innerHTML = '<p class="muted">テーブルサンプルを取得中…</p>';
        const cacheKey = schema + '.' + table + '::' + state.tableLimit;
        if (state.tableCache.has(cacheKey)) {
          const cached = state.tableCache.get(cacheKey);
          renderTableDetail(schema, table, cached);
          return;
        }
        try {
          const [columns, sample] = await Promise.all([
            fetchJson('/api/v1/db/tables/' + encodeURIComponent(schema) + '/' + encodeURIComponent(table) + '/columns'),
            fetchJson(
              '/api/v1/db/tables/' +
                encodeURIComponent(schema) +
                '/' +
                encodeURIComponent(table) +
                '?limit=' +
                Number(state.tableLimit),
            ),
          ]);
          const payload = {
            schema,
            table,
            columns,
            sample,
            fetchedAt: new Date().toISOString(),
          };
          state.tableCache.set(cacheKey, payload);
          renderTableDetail(schema, table, payload);
        } catch (error) {
          console.error('Failed to load table detail', error);
          tableDetailBody.innerHTML =
            '<p class="error">テーブルデータの取得に失敗しました。' + (error instanceof Error ? error.message : '') + '</p>';
        }
      }

      function renderTableDetail(schema, table, payload) {
        const tableInfo =
          state.tables.find((item) => item.schema === schema && item.name === table) ??
          state.filteredTables.find((item) => item.schema === schema && item.name === table);
        tableDetailMeta.textContent =
          '推定行数: ' +
          (tableInfo ? tableInfo.rowEstimate.toLocaleString() : '不明') +
          ' / サイズ: ' +
          (tableInfo ? formatBytes(tableInfo.totalBytes) : '不明') +
          ' / 最終 ANALYZE: ' +
          (tableInfo?.lastAnalyzed ?? '不明');
        const columnList = Array.isArray(payload.columns?.columns)
          ? payload.columns.columns
          : Array.isArray(payload.columns)
            ? payload.columns
            : [];
        const sample = payload.sample ?? {};
        const sampleColumns = Array.isArray(sample.columns) ? sample.columns : [];
        const rows = Array.isArray(sample.rows) ? sample.rows : [];

        const columnTable =
          '<div class="data-grid"><table><thead><tr><th>列名</th><th>型</th><th>NULL 可</th></tr></thead><tbody>' +
          (columnList.length > 0
            ? columnList
                .map(
                  (col) =>
                    '<tr><td>' +
                    col.columnName +
                    '</td><td>' +
                    col.dataType +
                    '</td><td>' +
                    (col.isNullable ? 'YES' : 'NO') +
                    '</td></tr>',
                )
                .join('')
            : '<tr><td colspan="3" class="muted">列情報を取得できませんでした。</td></tr>') +
          '</tbody></table></div>';

        const rowTableHeader =
          '<thead><tr>' +
          (sampleColumns.length > 0
            ? sampleColumns.map((col) => '<th>' + col + '</th>').join('')
            : '<th>列が存在しません</th>') +
          '</tr></thead>';

        const rowTableBody =
          '<tbody>' +
          (rows.length > 0
            ? rows
                .map((row) => {
                  return (
                    '<tr>' +
                    sampleColumns
                      .map((col) => {
                        const value = row[col];
                        if (value === null || value === undefined) return '<td class="muted">NULL</td>';
                        if (typeof value === 'object') {
                          try {
                            return '<td><code>' + JSON.stringify(value) + '</code></td>';
                          } catch {
                            return '<td><code>[object]</code></td>';
                          }
                        }
                        return '<td>' + String(value) + '</td>';
                      })
                      .join('') +
                    '</tr>'
                  );
                })
                .join('')
            : '<tr><td colspan="' + Math.max(1, sampleColumns.length) + '" class="muted">サンプルデータがありません。</td></tr>') +
          '</tbody>';

        const dataTable =
          '<div class="data-grid"><table>' + rowTableHeader + rowTableBody + '</table></div><p class="muted">取得: ' + formatDate(sample.generatedAt) + '</p>';

        tableDetailBody.innerHTML =
          '<div class="detail-body" style="gap: 18px">' + columnTable + dataTable + '</div>';
      }

      async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error('Failed to fetch ' + url + ': ' + res.status);
        }
        return res.json();
      }

      async function refresh() {
        setGraphMeta('同期中…');
        graphStatus.textContent = '最新のデータを取得中です';
        const [graphResult, tasksResult, tablesResult, bucketsResult] = await Promise.allSettled([
          fetchJson('/api/v1/graph'),
          fetchJson('/api/v1/tasks'),
          fetchJson('/api/v1/db/tables'),
          fetchJson('/api/v1/storage/buckets'),
        ]);

        if (graphResult.status === 'fulfilled') {
          const snapshot = graphResult.value;
          state.snapshot = snapshot;
          renderGraph(snapshot);
          renderServiceList(snapshot);
          renderQueueMetrics(snapshot);
          updateSystemOverviewCards(snapshot);
          setGraphMeta('生成: ' + formatDate(snapshot.generatedAt));
          if (lastUpdated) lastUpdated.textContent = formatDate(snapshot.generatedAt);
          if (state.selectedNodeId) {
            const stillExists = snapshot.nodes.some((node) => node.id === state.selectedNodeId);
            if (!stillExists) {
              state.selectedNodeId = null;
              updateSelectionPanel(null);
              graphStatus.textContent = 'ノードをクリックすると関連するデータフローが強調表示されます';
            } else {
              const node = snapshot.nodes.find((candidate) => candidate.id === state.selectedNodeId);
              updateSelectionPanel(node ?? null);
              if (node) {
                graphStatus.textContent = node.label + ' の入出力をハイライトしています';
              }
            }
          } else {
            graphStatus.textContent = 'ノードをクリックすると関連するデータフローが強調表示されます';
          }
        } else {
          console.error('Graph fetch failed', graphResult.reason);
          showGraphError(graphResult.reason?.message ?? 'グラフ情報の取得に失敗しました');
        }

        if (tasksResult.status === 'fulfilled') {
          renderTasks(tasksResult.value);
        } else {
          console.error('Tasks fetch failed', tasksResult.reason);
          renderTasks({ tasks: [], error: tasksResult.reason?.message ?? '取得に失敗しました' });
        }

        if (tablesResult.status === 'fulfilled') {
          renderTables(tablesResult.value);
        } else {
          console.error('Tables fetch failed', tablesResult.reason);
          renderTables({ tables: [], error: tablesResult.reason?.message ?? '取得に失敗しました' });
        }

        if (bucketsResult.status === 'fulfilled') {
          renderBuckets(bucketsResult.value);
        } else {
          console.error('Buckets fetch failed', bucketsResult.reason);
          renderBuckets({ healthy: false, buckets: [], error: bucketsResult.reason?.message ?? '取得に失敗しました' });
        }
      }

      tableSearch?.addEventListener('input', applyTableFilter);
      tableLimitSelect?.addEventListener('change', () => {
        state.tableLimit = Number(tableLimitSelect.value);
        if (state.tableSelection) {
          loadTableDetail(state.tableSelection.schema, state.tableSelection.table);
        }
      });

      await refresh();
      setInterval(refresh, REFRESH_INTERVAL);
  `
}

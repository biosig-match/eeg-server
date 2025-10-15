export function buildDashboardScript(effectiveRefreshMs: number): string {
  return `
      const REFRESH_INTERVAL = ${effectiveRefreshMs};
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const XLINK_NS = 'http://www.w3.org/1999/xlink';
      const KIND_ORDER = ['gateway', 'broker', 'database', 'service', 'queue', 'storage'];
      const KIND_LAYOUT = {
        gateway: { factor: 0.18, stretchX: 0.7, stretchY: 0.6 },
        broker: { factor: 0.32, stretchX: 0.85, stretchY: 0.75 },
        database: { factor: 0.48, stretchX: 0.95, stretchY: 0.9 },
        service: { factor: 0.72, stretchX: 1.1, stretchY: 1 },
        queue: { factor: 0.98, stretchX: 1.22, stretchY: 1.05 },
        storage: { factor: 1.24, stretchX: 1.35, stretchY: 1.15 },
      };
      const NODE_RADIUS = {
        gateway: 28,
        service: 28,
        queue: 26,
        broker: 28,
        database: 32,
        storage: 34,
      };
      const MIN_RING_GAP = 90;
      const GRAPH_MARGIN_X = 120;
      const GRAPH_MARGIN_Y = 96;
      const MAX_ARC_SPAN = Math.PI * 1.6;

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

      function nodeRadius(kind) {
        return NODE_RADIUS[kind] ?? 28;
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

        const width = graphShell.clientWidth || 1200;
        const height = graphShell.clientHeight || Math.max(Math.floor(width / 3), 420);
        graphSvg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        graphSvg.setAttribute('width', String(width));
        graphSvg.setAttribute('height', String(height));
        if (graphSvg instanceof SVGSVGElement && !graphSvg.hasAttribute('xmlns:xlink')) {
          graphSvg.setAttribute('xmlns:xlink', XLINK_NS);
        }
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
        graphSvg.appendChild(defs);

        const grouped = new Map();
        for (const node of snapshot.nodes) {
          if (!grouped.has(node.kind)) grouped.set(node.kind, []);
          grouped.get(node.kind).push(node);
        }

        const positions = new Map();
        const centerX = width / 2;
        const centerY = height / 2;
        const baseRadiusX = Math.max(width / 2 - GRAPH_MARGIN_X, 280);
        const baseRadiusY = Math.max(height / 2 - GRAPH_MARGIN_Y, 180);

        for (const kind of KIND_ORDER) {
          const nodesOfKind = grouped.get(kind) ?? [];
          if (nodesOfKind.length === 0) continue;
          const layout = KIND_LAYOUT[kind] ?? { factor: 0.82, stretchX: 1, stretchY: 1 };
          const nodeSize = nodeRadius(kind);
          let radiusX = Math.max(baseRadiusX * (layout.factor ?? 0.8) * (layout.stretchX ?? 1), nodeSize + MIN_RING_GAP);
          let radiusY = Math.max(
            baseRadiusY * (layout.factor ?? 0.8) * (layout.stretchY ?? 1),
            nodeSize + MIN_RING_GAP * 0.6,
          );
          radiusX = Math.min(radiusX, width / 2 - nodeSize - GRAPH_MARGIN_X / 3);
          radiusY = Math.min(radiusY, height / 2 - nodeSize - GRAPH_MARGIN_Y / 3);
          if (radiusY < nodeSize + 36) radiusY = nodeSize + 36;
          const approxCircumference = Math.PI * (radiusX + radiusY);
          const requiredPerNode = nodeSize * 2 + MIN_RING_GAP * 0.6;
          if (approxCircumference < requiredPerNode * nodesOfKind.length) {
            const scale = (requiredPerNode * nodesOfKind.length) / Math.max(approxCircumference, 1);
            radiusX = Math.min(radiusX * scale * 0.75, width / 2 - nodeSize - GRAPH_MARGIN_X / 4);
            radiusY = Math.min(radiusY * scale * 0.75, height / 2 - nodeSize - GRAPH_MARGIN_Y / 4);
          }
          const span =
            nodesOfKind.length > 1
              ? Math.min(MAX_ARC_SPAN, Math.max(Math.PI * 0.9, (nodesOfKind.length - 1) * (Math.PI / 4.8)))
              : 0;
          const startAngle = -Math.PI / 2 - span / 2;
          const sorted = nodesOfKind.slice().sort((a, b) => a.label.localeCompare(b.label, 'ja'));
          sorted.forEach((node, index) => {
            const angle =
              nodesOfKind.length > 1 ? startAngle + (span * index) / (nodesOfKind.length - 1) : -Math.PI / 2;
            const jitter =
              sorted.length > 3 ? ((index % 2 === 0 ? 1 : -1) * Math.PI) / Math.max(sorted.length * 22, 120) : 0;
            const x = centerX + radiusX * Math.cos(angle + jitter);
            const y = centerY + radiusY * Math.sin(angle + jitter * 0.5);
            positions.set(node.id, { x, y });
          });
        }

        const fallbackNodes = snapshot.nodes.filter((node) => !positions.has(node.id));
        if (fallbackNodes.length > 0) {
          const radiusX = Math.min(width / 2 - GRAPH_MARGIN_X / 2, baseRadiusX * 1.32);
          const radiusY = Math.min(height / 2 - GRAPH_MARGIN_Y / 2, baseRadiusY * 1.22);
          const span = Math.min(MAX_ARC_SPAN, Math.PI * 1.5);
          const startAngle = -Math.PI / 2 - span / 2;
          fallbackNodes.forEach((node, index) => {
            const angle = fallbackNodes.length > 1 ? startAngle + (span * index) / (fallbackNodes.length - 1) : -Math.PI / 2;
            const x = centerX + radiusX * Math.cos(angle);
            const y = centerY + radiusY * Math.sin(angle);
            positions.set(node.id, { x, y });
          });
        }

        const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));

        const edgeGroup = document.createElementNS(SVG_NS, 'g');
        edgeGroup.setAttribute('class', 'edges');
        graphSvg.appendChild(edgeGroup);
        const pulsesGroup = document.createElementNS(SVG_NS, 'g');
        pulsesGroup.setAttribute('class', 'edge-pulses');
        graphSvg.appendChild(pulsesGroup);

        const edges = snapshot.edges ?? [];
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
          if (!fromPos || !toPos || !fromNode || !toNode) continue;
          const dx = toPos.x - fromPos.x;
          const dy = toPos.y - fromPos.y;
          const distance = Math.hypot(dx, dy) || 1;
          const startOffset = nodeRadius(fromNode.kind) + 6;
          const endOffset = nodeRadius(toNode.kind) + 12;
          const startX = fromPos.x + (dx / distance) * startOffset;
          const startY = fromPos.y + (dy / distance) * startOffset;
          const endX = toPos.x - (dx / distance) * endOffset;
          const endY = toPos.y - (dy / distance) * endOffset;
          const path = document.createElementNS(SVG_NS, 'path');
          const curvature = 0.22;
          const controlX = (startX + endX) / 2 - dy * curvature;
          const controlY = (startY + endY) / 2 + dx * curvature;
          path.setAttribute('d', ['M', startX, startY, 'Q', controlX, controlY, endX, endY].join(' '));
          path.setAttribute('class', 'flow-path kind-' + edge.kind);
          const metrics = edge.metrics ?? {};
          const rate = Math.max(metrics.publishRate ?? 0, metrics.deliverRate ?? 0);
          const backlog = Math.max(metrics.messagesReady ?? 0, metrics.messages ?? 0);
          const intensity = rate > 0 ? rate : backlog / Math.max(maxBacklog / 4, 25);
          const baseWidth = 1.8 + Math.min(intensity, 6) * 0.6;
          path.style.setProperty('--base-width', baseWidth.toFixed(2));
          path.style.strokeWidth = baseWidth.toFixed(2);
          const speed = intensity > 0 ? Math.max(0.8, 6 / Math.min(intensity, 8)) : 4;
          path.style.setProperty('--flow-speed', speed.toFixed(2) + 's');
          const pathId = 'edge-' + edge.id;
          path.setAttribute('id', pathId);
          path.dataset.edgeId = edge.id;
          path.dataset.from = edge.from;
          path.dataset.to = edge.to;
          if (intensity > 0.05) {
            path.classList.add('has-traffic');
            activeEdges += 1;
          }
          edgeGroup.appendChild(path);

          if (intensity > 0.05) {
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
          state.graphElements.edges.set(edge.id, path);
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
          group.style.setProperty('--node-radius', String(nodeRadius(node.kind)));

          const circle = document.createElementNS(SVG_NS, 'circle');
          circle.setAttribute('cx', String(pos.x));
          circle.setAttribute('cy', String(pos.y));
          circle.setAttribute('r', String(nodeRadius(node.kind)));
          circle.setAttribute('class', 'node-circle ' + statusClass(node.status?.level) + ' kind-' + node.kind);
          group.appendChild(circle);

          const label = document.createElementNS(SVG_NS, 'text');
          label.setAttribute('x', String(pos.x));
          label.setAttribute('y', String(pos.y + nodeRadius(node.kind) + 16));
          label.setAttribute('class', 'node-label');
          label.textContent = node.label;
          group.appendChild(label);

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
                node.description +
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
        applySelectionHighlight();
        graphSummary.textContent =
          snapshot.nodes.length +
          ' ノード / ' +
          (snapshot.edges?.length ?? 0) +
          ' エッジ (アクティブ: ' +
          activeEdges +
          ')';
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
  `;
}

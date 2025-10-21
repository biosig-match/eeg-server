import { buildDashboardBody } from './dashboardBody'
import { buildDashboardScript } from './dashboardScript'
import { dashboardStyles } from './styles'

interface DashboardOptions {
  refreshIntervalMs: number
}

export function buildDashboardHtml(options: DashboardOptions) {
  const effectiveRefreshMs = Math.min(options.refreshIntervalMs, 7000)
  const effectiveRefreshSeconds = Math.max(1, Math.round(effectiveRefreshMs / 1000))

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EEG Observability Dashboard</title>
    <style>
${dashboardStyles}
    </style>
  </head>
  <body>
${buildDashboardBody(effectiveRefreshSeconds)}
    <script type="module">
${buildDashboardScript(effectiveRefreshMs)}
    </script>
  </body>
</html>`
}

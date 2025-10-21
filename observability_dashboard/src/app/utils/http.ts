export async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number, init: RequestInit = {}): Promise<{
  ok: boolean
  status: number
  data?: T
  error?: string
}> {
  try {
    const response = await fetchWithTimeout(url, timeoutMs, init)
    const status = response.status
    if (!response.ok) {
      return { ok: false, status, error: `Request failed with status ${status}` }
    }
    const data = (await response.json()) as T
    return { ok: true, status, data }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    }
  }
}

const TOKEN_KEY = 'viveo.lab.token'

export function readToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

export function writeToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY)
}

async function request(path, { method = 'GET', token = '', body } = {}) {
  const headers = { 'x-viveo-path': path }
  if (token) headers['x-viveo-token'] = token
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    throw new Error('A API não respondeu JSON. Publique a bancada de novo.')
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir o pedido.')
  return payload
}

export function login(token) {
  return request('/api/login', { method: 'POST', body: { token } })
}

export function catalog(token) {
  return request('/api/catalog', { token })
}

export function openSession(token, variables) {
  return request('/api/session', { method: 'POST', token, body: { variables } })
}

export function conversationResult(token, conversationId) {
  return request(`/api/conversation?conversation_id=${encodeURIComponent(conversationId)}`, { token })
}

export function listBatches(token) {
  return request('/api/batches', { token })
}

export function batchDetail(token, batchId) {
  return request(`/api/batches/${encodeURIComponent(batchId)}`, { token })
}

export function batchAnalysis(token, batchId, offset) {
  return request(`/api/batches/${encodeURIComponent(batchId)}/analysis?offset=${offset}`, { token })
}

export function submitBatch(token, body) {
  return request('/api/batches', { method: 'POST', token, body })
}

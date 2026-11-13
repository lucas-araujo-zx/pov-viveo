import { agentDisplayName, resolveAgent, tokensMatch } from './agents.js'
import {
  ANALYSIS_GAP_MS,
  ANALYSIS_PAGE,
  buildRecipients,
  phoneList,
  planBatch,
  presentBatch,
  presentBatchList,
  retryAfterMs,
  submitBatch,
  wait,
} from './batch.js'
import { isConversationId, presentConversation, summarizeCriteria } from './conversation.js'
import { columnsFor, phoneConflict } from './sheet.js'
import { collectVariables, criteriaDefinitions, readVariableValues } from './variables.js'

const BATCH_ID = /^[A-Za-z0-9_-]{8,128}$/

function requestUrl(req) {
  return new URL(req.url ?? '/', 'http://localhost')
}

function headerValue(req, name) {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2_000_000) {
        reject(new Error('payload'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('json'))
      }
    })
    req.on('error', reject)
  })
}

function authError(token, env) {
  if (!env.loginToken) {
    return { status: 503, error: 'O acesso desta bancada ainda não foi configurado.' }
  }
  if (!tokensMatch(token, env.loginToken)) {
    return { status: 401, error: 'Token inválido.' }
  }
  return null
}

function elevenMessage(status, body) {
  const detail = body?.detail
  const text = typeof detail === 'string' ? detail : detail?.message || detail?.status || ''
  if (status === 401) return 'A chave da ElevenLabs foi recusada.'
  if (status === 404) return 'Não encontrei esse recurso na ElevenLabs.'
  if (status === 429) {
    if (/concurrent/i.test(String(text))) {
      return 'A ElevenLabs limitou a concorrência. O lote dela já segura o ritmo; espere e tente de novo.'
    }
    return 'A ElevenLabs pediu uma pausa. Espere um instante e tente de novo.'
  }
  return 'Não foi possível falar com a ElevenLabs.'
}

async function elevenFetch(env, path, init) {
  if (!env.apiKey) {
    return { ok: false, status: 503, error: 'A ElevenLabs ainda não foi configurada.' }
  }
  let response
  try {
    response = await fetch(`https://api.elevenlabs.io${path}`, {
      ...init,
      headers: {
        'xi-api-key': env.apiKey,
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    return { ok: false, status: 502, error: 'Não foi possível falar com a ElevenLabs.' }
  }
  const retryAfter = response.headers.get('retry-after') || ''
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (response.ok) return { ok: true, status: response.status, body, retryAfter }
  return {
    ok: false,
    status: response.status,
    body,
    retryAfter,
    error: elevenMessage(response.status, body),
  }
}

async function loadAgent(env, agent) {
  const remote = await elevenFetch(env, `/v1/convai/agents/${agent.id}`)
  if (!remote.ok) return { error: remote }
  return { agent: remote.body, name: agentDisplayName(remote.body) || agent.name }
}

async function loadPhone(env, agentId) {
  const remote = await elevenFetch(env, '/v1/convai/phone-numbers')
  if (!remote.ok) return { error: remote.error, phone: null }
  return { error: '', phone: phoneList(remote.body, agentId)[0] ?? null }
}

function batchPath(pathname) {
  const match = pathname.match(/^\/api\/batches\/([A-Za-z0-9_-]+)(\/analysis)?$/)
  if (!match || !BATCH_ID.test(match[1])) return null
  return { id: match[1], analysis: Boolean(match[2]) }
}

async function ownedBatch(env, agentId, batchId) {
  const remote = await elevenFetch(env, `/v1/convai/batch-calling/${encodeURIComponent(batchId)}`)
  if (!remote.ok) return { error: remote }
  const batch = presentBatch(remote.body)
  if (batch.agentId && batch.agentId !== agentId) {
    return { error: { status: 404, error: 'Lote não encontrado.' } }
  }
  return { batch }
}

export async function dispatchApi({ method, pathname, searchParams, token, body }, env) {
  const path = pathname.replace(/\/+$/, '') || '/'
  const voice = resolveAgent(env)

  if (path === '/api/login' && method === 'POST') {
    const error = authError(String(body?.token ?? '').trim(), env)
    if (error) return { status: error.status, payload: { error: error.error } }
    return { status: 200, payload: { ok: true } }
  }

  if (!path.startsWith('/api/')) return null

  const denied = authError(token, env)
  if (denied) return { status: denied.status, payload: { error: denied.error } }

  if (path === '/api/catalog' && method === 'GET') {
    const loaded = await loadAgent(env, voice)
    if (loaded.error) return { status: loaded.error.status, payload: { error: loaded.error.error } }
    const phone = await loadPhone(env, voice.id)
    const variables = collectVariables(loaded.agent)
    return {
      status: 200,
      payload: {
        agent: { id: voice.id, name: loaded.name },
        variables,
        columns: columnsFor(variables),
        phoneConflict: phoneConflict(variables),
        phone: phone.phone,
        phoneError: phone.error,
        criteria: criteriaDefinitions(loaded.agent),
      },
    }
  }

  if (path === '/api/session' && method === 'POST') {
    const loaded = await loadAgent(env, voice)
    if (loaded.error) return { status: loaded.error.status, payload: { error: loaded.error.error } }
    const declared = collectVariables(loaded.agent)
    const filled = readVariableValues(declared, body?.variables)
    if (filled.missing.length) {
      return { status: 400, payload: { error: 'Preencha os campos para prosseguir.', missing: filled.missing } }
    }
    const remote = await elevenFetch(
      env,
      `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(voice.id)}`,
    )
    if (!remote.ok) return { status: remote.status, payload: { error: remote.error } }
    if (typeof remote.body?.signed_url !== 'string' || !remote.body.signed_url) {
      return { status: 502, payload: { error: 'A ElevenLabs não devolveu a sessão.' } }
    }
    return {
      status: 200,
      payload: { signedUrl: remote.body.signed_url, dynamicVariables: filled.values },
    }
  }

  if (path === '/api/conversation' && method === 'GET') {
    const conversationId = searchParams.get('conversation_id') ?? ''
    if (!isConversationId(conversationId)) {
      return { status: 400, payload: { error: 'Informe o ID da conversa.' } }
    }
    const remote = await elevenFetch(env, `/v1/convai/conversations/${encodeURIComponent(conversationId)}`)
    if (!remote.ok) return { status: remote.status, payload: { error: remote.error } }
    const owner = typeof remote.body?.agent_id === 'string' ? remote.body.agent_id : ''
    if (owner && owner !== voice.id) {
      return { status: 404, payload: { error: 'Conversa não encontrada.' } }
    }
    return { status: 200, payload: presentConversation(remote.body, conversationId) }
  }

  if (path === '/api/batches' && method === 'GET') {
    const remote = await elevenFetch(
      env,
      `/v1/convai/batch-calling/workspace?agent_id=${encodeURIComponent(voice.id)}&limit=30`,
    )
    if (!remote.ok) return { status: remote.status, payload: { error: remote.error } }
    return { status: 200, payload: { batches: presentBatchList(remote.body, voice.id) } }
  }

  if (path === '/api/batches' && method === 'POST') {
    const loaded = await loadAgent(env, voice)
    if (loaded.error) return { status: loaded.error.status, payload: { error: loaded.error.error } }
    const phone = await loadPhone(env, voice.id)
    if (phone.error) return { status: 502, payload: { error: phone.error } }
    if (!phone.phone) {
      return {
        status: 409,
        payload: { error: 'Este agente não tem um número de telefonia. Configure um número nele antes de disparar.' },
      }
    }
    const variables = collectVariables(loaded.agent)
    const planned = planBatch(variables, body?.callName, body?.recipients)
    if (planned.error) return { status: 400, payload: { error: planned.error } }
    const sent = await submitBatch(
      (apiPath, init) => elevenFetch(env, apiPath, init),
      {
        callName: String(body.callName),
        agentId: voice.id,
        phoneNumberId: phone.phone.id,
        recipients: buildRecipients(planned.rows),
      },
    )
    if (!sent.ok) return { status: sent.status, payload: { error: sent.error } }
    return { status: 200, payload: { batch: sent.batch, submitted: planned.rows.length } }
  }

  const batch = batchPath(path)
  if (batch && method === 'GET') {
    const owned = await ownedBatch(env, voice.id, batch.id)
    if (owned.error) return { status: owned.error.status, payload: { error: owned.error.error } }
    if (!batch.analysis) return { status: 200, payload: owned.batch }

    const loaded = await loadAgent(env, voice)
    if (loaded.error) return { status: loaded.error.status, payload: { error: loaded.error.error } }
    const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
    const withConversation = owned.batch.recipients.filter((item) => item.conversationId)
    const slice = withConversation.slice(offset, offset + ANALYSIS_PAGE)
    const conversations = []
    for (const recipient of slice) {
      let remote = await elevenFetch(
        env,
        `/v1/convai/conversations/${encodeURIComponent(recipient.conversationId)}`,
      )
      if (remote.status === 429) {
        await wait(retryAfterMs(remote.retryAfter, 0))
        remote = await elevenFetch(
          env,
          `/v1/convai/conversations/${encodeURIComponent(recipient.conversationId)}`,
        )
      }
      conversations.push(
        remote.ok
          ? presentConversation(remote.body, recipient.conversationId)
          : { conversationId: recipient.conversationId, ready: false, criteria: [] },
      )
      await wait(ANALYSIS_GAP_MS)
    }
    const definitions = criteriaDefinitions(loaded.agent)
    const page = summarizeCriteria(definitions, conversations)
    const next = offset + slice.length
    return {
      status: 200,
      payload: {
        ...page,
        definitions,
        offset,
        nextOffset: next < withConversation.length ? next : null,
        total: withConversation.length,
        samples: conversations.flatMap((item) => (item.ready ? item.criteria : [])),
      },
    }
  }

  if (path.startsWith('/api/') && method !== 'GET' && method !== 'POST') {
    return { status: 405, payload: { error: 'Método não permitido.' } }
  }
  return { status: 404, payload: { error: 'Não encontrado.' } }
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function labApiPlugin(env) {
  const safe = {
    loginToken: env.loginToken?.trim() ?? '',
    apiKey: env.apiKey?.trim() ?? '',
    voiceAgentId: env.voiceAgentId?.trim() ?? '',
  }
  const attach = (middlewares) => {
    middlewares.use((req, res, next) => {
      const url = requestUrl(req)
      if (!url.pathname.startsWith('/api/')) {
        next()
        return
      }
      void (async () => {
        const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
        return dispatchApi(
          {
            method: req.method ?? 'GET',
            pathname: url.pathname,
            searchParams: url.searchParams,
            token: headerValue(req, 'x-viveo-token'),
            body: payload,
          },
          safe,
        )
      })()
        .then((result) => {
          if (!result) {
            next()
            return
          }
          json(res, result.status, result.payload)
        })
        .catch((error) => {
          if (!res.headersSent) {
            const invalid = error instanceof Error && (error.message === 'json' || error.message === 'payload')
            json(res, invalid ? 400 : 500, {
              error: invalid ? 'Não consegui ler o pedido.' : 'Falha interna.',
            })
          }
        })
    })
  }
  return {
    name: 'viveo-lab-api',
    configureServer(server) {
      attach(server.middlewares)
    },
    configurePreviewServer(server) {
      attach(server.middlewares)
    },
  }
}

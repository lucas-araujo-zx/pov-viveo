import assert from 'node:assert/strict'
import test from 'node:test'
import { submitBatch } from './batch.js'
import { tokensMatch } from './agents.js'
import { dispatchApi } from './plugin.js'

const env = {
  loginToken: 'token-da-bancada',
  apiKey: 'chave',
  voiceAgentId: 'agent_6301m37774dyfrerxs9aw52gexxs',
}

const agentBody = {
  name: 'Sofia',
  conversation_config: {
    agent: {
      dynamic_variables: { dynamic_variable_placeholders: { nome_unidade: 'Sul' } },
      prompt: { prompt: 'Olá' },
      first_message: '',
    },
  },
  platform_settings: {
    evaluation: {
      criteria: [{ id: 'qualificacao_completa', name: 'Qualificação', scoring_mode: 'binary' }],
    },
  },
}

function call(method, pathname, token, search = '', body) {
  return dispatchApi(
    { method, pathname, searchParams: new URLSearchParams(search), token, body },
    env,
  )
}

test('o token da bancada entra e outro token não', async () => {
  assert.equal(tokensMatch(env.loginToken, env.loginToken), true)
  const denied = await call('POST', '/api/login', '', '', { token: 'errado' })
  assert.equal(denied.status, 401)
  const ok = await call('POST', '/api/login', '', '', { token: env.loginToken })
  assert.equal(ok.payload.ok, true)
})

test('o catálogo devolve variáveis, critério e a ausência de número', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/phone-numbers')) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (href.includes('/agents/')) {
      return new Response(JSON.stringify(agentBody), { status: 200 })
    }
    return new Response('no', { status: 500 })
  }
  try {
    const catalog = await call('GET', '/api/catalog', env.loginToken)
    assert.equal(catalog.status, 200)
    assert.equal(catalog.payload.agent.name, 'Sofia')
    assert.equal(catalog.payload.variables[0].name, 'nome_unidade')
    assert.equal(catalog.payload.phone, null)
    assert.equal(catalog.payload.criteria[0].scoringMode, 'binary')
    const blocked = await call('POST', '/api/session', env.loginToken, '', { variables: {} })
    assert.equal(blocked.status, 400)
  } finally {
    globalThis.fetch = original
  }
})

test('a sessão só abre com as variáveis preenchidas', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('get-signed-url')) {
      return new Response(JSON.stringify({ signed_url: 'wss://sessao' }), { status: 200 })
    }
    if (href.includes('/agents/')) {
      return new Response(JSON.stringify(agentBody), { status: 200 })
    }
    return new Response('no', { status: 500 })
  }
  try {
    const session = await call('POST', '/api/session', env.loginToken, '', {
      variables: { nome_unidade: 'Clínica Sul' },
    })
    assert.equal(session.status, 200)
    assert.equal(session.payload.dynamicVariables.nome_unidade, 'Clínica Sul')
    assert.equal(session.payload.signedUrl, 'wss://sessao')
  } finally {
    globalThis.fetch = original
  }
})

test('sem número cadastrado o disparo não sai', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/phone-numbers')) return new Response(JSON.stringify([]), { status: 200 })
    if (href.includes('/agents/')) return new Response(JSON.stringify(agentBody), { status: 200 })
    return new Response('no', { status: 500 })
  }
  try {
    const denied = await call('POST', '/api/batches', env.loginToken, '', {
      callName: 'Março',
      recipients: [{ values: { phone_number: '11999998888', nome_unidade: 'Sul' } }],
    })
    assert.equal(denied.status, 409)
  } finally {
    globalThis.fetch = original
  }
})

test('o disparo usa um único lote e respeita o 429', async () => {
  const calls = []
  const sent = await submitBatch(
    async (path, init) => {
      calls.push({ path, body: JSON.parse(init.body) })
      if (calls.length === 1) return { ok: false, status: 429, retryAfter: '0', error: 'pausa' }
      return {
        ok: true,
        body: { id: 'btcal_lote1234', name: 'Março', agent_id: 'agent_6301m37774dyfrerxs9aw52gexxs', status: 'pending' },
      }
    },
    {
      callName: 'Março',
      agentId: 'agent_6301m37774dyfrerxs9aw52gexxs',
      phoneNumberId: 'phnum_12345678',
      recipients: [{ phone_number: '+5511999998888' }],
    },
  )
  assert.equal(sent.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, '/v1/convai/batch-calling/submit')
  assert.equal(calls[0].body.agent_phone_number_id, 'phnum_12345678')
  assert.equal(calls[0].body.recipients.length, 1)
  assert.equal('target_concurrency_limit' in calls[0].body, false)
})

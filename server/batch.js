import { campaignNameError, columnsFor, mapSheet } from './sheet.js'

export const ANALYSIS_PAGE = 12
export const ANALYSIS_GAP_MS = 250
export const SUBMIT_RETRIES = 3

export function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function retryAfterMs(header, attempt) {
  const raw = String(header ?? '').trim()
  const seconds = Number(raw)
  if (raw && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 20000)
  const backoff = 2000 * 2 ** attempt
  return Math.min(backoff, 20000)
}

export function presentPhone(item, agentId) {
  if (!item || typeof item !== 'object') return null
  const assigned = item.assigned_agent?.agent_id || item.assigned_agent_id || ''
  if (assigned !== agentId) return null
  if (item.supports_outbound === false) return null
  const id = String(item.phone_number_id || item.id || '').trim()
  const number = String(item.phone_number || '').trim()
  if (!id || !number) return null
  return {
    id,
    number,
    label: String(item.label || item.phone_number_name || '').trim(),
    provider: String(item.provider || '').trim(),
  }
}

export function phoneList(body, agentId) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.phone_numbers) ? body.phone_numbers : []
  return list.map((item) => presentPhone(item, agentId)).filter(Boolean)
}

export function buildRecipients(rows) {
  return rows.map((row) => {
    const dynamic = {}
    for (const [key, value] of Object.entries(row.values || {})) {
      if (key === 'phone_number' || value == null || value === '') continue
      dynamic[key] = value
    }
    const recipient = { phone_number: row.phone }
    if (Object.keys(dynamic).length) {
      recipient.conversation_initiation_client_data = { dynamic_variables: dynamic }
    }
    return recipient
  })
}

export function planBatch(variables, callName, recipients) {
  const nameError = campaignNameError(callName)
  if (nameError) return { error: nameError }
  const columns = columnsFor(variables)
  const headers = columns.map((column) => column.key)
  const rows = (Array.isArray(recipients) ? recipients : []).map((item) =>
    columns.map((column) => item?.values?.[column.key] ?? ''),
  )
  const mapped = mapSheet(headers, rows, columns)
  if (mapped.error) return { error: mapped.error }
  if (mapped.missingColumns?.length) {
    return { error: `Faltam colunas: ${mapped.missingColumns.join(', ')}.` }
  }
  const ready = mapped.rows.filter((row) => row.ok)
  if (!ready.length) return { error: 'Nenhuma linha está pronta para o disparo.' }
  return { rows: ready }
}

function batchSummary(body) {
  return {
    id: String(body?.id ?? ''),
    name: String(body?.name ?? ''),
    status: String(body?.status ?? ''),
    agentId: String(body?.agent_id ?? ''),
    phoneNumberId: body?.phone_number_id ? String(body.phone_number_id) : '',
    createdAt: Number(body?.created_at_unix) || null,
    scheduledAt: Number(body?.scheduled_time_unix) || null,
    dispatched: Number(body?.total_calls_dispatched) || 0,
    scheduled: Number(body?.total_calls_scheduled) || 0,
    finished: Number(body?.total_calls_finished) || 0,
    concurrency: body?.target_concurrency_limit == null ? null : Number(body.target_concurrency_limit),
  }
}

export function presentBatch(body) {
  const summary = batchSummary(body)
  const recipients = Array.isArray(body?.recipients) ? body.recipients : []
  return {
    ...summary,
    recipients: recipients.map((item) => ({
      id: String(item?.id ?? ''),
      phone: String(item?.phone_number ?? ''),
      status: String(item?.status ?? ''),
      conversationId: String(item?.conversation_id ?? ''),
    })),
  }
}

export function presentBatchList(body, agentId) {
  const calls = Array.isArray(body?.batch_calls) ? body.batch_calls : []
  return calls.map(batchSummary).filter((item) => !agentId || item.agentId === agentId)
}

export async function submitBatch(eleven, { callName, agentId, phoneNumberId, recipients }) {
  let last = null
  for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt += 1) {
    const response = await eleven('/v1/convai/batch-calling/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_name: callName.trim(),
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        timezone: 'America/Sao_Paulo',
        recipients,
      }),
    })
    last = response
    if (response.ok) return { ok: true, batch: batchSummary(response.body) }
    if (response.status !== 429 || attempt === SUBMIT_RETRIES) break
    await wait(retryAfterMs(response.retryAfter, attempt))
  }
  return { ok: false, status: last?.status || 502, error: last?.error || 'Não foi possível criar o lote.' }
}

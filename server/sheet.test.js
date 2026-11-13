import assert from 'node:assert/strict'
import test from 'node:test'
import { columnsFor, mapSheet, normalizePhone, parseCsv, phoneConflict } from './sheet.js'
import { collectVariables, readVariableValues } from './variables.js'
import { summarizeCriteria } from './conversation.js'
import { buildRecipients, planBatch, presentBatchList, retryAfterMs } from './batch.js'

test('telefone brasileiro ganha o 55 e o sinal de mais', () => {
  assert.deepEqual(normalizePhone('11 99999-8888'), { ok: true, phone: '+5511999998888' })
  assert.deepEqual(normalizePhone('+55 (11) 99999-8888'), { ok: true, phone: '+5511999998888' })
  assert.equal(normalizePhone('123').ok, false)
})

test('colunas obrigatórias são o telefone e as variáveis do agente', () => {
  const columns = columnsFor([{ name: 'nome_unidade', placeholder: 'Clínica Sul' }])
  assert.deepEqual(columns.map((column) => [column.key, column.required]), [
    ['phone_number', true],
    ['nome_unidade', true],
  ])
  assert.equal(phoneConflict([{ name: 'phone_number' }]), true)
})

test('a planilha aceita o alias telefone e recusa linha sem a variável', () => {
  const columns = columnsFor([{ name: 'nome_unidade', placeholder: '' }])
  const parsed = parseCsv('telefone;nome_unidade\n11999998888;Clínica Sul\n11988887777;\n')
  const mapped = mapSheet(parsed.headers, parsed.rows, columns)
  assert.equal(mapped.rows[0].ok, true)
  assert.equal(mapped.rows[0].phone, '+5511999998888')
  assert.equal(mapped.rows[1].ok, false)
})

test('variáveis saem dos placeholders e dos tokens do prompt', () => {
  const variables = collectVariables({
    conversation_config: {
      agent: {
        dynamic_variables: { dynamic_variable_placeholders: { nome_unidade: 'Sul' } },
        prompt: { prompt: 'Olá {{cidade}}' },
        first_message: '',
      },
    },
  })
  assert.deepEqual(variables.map((item) => item.name), ['nome_unidade', 'cidade'])
  const filled = readVariableValues(variables, { nome_unidade: ' Sul ', cidade: '' })
  assert.deepEqual(filled.missing, ['cidade'])
  assert.deepEqual(filled.values, { nome_unidade: 'Sul' })
})

test('critério binário conta sucesso e o numérico faz a média', () => {
  const summary = summarizeCriteria(
    [
      { id: 'qualificacao_completa', name: 'Qualificação', scoringMode: 'binary' },
      { id: 'nota', name: 'Nota', scoringMode: 'numeric' },
    ],
    [
      {
        ready: true,
        criteria: [
          { id: 'qualificacao_completa', result: 'success', score: null },
          { id: 'nota', result: 'unknown', score: 8 },
        ],
      },
      {
        ready: true,
        criteria: [
          { id: 'qualificacao_completa', result: 'failure', score: null },
          { id: 'nota', result: 'unknown', score: 6 },
        ],
      },
      { ready: false, criteria: [] },
    ],
  )
  assert.equal(summary.pending, 1)
  assert.equal(summary.analyzed, 2)
  assert.deepEqual(summary.criteria[0], {
    id: 'qualificacao_completa',
    name: 'Qualificação',
    kind: 'binary',
    success: 1,
    failure: 1,
    unknown: 0,
    decided: 2,
    percent: 50,
  })
  assert.equal(summary.criteria[1].average, 7)
  assert.equal(summary.criteria[1].count, 2)
})

test('o lote manda o telefone e as variáveis para a batch call', () => {
  const planned = planBatch(
    [{ name: 'nome_unidade', placeholder: '' }],
    'Credenciamento março',
    [{ values: { phone_number: '11999998888', nome_unidade: 'Clínica Sul' } }],
  )
  assert.equal(planned.error, undefined)
  assert.deepEqual(buildRecipients(planned.rows), [
    {
      phone_number: '+5511999998888',
      conversation_initiation_client_data: {
        dynamic_variables: { nome_unidade: 'Clínica Sul' },
      },
    },
  ])
})

test('a lista de lotes fica só no agente pedido', () => {
  const rows = presentBatchList(
    {
      batch_calls: [
        { id: 'btcal_aaaa1111', name: 'A', agent_id: 'agent_nossa', status: 'pending', total_calls_scheduled: 2 },
        { id: 'btcal_bbbb2222', name: 'B', agent_id: 'agent_outra', status: 'completed' },
      ],
    },
    'agent_nossa',
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'A')
  assert.equal(rows[0].scheduled, 2)
})

test('pausa de 429 usa Retry-After e tem teto', () => {
  assert.equal(retryAfterMs('3', 0), 3000)
  assert.equal(retryAfterMs('', 0), 2000)
  assert.equal(retryAfterMs('90', 0), 20000)
})

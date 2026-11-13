export const MAX_ROWS = 2000

const PHONE_ALIASES = ['phone_number', 'telefone', 'celular', 'phone', 'numero', 'fone', 'whatsapp']

export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function cleanValue(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, 1000)
}

export function cellToString(value) {
  if (value == null) return ''
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const utcMidnight =
      value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0
    const day = utcMidnight ? value.getUTCDate() : value.getDate()
    const month = (utcMidnight ? value.getUTCMonth() : value.getMonth()) + 1
    const year = utcMidnight ? value.getUTCFullYear() : value.getFullYear()
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return String(value).trim()
}

export function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  digits = digits.replace(/^0+/, '')
  if (!digits) return { ok: false, error: 'Telefone vazio.' }
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  if (digits.length < 12 || digits.length > 15) {
    return { ok: false, error: 'Use o DDD e o número, com ou sem o 55.' }
  }
  return { ok: true, phone: `+${digits}` }
}

export function columnsFor(variables) {
  const columns = [
    {
      key: 'phone_number',
      required: true,
      kind: 'phone',
      hint: 'Obrigatório. Número com DDD, como 11999998888 ou +5511999998888. A coluna também pode se chamar telefone, celular ou phone.',
      aliases: PHONE_ALIASES,
    },
  ]
  for (const variable of variables || []) {
    const name = String(variable?.name ?? '').trim()
    if (!name || normalizeHeader(name) === 'phone_number') continue
    const placeholder = variable.placeholder ? String(variable.placeholder) : ''
    columns.push({
      key: name,
      required: true,
      kind: 'variable',
      hint: placeholder
        ? `Obrigatório. Variável de entrada do agente. Exemplo: ${placeholder}.`
        : 'Obrigatório. Variável de entrada do agente. Cada linha precisa trazer um valor.',
      aliases: [],
    })
  }
  return columns
}

export function phoneConflict(variables) {
  return (variables || []).some((item) => normalizeHeader(item?.name) === 'phone_number')
}

function countOutsideQuotes(line, delimiter) {
  let count = 0
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1
      else quoted = !quoted
      continue
    }
    if (!quoted && char === delimiter) count += 1
  }
  return count
}

function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((item) => item.trim()) || ''
  const commas = countOutsideQuotes(line, ',')
  const semis = countOutsideQuotes(line, ';')
  return semis > commas ? ';' : ','
}

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (!source.trim()) return { error: 'O arquivo está vazio.' }
  const delimiter = detectDelimiter(source)
  const records = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(field)
      records.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }
  if (quoted) return { error: 'O CSV tem aspas sem fechar.' }
  if (field.length || row.length) {
    row.push(field)
    records.push(row)
  }
  if (!records.length || !records[0].some((cell) => String(cell).trim())) {
    return { error: 'Não encontrei o cabeçalho.' }
  }
  return {
    headers: records[0].map((cell) => String(cell).trim()),
    rows: records.slice(1).filter((item) => item.some((cell) => String(cell).trim())),
    warning: source.includes('\uFFFD')
      ? 'O arquivo parece não estar em UTF-8. Prefira XLSX ou exporte o CSV em UTF-8.'
      : '',
  }
}

export function escapeCsv(value) {
  const text = String(value ?? '')
  if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function sampleCsv(columns) {
  const header = columns.map((column) => escapeCsv(column.key)).join(';')
  return `\uFEFF${header}\n`
}

function planRow(columns, input) {
  const values = {}
  const missing = []
  for (const column of columns) {
    const value = cleanValue(input?.[column.key])
    values[column.key] = value
    if (column.required && !value) missing.push(column.key)
  }
  const phone = normalizePhone(values.phone_number || '')
  if (!phone.ok) return { ok: false, error: phone.error, values, phone: '' }
  values.phone_number = phone.phone
  const fields = missing.filter((key) => key !== 'phone_number')
  if (fields.length) {
    return { ok: false, error: `Preencha: ${fields.join(', ')}.`, values, phone: phone.phone }
  }
  return { ok: true, error: '', values, phone: phone.phone }
}

export function mapSheet(headers, rows, columns) {
  if (!Array.isArray(headers) || !headers.some((header) => String(header).trim())) {
    return { error: 'Não encontrei o cabeçalho.' }
  }
  if (!Array.isArray(rows)) return { error: 'Não encontrei linhas no arquivo.' }
  const filled = rows.filter((row) =>
    (Array.isArray(row) ? row : []).some((cell) => String(cell ?? '').trim()),
  )
  if (filled.length > MAX_ROWS) {
    return { error: `O arquivo passa de ${MAX_ROWS} linhas. Divida a planilha.` }
  }
  const used = new Set()
  const indexByKey = new Map()
  const unknown = []
  headers.forEach((header, index) => {
    const norm = normalizeHeader(header)
    if (!norm) return
    const column = columns.find(
      (item) =>
        !used.has(item.key) &&
        (normalizeHeader(item.key) === norm ||
          item.aliases.some((alias) => normalizeHeader(alias) === norm)),
    )
    if (!column) {
      unknown.push(String(header).trim())
      return
    }
    used.add(column.key)
    indexByKey.set(column.key, index)
  })
  const missingColumns = columns.filter((column) => column.required && !used.has(column.key)).map((column) => column.key)
  if (missingColumns.length) {
    return { error: '', missingColumns, unknown, duplicates: [], rows: [] }
  }
  const seen = new Map()
  const duplicates = []
  const mapped = []
  filled.forEach((row, index) => {
    const input = {}
    for (const column of columns) {
      const cell = row[indexByKey.get(column.key)]
      input[column.key] = cellToString(cell)
    }
    const planned = planRow(columns, input)
    const line = index + 2
    if (planned.ok) {
      const previous = seen.get(planned.phone)
      if (previous) {
        duplicates.push({ phone: planned.phone, lines: [previous, line] })
        mapped.push({ ...planned, line, ok: false, error: `Telefone repetido. A linha ${previous} fica com este número.` })
        return
      }
      seen.set(planned.phone, line)
    }
    mapped.push({ ...planned, line })
  })
  return { error: '', missingColumns: [], unknown, duplicates, rows: mapped }
}

export function campaignNameError(value) {
  const name = String(value ?? '').trim()
  if (!name) return 'Dê um nome ao lote.'
  if (name.length > 80) return 'O nome do lote passa de 80 caracteres.'
  return ''
}

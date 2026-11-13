import { useEffect, useMemo, useRef, useState } from 'react'
import { readSheet } from 'read-excel-file/browser'
import { listBatches, submitBatch } from './api.js'
import {
  campaignNameError,
  cellToString,
  mapSheet,
  parseCsv,
  sampleCsv,
} from '../server/sheet.js'

const STATUS = {
  pending: 'Na fila',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function when(unix) {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleString('pt-BR')
}

export function Disparos({ token, catalogData, onOpenBatch, onBack, onSignOut }) {
  const inputRef = useRef(null)
  const columns = catalogData.columns ?? []
  const phone = catalogData.phone
  const [campaignName, setCampaignName] = useState('')
  const [sheet, setSheet] = useState(null)
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [fileWarning, setFileWarning] = useState('')
  const [over, setOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [batches, setBatches] = useState([])
  const [listError, setListError] = useState('')

  const mapped = useMemo(() => {
    if (!sheet || !columns.length) return null
    return mapSheet(sheet.headers, sheet.rows, columns)
  }, [sheet, columns])
  const ready = mapped?.rows?.filter((row) => row.ok) ?? []
  const invalid = mapped?.rows?.filter((row) => !row.ok) ?? []
  const nameError = campaignNameError(campaignName)
  const canSend = Boolean(phone) && !nameError && !mapped?.error && !mapped?.missingColumns?.length && ready.length > 0 && !sending

  useEffect(() => {
    let cancelled = false
    listBatches(token)
      .then((data) => {
        if (!cancelled) setBatches(data.batches || [])
      })
      .catch((error) => {
        if (!cancelled) setListError(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function readFile(file) {
    setFileError('')
    setFileWarning('')
    setSendError('')
    const name = file.name.toLowerCase()
    if (file.size > 5 * 1024 * 1024) {
      setSheet(null)
      setFileError('O arquivo passa de 5 MB.')
      return
    }
    if (name.endsWith('.xls') && !name.endsWith('.xlsx')) {
      setSheet(null)
      setFileError('Salve a planilha como .xlsx. O formato .xls não entra neste disparo.')
      return
    }
    try {
      if (name.endsWith('.xlsx')) {
        const matrix = await readSheet(file)
        const table = matrix.map((row) => (Array.isArray(row) ? row : []).map((cell) => cellToString(cell)))
        setFileName(file.name)
        setSheet({ headers: table[0] || [], rows: table.slice(1) })
        return
      }
      if (name.endsWith('.csv') || file.type.includes('csv') || file.type.startsWith('text/')) {
        const parsed = parseCsv(await file.text())
        if (parsed.error) {
          setSheet(null)
          setFileError(parsed.error)
          return
        }
        setFileName(file.name)
        setFileWarning(parsed.warning || '')
        setSheet({ headers: parsed.headers, rows: parsed.rows })
        return
      }
      setSheet(null)
      setFileError('Envie um arquivo .csv ou .xlsx.')
    } catch {
      setSheet(null)
      setFileError('Não consegui ler este arquivo. Salve como .xlsx ou CSV em UTF-8.')
    }
  }

  async function dispatch() {
    if (!canSend) return
    setSending(true)
    setSendError('')
    try {
      await submitBatch(token, {
        callName: campaignName.trim(),
        recipients: ready.map((row) => ({ values: row.values })),
      })
      const data = await listBatches(token)
      setBatches(data.batches || [])
      setSheet(null)
      setFileName('')
      setCampaignName('')
    } catch (error) {
      setSendError(error.message)
    } finally {
      setSending(false)
    }
  }

  const preview = (mapped?.rows || []).slice(0, 6)

  return (
    <div className="dispatch-page">
      <header className="talk-top">
        <div className="talk-brand">
          <p className="wordmark">Humânia Saúde</p>
          <p className="talk-user">Disparo (telefonia)</p>
        </div>
        <div className="talk-actions">
          <button type="button" className="quiet" onClick={onBack}>
            Início
          </button>
          <button type="button" className="quiet" onClick={onSignOut}>
            Sair
          </button>
        </div>
      </header>
      <main className="dispatch-main">
        <p className="kicker">Lote da ElevenLabs</p>
        <h1>Disparo por telefonia</h1>
        <p className="home-lead">
          Cada linha da planilha entra num lote. A ElevenLabs dispara as ligações respeitando o menor valor entre 50% da
          concorrência da conta e 70% da concorrência do agente, para não ocupar a linha inteira.
        </p>

        <h2>Número do agente</h2>
        {catalogData.phoneError ? <p className="sheet-alert">{catalogData.phoneError}</p> : null}
        {phone ? (
          <p className="phone-pin">
            <strong>{phone.label || 'Número cadastrado'}</strong>
            <span>{phone.number}</span>
            {phone.provider ? <span>{phone.provider}</span> : null}
          </p>
        ) : (
          <p className="sheet-alert" role="alert">
            Este agente não tem um número de telefonia. Configure um número nele antes de disparar.
          </p>
        )}
        {catalogData.phoneConflict ? (
          <p className="sheet-alert">
            O agente tem uma variável chamada phone_number. Renomeie essa variável: essa coluna é o telefone de destino.
          </p>
        ) : null}

        <h2>Colunas obrigatórias</h2>
        <p className="home-lead">
          O arquivo precisa destas colunas para o agente funcionar. O telefone aceita os nomes telefone, celular e phone.
        </p>
        <div className="sheet-scroll">
          <table className="column-table">
            <thead>
              <tr>
                <th>Coluna</th>
                <th>Uso</th>
                <th>O que preencher</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.key}>
                  <td>{column.key}</td>
                  <td>{column.kind === 'phone' ? 'Telefone de destino' : 'Variável do agente'} · obrigatória</td>
                  <td>{column.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="mode-switch" onClick={() => download('modelo-disparo-sofia.csv', sampleCsv(columns))}>
          Baixar cabeçalho CSV
        </button>

        {phone ? (
          <>
            <h2>Planilha</h2>
            <label className="field">
              <span>Nome do lote</span>
              <input
                value={campaignName}
                disabled={sending}
                placeholder="Credenciamento de março"
                onChange={(event) => setCampaignName(event.target.value)}
              />
            </label>
            {campaignName && nameError ? <p className="sheet-alert">{nameError}</p> : null}
            <div
              className={over ? 'dropzone is-over' : 'dropzone'}
              onDragOver={(event) => {
                event.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault()
                setOver(false)
                const file = event.dataTransfer.files?.[0]
                if (file && !sending) void readFile(file)
              }}
            >
              <strong>{fileName || 'Solte o CSV ou XLSX aqui'}</strong>
              <p>Até 2000 linhas. No Excel, formate o telefone como texto.</p>
              <button type="button" className="mode-switch" disabled={sending} onClick={() => inputRef.current?.click()}>
                Selecionar arquivo
              </button>
              <input
                ref={inputRef}
                type="file"
                hidden
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void readFile(file)
                }}
              />
            </div>
            {fileError ? <p className="sheet-alert">{fileError}</p> : null}
            {fileWarning ? <p className="sheet-note">{fileWarning}</p> : null}
            {mapped?.missingColumns?.length ? (
              <p className="sheet-alert">Faltam colunas: {mapped.missingColumns.join(', ')}.</p>
            ) : null}
            {mapped && !mapped.error && !mapped.missingColumns.length ? (
              <p className="sheet-note">
                {ready.length} {ready.length === 1 ? 'linha pronta' : 'linhas prontas'}
                {invalid.length ? ` · ${invalid.length} fora do disparo` : ''}.
              </p>
            ) : null}
            {mapped?.unknown?.length ? (
              <p className="sheet-note">Estas colunas não entram no disparo: {mapped.unknown.join(', ')}.</p>
            ) : null}
            {mapped?.duplicates?.length ? (
              <p className="sheet-note">Há telefones repetidos. Só a primeira linha de cada número entra no lote.</p>
            ) : null}
            {preview.length ? (
              <div className="sheet-scroll">
                <table className="column-table">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      {columns.map((column) => (
                        <th key={column.key}>{column.key}</th>
                      ))}
                      <th>Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr key={row.line}>
                        <td>{row.line}</td>
                        {columns.map((column) => (
                          <td key={column.key}>{row.values[column.key] || '—'}</td>
                        ))}
                        <td>{row.ok ? 'Pronta' : row.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <button type="button" className="start-call" disabled={!canSend} onClick={dispatch}>
              {sending ? 'Enviando o lote...' : 'Disparar lote'}
            </button>
            {sendError ? <p className="sheet-alert">{sendError}</p> : null}
          </>
        ) : null}

        <h2>Lotes</h2>
        {listError ? <p className="sheet-alert">{listError}</p> : null}
        {batches.length === 0 ? <p className="sheet-note">Ainda não há lotes deste agente.</p> : null}
        <ul className="batch-list">
          {batches.map((item) => (
            <li key={item.id}>
              <button type="button" className="batch-row" onClick={() => onOpenBatch(item.id)}>
                <strong>{item.name || item.id}</strong>
                <span>{STATUS[item.status] || item.status}</span>
                <span>
                  {item.finished}/{item.scheduled || item.dispatched} ligações
                </span>
                <span>{when(item.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { batchAnalysis, batchDetail } from './api.js'
import { summarizeCriteria } from '../server/conversation.js'

const STATUS = {
  pending: 'Na fila',
  dispatched: 'Enviada',
  initiated: 'Iniciada',
  in_progress: 'Em andamento',
  completed: 'Concluída',
  done: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  voicemail: 'Caixa postal',
}

function percent(value) {
  if (value == null) return '—'
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

export function BatchDetail({ token, batchId, onBack, onSignOut }) {
  const [batch, setBatch] = useState(null)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  useEffect(() => {
    let cancelled = false
    setBatch(null)
    setSummary(null)
    setError('')
    async function load() {
      try {
        const detail = await batchDetail(token, batchId)
        if (cancelled) return
        setBatch(detail)
        const samples = []
        let definitions = []
        let offset = 0
        let pending = 0
        let analyzed = 0
        let total = 0
        do {
          const page = await batchAnalysis(token, batchId, offset)
          if (cancelled) return
          definitions = page.definitions || definitions
          samples.push(...(page.samples || []))
          pending += page.pending || 0
          analyzed += page.analyzed || 0
          total = page.total || 0
          setProgress({ done: Math.min(total, (page.offset || 0) + (page.analyzed || 0) + (page.pending || 0)), total })
          offset = page.nextOffset
        } while (offset != null)
        if (!cancelled) {
          const merged = summarizeCriteria(definitions, [
            { ready: true, criteria: samples },
            ...Array.from({ length: pending }, () => ({ ready: false, criteria: [] })),
          ])
          setSummary({ ...merged, analyzed, pending })
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o lote.')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token, batchId])

  return (
    <div className="dispatch-page">
      <header className="talk-top">
        <div className="talk-brand">
          <p className="wordmark">Humânia Saúde</p>
          <p className="talk-user">{batch?.name || 'Lote'}</p>
        </div>
        <div className="talk-actions">
          <button type="button" className="quiet" onClick={onBack}>
            Disparos
          </button>
          <button type="button" className="quiet" onClick={onSignOut}>
            Sair
          </button>
        </div>
      </header>
      <main className="dispatch-main">
        {error ? <p className="sheet-alert">{error}</p> : null}
        {!batch && !error ? <p className="sheet-note">Abrindo o lote...</p> : null}
        {summary ? (
          <section className="analysis-board" aria-label="Critérios de sucesso">
            <p className="kicker">Análise do lote</p>
            <h1>Critérios de sucesso</h1>
            <p className="home-lead">
              {summary.analyzed} {summary.analyzed === 1 ? 'chamada analisada' : 'chamadas analisadas'}
              {summary.pending ? ` · ${summary.pending} ainda sem análise` : ''}.
              {progress.total ? ` ${progress.done} de ${progress.total} lidas.` : ''}
            </p>
            <div className="choice-grid">
              {summary.criteria.map((item) => (
                <article key={item.id} className="choice-card">
                  <h2>{item.name}</h2>
                  {item.kind === 'numeric' ? (
                    <p>
                      Média <strong>{item.average == null ? '—' : item.average.toLocaleString('pt-BR')}</strong>
                      <span> em {item.count} {item.count === 1 ? 'valor' : 'valores'}</span>
                    </p>
                  ) : (
                    <p>
                      <strong>{item.success}</strong> de {item.decided} sucessos
                      <span> · {percent(item.percent)}</span>
                      {item.unknown ? <span> · {item.unknown} sem resultado</span> : null}
                    </p>
                  )}
                </article>
              ))}
              {summary.criteria.length === 0 ? <p className="sheet-note">Este agente não tem critérios de sucesso.</p> : null}
            </div>
          </section>
        ) : null}
        {batch ? (
          <>
            <h2>Chamadas</h2>
            <div className="sheet-scroll">
              <table className="column-table">
                <thead>
                  <tr>
                    <th>Telefone</th>
                    <th>Situação</th>
                    <th>Conversa</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.recipients.map((item) => (
                    <tr key={item.id || `${item.phone}-${item.conversationId}`}>
                      <td>{item.phone || '—'}</td>
                      <td>{STATUS[item.status] || item.status || '—'}</td>
                      <td>{item.conversationId || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {batch.recipients.length === 0 ? <p className="sheet-note">Este lote ainda não listou as ligações.</p> : null}
          </>
        ) : null}
      </main>
    </div>
  )
}

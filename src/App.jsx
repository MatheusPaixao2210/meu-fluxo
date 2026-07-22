import React, { useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from './supabase'

const CATEGORIAS = ['Salário', 'Renda extra', 'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Vestuário', 'Dívidas', 'Imposto', 'Investimentos', 'Outros']
const MAX_VALUE = 9_999_999_999.99
const MAX_IMPORT_ROWS = 500
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const eur = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'EUR' })
const monthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
const shortMonthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'short' })
const dateFormatter = new Intl.DateTimeFormat('pt-BR')

function getInitialForm() {
  return { data: new Date().toISOString().slice(0, 10), tipo: 'Gasto', moeda: 'EUR', categoria: 'Alimentação', categoriaOutro: '', descricao: '', valor: '' }
}

function formatMoney(value, currency = 'BRL') {
  return (currency === 'EUR' ? eur : brl).format(Number(value) || 0)
}

function toBrl(item, eurToBrl) {
  const amount = Number(item.valor)
  if (item.moeda === 'EUR') return eurToBrl ? amount * eurToBrl : null
  return amount
}

function convertFromBrl(value, currency, eurToBrl) {
  if (currency === 'EUR') return eurToBrl ? value / eurToBrl : null
  return value
}

function makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const values = new Uint32Array(8)
  crypto.getRandomValues(values)
  const code = Array.from(values, value => chars[value % chars.length]).join('')
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function normalizeImportText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function importValue(row, names) {
  const key = Object.keys(row).find(column => names.some(name => column === name || column.startsWith(`${name} `) || column.startsWith(`${name}(`)))
  return key === undefined ? undefined : row[key]
}

function importDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelDate = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000)
    if (!Number.isNaN(excelDate.getTime())) return excelDate.toISOString().slice(0, 10)
  }
  const text = String(value ?? '').trim()
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`
  const local = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/)
  if (local) {
    const year = local[3].length === 2 ? `20${local[3]}` : local[3]
    return `${year}-${String(local[2]).padStart(2, '0')}-${String(local[1]).padStart(2, '0')}`
  }
  return ''
}

function importAmount(value) {
  let text = String(value ?? '').trim()
  if (!text) return null
  const negative = text.includes('-') || /^\(.*\)$/.test(text)
  text = text.replace(/[^\d,.-]/g, '')
  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  else if (lastComma > -1) text = text.replace(',', '.')
  const amount = Number(text)
  if (!Number.isFinite(amount)) return null
  return negative ? -Math.abs(amount) : amount
}

function parseImportedRows(records) {
  const rows = []
  const issues = []
  records.slice(0, MAX_IMPORT_ROWS).forEach((source, index) => {
    const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [normalizeImportText(key), value]))
    const date = importDate(importValue(row, ['data', 'date', 'data do lancamento', 'data lancamento', 'data movimento', 'data operacao', 'transaction date', 'booking date']))
    const directValue = importValue(row, ['valor', 'value', 'amount', 'quantia', 'montante', 'valor movimento'])
    const debitValue = importValue(row, ['debito', 'despesa', 'saida', 'saidas'])
    const creditValue = importValue(row, ['credito', 'receita', 'entrada', 'entradas'])
    const rawValue = directValue ?? debitValue ?? creditValue
    const amount = importAmount(rawValue)
    if (!date || amount === null || amount === 0 || Math.abs(amount) > MAX_VALUE) {
      issues.push(`Linha ${index + 2}: data ou valor inválido.`)
      return
    }
    const rawType = normalizeImportText(importValue(row, ['tipo', 'type', 'natureza', 'movimento']))
    const tipo = amount < 0 || /gasto|despesa|debito|saida/.test(rawType)
      ? 'Gasto'
      : /recebimento|receita|entrada|credito|income/.test(rawType) || (directValue === undefined && creditValue !== undefined)
        ? 'Recebimento'
        : 'Gasto'
    const importedCategory = String(importValue(row, ['categoria', 'category', 'grupo', 'subcategoria']) ?? '').trim()
    const categoria = CATEGORIAS.find(category => normalizeImportText(category) === normalizeImportText(importedCategory)) || importedCategory || 'Outros'
    const descricao = String(importValue(row, ['descricao', 'description', 'historico', 'memo', 'nome', 'lancamento', 'detalhe', 'details']) ?? (importedCategory || 'Lançamento importado')).trim()
    const currency = normalizeImportText(importValue(row, ['moeda', 'currency', 'divisa']))
    rows.push({ data: date, tipo, categoria, descricao, valor: Math.abs(amount), moeda: /eur|euro|€/.test(currency) ? 'EUR' : 'BRL' })
  })
  if (records.length > MAX_IMPORT_ROWS) issues.push(`Foram consideradas apenas as primeiras ${MAX_IMPORT_ROWS} linhas do arquivo.`)
  return { rows, issues }
}

function AuthScreen({ onSession }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setMessage('')
    setBusy(true)
    const credentials = { email: email.trim(), password }
    const { data, error } = mode === 'login'
      ? await supabase.auth.signInWithPassword(credentials)
      : await supabase.auth.signUp({ ...credentials, options: { data: { nome: name.trim() } } })
    setBusy(false)
    if (error) return setMessage(error.message)
    if (mode === 'signup' && !data.session) return setMessage('Conta criada. Confirme o e-mail para entrar.')
    onSession(data.session)
  }

  return <main className="auth-layout"><section className="auth-card">
    <div className="brand-mark">MF</div><p className="eyebrow">FINANÇAS EM FAMÍLIA</p><h1>O seu dinheiro, claro e organizado.</h1>
    <p className="muted">Registre entradas e despesas. Os seus dados são privados e sincronizados em todos os dispositivos.</p>
    <div className="tab-list" role="tablist"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Entrar</button><button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Criar conta</button></div>
    <form onSubmit={submit} className="form-stack">
      {mode === 'signup' && <label>Nome<input required value={name} onChange={event => setName(event.target.value)} placeholder="Como quer ser chamado?" /></label>}
      <label>E-mail<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="nome@email.com" autoComplete="email" /></label>
      <label>Senha<input required type="password" minLength="6" value={password} onChange={event => setPassword(event.target.value)} placeholder="Pelo menos 6 caracteres" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {message && <p className="form-message">{message}</p>}<button className="button primary" disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar na conta' : 'Criar conta'}</button>
    </form>
  </section></main>
}

function SetupScreen() {
  return <main className="auth-layout"><section className="auth-card setup-card"><div className="brand-mark">MF</div><p className="eyebrow">CONFIGURAÇÃO NECESSÁRIA</p><h1>Ligue o seu Supabase</h1><p className="muted">Copie <code>.env.example</code> para <code>.env</code> e preencha a URL e a chave anon do seu projeto. Depois execute o SQL em <code>supabase/schema.sql</code>.</p></section></main>
}

function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return setLoading(false)
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => subscription.subscription.unsubscribe()
  }, [])

  if (!isSupabaseConfigured) return <SetupScreen />
  if (loading) return <main className="loading">A preparar a sua área…</main>
  return session ? <Dashboard session={session} /> : <AuthScreen onSession={setSession} />
}

function Dashboard({ session }) {
  const today = new Date()
  const [month, setMonth] = useState(today.getMonth())
  const [year, setYear] = useState(today.getFullYear())
  const [items, setItems] = useState([])
  const [annualItems, setAnnualItems] = useState([])
  const [savedCategories, setSavedCategories] = useState([])
  const [accounts, setAccounts] = useState([])
  const [activeAccountId, setActiveAccountId] = useState('personal')
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [activity, setActivity] = useState([])
  const [showAccounts, setShowAccounts] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [accountMessage, setAccountMessage] = useState('')
  const [accountMessageKind, setAccountMessageKind] = useState('error')
  const [accountBusy, setAccountBusy] = useState(false)
  const [profile, setProfile] = useState('')
  const [form, setForm] = useState(getInitialForm)
  const [editing, setEditing] = useState(null)
  const [showEntryForm, setShowEntryForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState('error')
  const [importRows, setImportRows] = useState([])
  const [importIssues, setImportIssues] = useState([])
  const [importFileName, setImportFileName] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importAccountId, setImportAccountId] = useState('personal')
  const [goals, setGoals] = useState([])
  const [showGoalForm, setShowGoalForm] = useState(false)
  const [goalForm, setGoalForm] = useState({ titulo: '', valor_meta: '', valor_atual: '0', moeda: 'EUR', prazo: '' })
  const [exchange, setExchange] = useState({ rate: null, date: '', loading: true, error: '' })
  const [displayCurrency, setDisplayCurrency] = useState('EUR')

  const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const periodEnd = new Date(year, month + 1, 1).toISOString().slice(0, 10)
  const yearStart = `${year}-01-01`
  const yearEnd = `${year + 1}-01-01`
  const activeAccount = accounts.find(account => account.id === activeAccountId)

  useEffect(() => { loadProfile(); loadAccounts() }, [])
  useEffect(() => { loadItems() }, [periodStart, periodEnd, activeAccountId])
  useEffect(() => { loadAnnualItems() }, [yearStart, yearEnd, activeAccountId])
  useEffect(() => { loadCategories() }, [activeAccountId])
  useEffect(() => { loadGoals() }, [activeAccountId])
  useEffect(() => { if (activeAccountId === 'personal') setActivity([]); else loadActivity() }, [activeAccountId])
  useEffect(() => {
    loadExchangeRate()
    const refreshId = window.setInterval(loadExchangeRate, 60 * 60 * 1000)
    return () => window.clearInterval(refreshId)
  }, [])

  async function loadProfile() {
    const { data } = await supabase.from('profiles').select('nome').eq('id', session.user.id).maybeSingle()
    if (data?.nome) return setProfile(data.nome)
    const name = session.user.user_metadata?.nome || session.user.email?.split('@')[0] || 'Usuário'
    const { error } = await supabase.from('profiles').upsert({ id: session.user.id, nome: name })
    if (!error) setProfile(name)
  }

  async function loadAccounts() {
    const { data, error } = await supabase.from('contas').select('id,nome,codigo_convite,owner_id').order('created_at')
    if (error) {
      setAccountMessageKind('error')
      setAccountMessage('Para usar contas conjuntas, execute a migração SQL indicada no projeto.')
      return false
    }
    setAccounts(data || [])
    return true
  }

  function queryForAccount(query, accountId) {
    return accountId === 'personal'
      ? query.eq('user_id', session.user.id).is('conta_id', null)
      : query.eq('conta_id', accountId)
  }

  function queryForActiveAccount(query) { return queryForAccount(query, activeAccountId) }

  async function loadItems() {
    const query = queryForActiveAccount(supabase.from('lancamentos').select('*').gte('data', periodStart).lt('data', periodEnd).order('data', { ascending: false }).order('created_at', { ascending: false }))
    const { data, error } = await query
    if (error) { setNoticeKind('error'); setNotice('Não foi possível carregar os lançamentos: ' + error.message); return false }
    setItems(data || [])
    return true
  }

  async function loadAnnualItems() {
    const query = queryForActiveAccount(supabase.from('lancamentos').select('*').gte('data', yearStart).lt('data', yearEnd))
    const { data, error } = await query
    if (error) { setNoticeKind('error'); setNotice('Não foi possível carregar o resumo anual: ' + error.message); return false }
    setAnnualItems(data || [])
    return true
  }

  async function loadCategories() {
    const query = queryForActiveAccount(supabase.from('categorias').select('nome').order('nome'))
    const { data, error } = await query
    if (error) return setSavedCategories([])
    setSavedCategories((data || []).map(category => category.nome))
  }

  async function loadGoals() {
    const query = queryForActiveAccount(supabase.from('metas').select('*').order('created_at', { ascending: false }))
    const { data, error } = await query
    if (error) return setGoals([])
    setGoals(data || [])
  }

  async function loadActivity() {
    const { data } = await supabase.from('lancamento_historico').select('*').eq('conta_id', activeAccountId).order('ocorrido_em', { ascending: false }).limit(10)
    setActivity(data || [])
  }

  async function loadExchangeRate() {
    setExchange(current => ({ ...current, loading: true, error: '' }))
    try {
      const response = await fetch('https://api.frankfurter.dev/v2/rate/EUR/BRL')
      if (!response.ok) throw new Error('A cotação não respondeu agora.')
      const data = await response.json()
      if (!Number(data.rate)) throw new Error('Cotação indisponível.')
      setExchange({ rate: Number(data.rate), date: data.date, loading: false, error: '' })
    } catch (error) {
      setExchange({ rate: null, date: '', loading: false, error: error.message || 'Cotação indisponível.' })
    }
  }

  const totals = useMemo(() => items.reduce((accumulator, item) => {
    const valueInBrl = toBrl(item, exchange.rate)
    if (valueInBrl === null) { accumulator.hasUnconvertedEuro = true; return accumulator }
    accumulator[item.tipo === 'Recebimento' ? 'income' : 'expenses'] += valueInBrl
    accumulator.byCategory[item.categoria] = (accumulator.byCategory[item.categoria] || 0) + (item.tipo === 'Recebimento' ? valueInBrl : -valueInBrl)
    return accumulator
  }, { income: 0, expenses: 0, byCategory: {}, hasUnconvertedEuro: false }), [items, exchange.rate])
  const balance = totals.income - totals.expenses

  const annual = useMemo(() => {
    const byMonth = Array.from({ length: 12 }, (_, index) => ({ month: index, total: 0 }))
    let total = 0
    let hasUnconvertedEuro = false
    annualItems.filter(item => item.tipo === 'Gasto').forEach(item => {
      const valueInBrl = toBrl(item, exchange.rate)
      if (valueInBrl === null) { hasUnconvertedEuro = true; return }
      total += valueInBrl
      byMonth[new Date(`${item.data}T12:00:00`).getMonth()].total += valueInBrl
    })
    return { total, byMonth, hasUnconvertedEuro }
  }, [annualItems, exchange.rate])
  const annualMax = Math.max(...annual.byMonth.map(item => item.total), 1)
  const currencyName = displayCurrency === 'EUR' ? 'euro' : 'real'
  const displayValue = value => convertFromBrl(value, displayCurrency, exchange.rate)
  const expenseCategories = useMemo(() => Object.entries(totals.byCategory)
    .filter(([, value]) => value < 0)
    .map(([name, value]) => ({ name, value: Math.abs(value) }))
    .sort((a, b) => b.value - a.value), [totals.byCategory])
  const categoryOptions = useMemo(() => [...CATEGORIAS, ...savedCategories].filter((category, index, list) => list.findIndex(item => normalizeImportText(item) === normalizeImportText(category)) === index), [savedCategories])

  function changeForm(field, value) { setForm(current => ({ ...current, [field]: value })) }
  function clearForm() { setForm(getInitialForm()); setEditing(null) }
  function openEntryForm() {
    setShowEntryForm(true)
    window.setTimeout(() => document.getElementById('novo-lancamento')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }

  async function refreshFinancialData() {
    await Promise.all([loadItems(), loadAnnualItems(), activeAccountId !== 'personal' ? loadActivity() : Promise.resolve()])
  }

  function entrySignature(entry) {
    return [entry.data, entry.tipo, entry.moeda || 'BRL', normalizeImportText(entry.categoria), normalizeImportText(entry.descricao), Number(entry.valor).toFixed(2)].join('|')
  }

  async function duplicateAlreadyExists(entry, accountId = activeAccountId) {
    const query = queryForAccount(supabase.from('lancamentos').select('data,tipo,moeda,categoria,descricao,valor').eq('data', entry.data).eq('tipo', entry.tipo).eq('moeda', entry.moeda).eq('categoria', entry.categoria).eq('descricao', entry.descricao).eq('valor', entry.valor).limit(1), accountId)
    const { data, error } = await query
    return !error && Boolean(data?.length)
  }

  async function saveCustomCategory(category, accountId = activeAccountId) {
    const name = String(category || '').trim()
    if (!name || CATEGORIAS.some(item => normalizeImportText(item) === normalizeImportText(name))) return true
    const existing = await queryForAccount(supabase.from('categorias').select('id').eq('nome', name).limit(1), accountId)
    if (existing.data?.length) return true
    const { error } = await supabase.from('categorias').insert({ user_id: session.user.id, conta_id: accountId === 'personal' ? null : accountId, nome: name })
    return !error || error.code === '23505'
  }

  async function saveItem(event) {
    event.preventDefault()
    const value = Number(String(form.valor).replace(',', '.'))
    const category = form.categoria === 'Outros' ? form.categoriaOutro.trim() : form.categoria
    if (!form.data || !form.descricao.trim() || !(value > 0)) { setNoticeKind('error'); return setNotice('Preencha data, descrição e um valor superior a zero.') }
    if (!category) { setNoticeKind('error'); return setNotice('Informe qual é a categoria em “Outros”.') }
    if (value > MAX_VALUE) { setNoticeKind('error'); return setNotice(`O valor máximo permitido é ${formatMoney(MAX_VALUE, form.moeda)}.`) }
    const wasEditing = Boolean(editing)
    const details = { data: form.data, tipo: form.tipo, moeda: form.moeda, categoria: category, descricao: form.descricao.trim(), valor: value }
    if (!wasEditing && await duplicateAlreadyExists(details)) {
      const shouldContinue = window.confirm('Este lançamento é igual a um lançamento anterior da mesma conta. Deseja continuar mesmo assim?')
      if (!shouldContinue) return
    }
    setBusy(true); setNotice('')
    const { error } = wasEditing
      ? await supabase.from('lancamentos').update(details).eq('id', editing)
      : await supabase.from('lancamentos').insert({ ...details, user_id: session.user.id, conta_id: activeAccountId === 'personal' ? null : activeAccountId })
    setBusy(false)
    if (error) { setNoticeKind('error'); return setNotice('Não foi possível guardar: ' + error.message) }
    const categoryWasSaved = await saveCustomCategory(category)
    clearForm(); await Promise.all([refreshFinancialData(), loadCategories()])
    setNoticeKind('success'); setNotice(wasEditing ? 'Alterações salvas com sucesso.' : 'Lançamento adicionado com sucesso.')
    if (!categoryWasSaved) setNotice('Lançamento adicionado, mas a nova categoria não pôde ser salva. Execute a migração de categorias no Supabase.')
    document.getElementById('historico')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function readImportFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['xlsx', 'xls', 'csv'].includes(extension)) {
      setNoticeKind('error')
      return setNotice('Escolha um arquivo .xlsx, .xls ou .csv.')
    }
    if (file.size > 10 * 1024 * 1024) {
      setNoticeKind('error')
      return setNotice('O arquivo deve ter no máximo 10 MB.')
    }
    setImportBusy(true)
    setImportRows([])
    setImportIssues([])
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const records = XLSX.utils.sheet_to_json(firstSheet, { defval: '', raw: false })
      if (!records.length) throw new Error('Não encontrei linhas para importar na primeira folha do arquivo.')
      const parsed = parseImportedRows(records)
      setImportRows(parsed.rows)
      setImportIssues(parsed.issues)
      setImportFileName(file.name)
      setImportAccountId(activeAccountId)
      if (!parsed.rows.length) {
        setNoticeKind('error')
        setNotice('Nenhuma linha válida foi encontrada. Confira os nomes das colunas e os valores do arquivo.')
      }
    } catch (error) {
      setNoticeKind('error')
      setNotice(`Não foi possível ler o arquivo: ${error.message || 'arquivo inválido.'}`)
    } finally {
      setImportBusy(false)
    }
  }

  function removeImportedRow(index) {
    setImportRows(current => current.filter((_, rowIndex) => rowIndex !== index))
  }

  async function saveImportedItems() {
    if (!importRows.length) return
    const importDates = [...new Set(importRows.map(row => row.data))]
    const query = queryForAccount(supabase.from('lancamentos').select('data,tipo,moeda,categoria,descricao,valor').in('data', importDates), importAccountId)
    const { data: existingItems } = await query
    const existingSignatures = new Set((existingItems || []).map(entrySignature))
    const importedSignatures = new Set()
    const duplicateCount = importRows.reduce((count, row) => {
      const signature = entrySignature(row)
      const repeated = existingSignatures.has(signature) || importedSignatures.has(signature)
      importedSignatures.add(signature)
      return count + (repeated ? 1 : 0)
    }, 0)
    if (duplicateCount && !window.confirm(`${duplicateCount} lançamento(s) do arquivo já existe(m) nesta conta ou está(ão) repetido(s) no próprio arquivo. Deseja continuar mesmo assim?`)) return
    setImportBusy(true)
    setNotice('')
    const payload = importRows.map(row => ({ ...row, user_id: session.user.id, conta_id: importAccountId === 'personal' ? null : importAccountId }))
    try {
      for (let start = 0; start < payload.length; start += 100) {
        const { error } = await supabase.from('lancamentos').insert(payload.slice(start, start + 100))
        if (error) throw error
      }
      setImportRows([])
      setImportIssues([])
      setImportFileName('')
      setNoticeKind('success')
      setNotice(`${payload.length} lançamentos foram importados com sucesso.`)
      await Promise.all([refreshFinancialData(), ...[...new Set(importRows.map(row => row.categoria))].map(category => saveCustomCategory(category, importAccountId))])
      await loadCategories()
      document.getElementById('historico')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (error) {
      setNoticeKind('error')
      setNotice('Não foi possível importar os lançamentos: ' + (error.message || 'erro desconhecido.'))
    } finally {
      setImportBusy(false)
    }
  }

  async function removeItem(id) {
    if (!window.confirm('Excluir este lançamento?')) return
    const { error } = await supabase.from('lancamentos').delete().eq('id', id)
    if (error) { setNoticeKind('error'); return setNotice('Não foi possível excluir: ' + error.message) }
    await refreshFinancialData()
  }

  async function createJointAccount(event) {
    event.preventDefault()
    if (!newAccountName.trim()) return
    setAccountBusy(true); setAccountMessage('')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase.from('contas').insert({ nome: newAccountName.trim(), owner_id: session.user.id, codigo_convite: makeInviteCode() }).select('id,nome,codigo_convite,owner_id').single()
      if (!error) {
        setAccounts(current => [...current, data])
        setActiveAccountId(data.id)
        setNewAccountName('')
        setAccountBusy(false)
        setAccountMessageKind('success')
        setAccountMessage(`Conta criada. Compartilhe o código ${data.codigo_convite} com quem deve participar.`)
        return
      }
      if (error.code !== '23505') {
        setAccountBusy(false); setAccountMessageKind('error'); setAccountMessage(error.message); return
      }
    }
    setAccountBusy(false); setAccountMessageKind('error'); setAccountMessage('Não foi possível gerar um código único. Tente novamente.')
  }

  async function joinJointAccount(event) {
    event.preventDefault()
    if (!joinCode.trim()) return
    setAccountBusy(true); setAccountMessage('')
    const { data, error } = await supabase.rpc('entrar_conta_compartilhada', { p_codigo: joinCode.trim().toUpperCase() })
    setAccountBusy(false)
    if (error) { setAccountMessageKind('error'); setAccountMessage(error.message); return }
    await loadAccounts()
    setActiveAccountId(data)
    setJoinCode('')
    setAccountMessageKind('success'); setAccountMessage('Você entrou na conta conjunta com sucesso.')
  }

  async function deleteJointAccount() {
    if (!activeAccount || activeAccount.owner_id !== session.user.id) return
    const confirmed = window.confirm(`Encerrar a conta conjunta “${activeAccount.nome}”? Os lançamentos serão preservados, mas o compartilhamento e o histórico conjunto deixarão de ficar disponíveis.`)
    if (!confirmed) return
    setAccountBusy(true)
    setAccountMessage('')
    const { error } = await supabase.from('contas').delete().eq('id', activeAccount.id)
    setAccountBusy(false)
    if (error) {
      setAccountMessageKind('error')
      setAccountMessage('Não foi possível encerrar a conta: ' + error.message)
      return
    }
    setAccounts(current => current.filter(account => account.id !== activeAccount.id))
    setActiveAccountId('personal')
    setActivity([])
    setAccountMessageKind('success')
    setAccountMessage('Conta conjunta encerrada. Os lançamentos foram preservados nas contas pessoais de quem os criou.')
  }

  async function saveGoal(event) {
    event.preventDefault()
    const target = Number(String(goalForm.valor_meta).replace(',', '.'))
    const current = Number(String(goalForm.valor_atual).replace(',', '.'))
    if (!goalForm.titulo.trim() || !(target > 0) || current < 0) {
      setNoticeKind('error')
      return setNotice('Informe uma meta e valores válidos.')
    }
    const { error } = await supabase.from('metas').insert({
      user_id: session.user.id,
      conta_id: activeAccountId === 'personal' ? null : activeAccountId,
      titulo: goalForm.titulo.trim(),
      valor_meta: target,
      valor_atual: current,
      moeda: goalForm.moeda,
      prazo: goalForm.prazo || null,
    })
    if (error) { setNoticeKind('error'); return setNotice('Não foi possível criar a meta: ' + error.message) }
    setGoalForm({ titulo: '', valor_meta: '', valor_atual: '0', moeda: displayCurrency, prazo: '' })
    setShowGoalForm(false)
    setNoticeKind('success')
    setNotice('Meta criada com sucesso.')
    await loadGoals()
  }

  async function updateGoalProgress(goal) {
    const value = window.prompt(`Qual é o valor atual da meta “${goal.titulo}”?`, String(goal.valor_atual))
    if (value === null) return
    const amount = Number(String(value).replace(',', '.'))
    if (amount < 0 || Number.isNaN(amount)) return
    const { error } = await supabase.from('metas').update({ valor_atual: amount }).eq('id', goal.id)
    if (error) { setNoticeKind('error'); return setNotice('Não foi possível atualizar a meta: ' + error.message) }
    await loadGoals()
  }

  async function removeGoal(id) {
    if (!window.confirm('Excluir esta meta?')) return
    const { error } = await supabase.from('metas').delete().eq('id', id)
    if (error) { setNoticeKind('error'); return setNotice('Não foi possível excluir a meta: ' + error.message) }
    await loadGoals()
  }

  function editItem(item) {
    const hasKnownCategory = CATEGORIAS.includes(item.categoria)
    setEditing(item.id)
    setShowEntryForm(true)
    setForm({ data: item.data, tipo: item.tipo, moeda: item.moeda || 'BRL', categoria: hasKnownCategory ? item.categoria : 'Outros', categoriaOutro: hasKnownCategory ? '' : item.categoria, descricao: item.descricao, valor: String(item.valor) })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function logout() { await supabase.auth.signOut() }
  const periodLabel = monthFormatter.format(new Date(year, month, 1))
  const hasExchangeWarning = exchange.error || totals.hasUnconvertedEuro || annual.hasUnconvertedEuro

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark small">MF</div><div><span>Meu Fluxo</span><small>{activeAccount?.nome || 'Finanças pessoais'}</small></div></div><nav className="desktop-nav"><a className="active" href="#visao-geral">Visão geral</a><a href="#novo-lancamento">Lançamentos</a><a href="#relatorios">Relatórios</a><a href="#metas">Metas</a></nav><div className="user-actions"><button className="account-select-trigger" type="button" onClick={() => setShowAccountPicker(current => !current)}>Selecionar conta</button><button className="accounts-trigger" type="button" onClick={() => setShowAccounts(current => !current)}>Contas conjuntas</button><span>Olá, {profile || '…'}</span><button className="text-button" onClick={logout}>Sair</button></div></header>

    <section className={'account-toolbar ' + (showAccountPicker ? 'visible' : '')}><div><p className="eyebrow">CONTA ATIVA</p><select value={activeAccountId} onChange={event => { setActiveAccountId(event.target.value); setShowAccountPicker(false) }}><option value="personal">Minha conta pessoal</option>{accounts.map(account => <option value={account.id} key={account.id}>{account.nome}</option>)}</select></div><button className="button secondary" type="button" onClick={() => setShowAccounts(current => !current)}>Gerenciar contas</button></section>

    {showAccounts && <section className="shared-account-card"><div className="section-heading"><div><p className="eyebrow">COMPARTILHAMENTO</p><h2>Contas conjuntas</h2><p className="section-subtitle">Cada pessoa entra com seu próprio e-mail. Toda alteração fica registrada com o nome de quem a fez.</p></div><button type="button" className="text-button" onClick={() => setShowAccounts(false)}>Fechar</button></div>
      <div className="shared-account-grid"><form onSubmit={createJointAccount} className="account-form"><h3>Criar uma conta</h3><p>Crie uma conta para dividir despesas e receitas.</p><input value={newAccountName} onChange={event => setNewAccountName(event.target.value)} placeholder="Ex.: Casa da família" required /><button className="button primary" disabled={accountBusy}>{accountBusy ? 'Aguarde…' : 'Criar conta conjunta'}</button></form><form onSubmit={joinJointAccount} className="account-form"><h3>Entrar em uma conta</h3><p>Peça o código de convite a quem criou a conta.</p><input value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} placeholder="Ex.: AB12-CD34" required /><button className="button secondary" disabled={accountBusy}>{accountBusy ? 'Aguarde…' : 'Entrar com código'}</button></form>
        {activeAccount && <section className="invite-card"><div className="account-card-title"><h3>{activeAccount.nome}</h3>{activeAccount.owner_id === session.user.id && <span className="admin-badge">Administrador</span>}</div>{activeAccount.owner_id === session.user.id ? <><p>Compartilhe este código com a outra pessoa:</p><strong>{activeAccount.codigo_convite}</strong><button type="button" className="button danger" onClick={deleteJointAccount} disabled={accountBusy}>Encerrar conta conjunta</button></> : <p>Você participa desta conta conjunta. Apenas quem criou a conta pode encerrá-la.</p>}</section>}
      </div>
      {accountMessage && <p className={'form-message ' + accountMessageKind}>{accountMessage}</p>}
      {activeAccount && <section className="activity-section"><div><p className="eyebrow">AUDITORIA</p><h3>Atividade recente</h3></div>{activity.length ? <div className="activity-list">{activity.map(log => <div className="activity-item" key={log.id}><span className={'activity-dot ' + log.acao} /><p><strong>{log.autor_nome || 'Participante'}</strong> {actionLabel(log.acao)} um lançamento</p><time>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(log.ocorrido_em))}</time></div>)}</div> : <p className="muted">Ainda não há alterações nessa conta.</p>}</section>}
    </section>}

    <section className="hero" id="visao-geral"><div className="hero-copy"><p className="eyebrow">VISÃO GERAL</p><h1>Como está o seu mês?</h1><p>{activeAccount ? `${activeAccount.nome} · ${periodLabel}` : periodLabel}</p><div className="mobile-balance"><span>Saldo do mês</span><strong>{displayValue(balance) === null ? '—' : formatMoney(displayValue(balance), displayCurrency)}</strong><small>Convertido para {currencyName}</small></div></div><div className="hero-side"><div className="period-picker"><button aria-label="Mês anterior" onClick={() => month === 0 ? (setMonth(11), setYear(year - 1)) : setMonth(month - 1)}>‹</button><strong>{periodLabel}</strong><button aria-label="Próximo mês" onClick={() => month === 11 ? (setMonth(0), setYear(year + 1)) : setMonth(month + 1)}>›</button></div><div className="currency-switch" aria-label="Moeda dos totais"><span>Ver totais em</span><button type="button" className={displayCurrency === 'EUR' ? 'active' : ''} onClick={() => setDisplayCurrency('EUR')}>€ Euro</button><button type="button" className={displayCurrency === 'BRL' ? 'active' : ''} onClick={() => setDisplayCurrency('BRL')}>R$ Real</button></div><ExchangeRate exchange={exchange} onRefresh={loadExchangeRate} /></div></section>

    {hasExchangeWarning && <p className="exchange-warning">A cotação em euro está indisponível no momento. Valores em euro não entram nos totais até a atualização ser concluída.</p>}
    <section className="summary-grid summary-grid-four"><SummaryCard title="Saldo do mês" value={displayValue(balance)} currency={displayCurrency} icon="◎" tone={balance >= 0 ? 'balance' : 'expense'} caption={`Convertido para ${currencyName}`} /><SummaryCard title="Entradas" value={displayValue(totals.income)} currency={displayCurrency} icon="↗" tone="income" caption={`Convertido para ${currencyName}`} /><SummaryCard title="Despesas" value={displayValue(totals.expenses)} currency={displayCurrency} icon="↘" tone="expense" caption={`Convertido para ${currencyName}`} /><SummaryCard title={`Gastos em ${year}`} value={displayValue(annual.total)} currency={displayCurrency} icon="◷" tone="annual" caption={`Ano completo em ${currencyName}`} /><button type="button" className="add-entry-card" onClick={openEntryForm}><span>+</span><strong>Novo lançamento</strong><small>Registre entradas ou despesas</small></button></section>

    <section className={`content-grid ${showEntryForm ? 'form-open' : 'form-closed'}`}>
      {showEntryForm && <form className="entry-card" id="novo-lancamento" onSubmit={saveItem}>
        <div className="section-heading"><div><p className="eyebrow">{editing ? 'A EDITAR' : 'NOVO LANÇAMENTO'}</p><h2>{editing ? 'Atualize o lançamento' : 'Registre um movimento'}</h2></div><button type="button" className="text-button" onClick={() => { clearForm(); setShowEntryForm(false) }}>Fechar</button></div>
        <div className="entry-grid">
          <label>Data<input type="date" value={form.data} onChange={event => changeForm('data', event.target.value)} required /></label>
          <label>Tipo<select value={form.tipo} onChange={event => changeForm('tipo', event.target.value)}><option>Gasto</option><option>Recebimento</option></select></label>
          <label>Moeda<select value={form.moeda} onChange={event => changeForm('moeda', event.target.value)}><option value="EUR">Euro (€)</option><option value="BRL">Real brasileiro (R$)</option></select></label>
          <label>Categoria<select value={form.categoria} onChange={event => changeForm('categoria', event.target.value)}>{categoryOptions.map(category => <option key={category}>{category}</option>)}</select></label>
          {form.categoria === 'Outros' && <label className="span-all">Nova categoria<input value={form.categoriaOutro} onChange={event => changeForm('categoriaOutro', event.target.value)} placeholder="Ex.: Animais, presente, manutenção…" required /></label>}
          <label>Valor ({form.moeda === 'EUR' ? '€' : 'R$'})<input inputMode="decimal" value={form.valor} onChange={event => changeForm('valor', event.target.value)} placeholder="0,00" required /></label>
          <label className="span-all">Descrição<input value={form.descricao} onChange={event => changeForm('descricao', event.target.value)} placeholder="Ex.: Compras do supermercado" required /></label>
        </div>
        {form.moeda === 'EUR' && <p className="conversion-preview">{exchange.rate ? `Cotação de hoje: € 1 = ${formatMoney(exchange.rate)}. Este lançamento será exibido em real com a taxa atual.` : 'Buscando a cotação atual do euro…'}</p>}
        {notice && <p className={'form-message ' + noticeKind}>{notice}</p>}
        <button className="button primary" disabled={busy}>{busy ? 'A guardar…' : editing ? 'Guardar alterações' : 'Adicionar lançamento'}</button>
        <ImportPanel fileName={importFileName} rows={importRows} issues={importIssues} busy={importBusy} accountName={activeAccount?.nome || 'minha conta pessoal'} onFileChange={readImportFile} onRemoveRow={removeImportedRow} onImport={saveImportedItems} />
      </form>}
    </section>

    <section className="transactions-card" id="historico"><div className="section-heading"><div><p className="eyebrow">HISTÓRICO</p><h2>Lançamentos de {periodLabel}</h2></div><span className="count">{items.length} {items.length === 1 ? 'movimento' : 'movimentos'}</span></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor informado</th><th>Em real hoje</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{items.map(item => { const converted = toBrl(item, exchange.rate); return <tr key={item.id}><td>{dateFormatter.format(new Date(`${item.data}T12:00:00`))}</td><td><strong>{item.descricao}</strong></td><td>{item.categoria}</td><td><span className={'pill ' + (item.tipo === 'Recebimento' ? 'income' : 'expense')}>{item.tipo}</span></td><td className={item.tipo === 'Recebimento' ? 'positive' : 'negative'}>{item.tipo === 'Recebimento' ? '+' : '−'} {formatMoney(item.valor, item.moeda || 'BRL')}</td><td>{item.moeda === 'EUR' ? (converted === null ? 'Cotação indisponível' : formatMoney(converted)) : '—'}</td><td className="row-actions"><button onClick={() => editItem(item)}>Editar</button><button onClick={() => removeItem(item.id)} className="delete">Excluir</button></td></tr> })}</tbody></table></div> : <Empty text="Sem lançamentos para este mês. Use o formulário acima para adicionar o primeiro." />}</section>

    <section className="category-card"><div className="section-heading"><div><p className="eyebrow">ANÁLISE DO MÊS</p><h2>Gastos por categoria</h2></div><button type="button" className="text-button">Ver todas</button></div>{expenseCategories.length ? <div className="category-visual"><CategoryDonut items={expenseCategories} total={totals.expenses} displayValue={displayValue} currency={displayCurrency} /><div className="category-list">{expenseCategories.slice(0, 6).map((item, index) => <div className="category-row" key={item.name}><span><i className={`category-color color-${index % 6}`} />{item.name}</span><strong>{displayValue(item.value) === null ? '—' : formatMoney(displayValue(item.value), displayCurrency)}</strong></div>)}</div></div> : <Empty text="Ainda não existem gastos neste mês." />}</section>

    <section className="goals-card" id="metas"><div className="section-heading"><div><p className="eyebrow">PLANEJAMENTO</p><h2>Metas financeiras</h2><p className="section-subtitle">Acompanhe objetivos pessoais ou compartilhados.</p></div><button type="button" className="button secondary goal-add" onClick={() => setShowGoalForm(current => !current)}>{showGoalForm ? 'Fechar' : 'Nova meta'}</button></div>{showGoalForm && <form className="goal-form" onSubmit={saveGoal}><input value={goalForm.titulo} onChange={event => setGoalForm(current => ({ ...current, titulo: event.target.value }))} placeholder="Ex.: Reserva de emergência" required /><input inputMode="decimal" value={goalForm.valor_meta} onChange={event => setGoalForm(current => ({ ...current, valor_meta: event.target.value }))} placeholder="Valor da meta" required /><input inputMode="decimal" value={goalForm.valor_atual} onChange={event => setGoalForm(current => ({ ...current, valor_atual: event.target.value }))} placeholder="Valor atual" required /><select value={goalForm.moeda} onChange={event => setGoalForm(current => ({ ...current, moeda: event.target.value }))}><option value="EUR">Euro (€)</option><option value="BRL">Real (R$)</option></select><input type="date" value={goalForm.prazo} onChange={event => setGoalForm(current => ({ ...current, prazo: event.target.value }))} /><button className="button primary">Salvar meta</button></form>}{goals.length ? <div className="goals-grid">{goals.map(goal => { const progress = Math.min(100, (Number(goal.valor_atual) / Number(goal.valor_meta)) * 100 || 0); return <article className="goal-item" key={goal.id}><div className="goal-title"><div><h3>{goal.titulo}</h3><p>{goal.prazo ? `Prazo: ${dateFormatter.format(new Date(`${goal.prazo}T12:00:00`))}` : 'Sem prazo definido'}</p></div><button type="button" className="text-button" onClick={() => removeGoal(goal.id)}>Excluir</button></div><div className="goal-values"><strong>{formatMoney(goal.valor_atual, goal.moeda)}</strong><span>de {formatMoney(goal.valor_meta, goal.moeda)}</span></div><div className="goal-track"><span style={{ width: `${progress}%` }} /></div><div className="goal-footer"><small>{progress.toFixed(0)}% concluído</small><button type="button" className="text-button" onClick={() => updateGoalProgress(goal)}>Atualizar progresso</button></div></article> })}</div> : <Empty text="Você ainda não criou uma meta. Comece com um objetivo simples." />}</section>

    <section className="annual-card" id="relatorios"><div className="section-heading"><div><p className="eyebrow">RELATÓRIOS · VISÃO ANUAL</p><h2>Gastos de {year}</h2><p className="section-subtitle">Todos os gastos, agrupados por mês e convertidos para {currencyName} na cotação atual.</p></div><strong className="annual-total">{displayValue(annual.total) === null ? '—' : formatMoney(displayValue(annual.total), displayCurrency)}</strong></div><div className="annual-chart">{annual.byMonth.map(item => <div className="month-column" key={item.month}><span className="bar-value">{item.total ? (displayValue(item.total) === null ? '—' : formatMoney(displayValue(item.total), displayCurrency)) : ''}</span><div className="bar-track"><div className="bar-fill" style={{ height: `${(item.total / annualMax) * 100}%` }} /></div><span>{shortMonthFormatter.format(new Date(year, item.month, 1)).replace('.', '')}</span></div>)}</div></section>

  </main>
}

function actionLabel(action) {
  return ({ criou: 'criou', editou: 'editou', excluiu: 'excluiu' })[action] || 'alterou'
}

function ExchangeRate({ exchange, onRefresh }) {
  if (exchange.loading) return <div className="exchange-rate">Atualizando cotação EUR/BRL…</div>
  if (exchange.error) return <button type="button" className="exchange-rate error" onClick={onRefresh}>Tentar atualizar cotação</button>
  return <div className="exchange-rate"><span>€ 1 = <strong>{formatMoney(exchange.rate)}</strong></span><small>referência de {exchange.date ? dateFormatter.format(new Date(`${exchange.date}T12:00:00`)) : 'hoje'}</small><button type="button" onClick={onRefresh} aria-label="Atualizar cotação">↻</button></div>
}

function CategoryDonut({ items, total, displayValue, currency }) {
  const colors = ['#087d74', '#5aa98f', '#f0907e', '#9b8ee8', '#f5bd48', '#ccd6d3']
  let current = 0
  const gradient = items.map((item, index) => {
    const start = current
    current += total ? (item.value / total) * 100 : 0
    return `${colors[index % colors.length]} ${start}% ${current}%`
  }).join(', ')
  const visibleTotal = displayValue(total)
  return <div className="donut-wrap"><div className="donut-chart" style={{ background: `conic-gradient(${gradient || '#e9f1ee 0 100%'})` }}><div className="donut-center"><span>Total de gastos</span><strong>{visibleTotal === null ? '—' : formatMoney(visibleTotal, currency)}</strong></div></div></div>
}

function SummaryCard({ title, value, currency, icon, tone, caption }) {
  return <article className={'summary-card ' + tone}><span className="summary-icon">{icon}</span><p>{title}</p><strong>{value === null ? '—' : formatMoney(value, currency)}</strong><small>{caption}</small></article>
}

function Empty({ text }) { return <div className="empty">{text}</div> }

function ImportPanel({ fileName, rows, issues, busy, accountName, onFileChange, onRemoveRow, onImport }) {
  return <section className={'import-panel ' + (fileName ? 'with-file' : '')}>
    <div className="import-heading"><div><p className="eyebrow">IMPORTAR EXTRATO</p><h3>Importar ficheiro</h3><p>Excel ou CSV para <strong>{accountName}</strong>.</p></div><label className="button secondary import-file-button">{busy ? 'Lendo…' : 'Escolher arquivo'}<input type="file" accept=".xlsx,.xls,.csv" onChange={onFileChange} disabled={busy} /></label></div>
    {fileName && <><p className="import-help">Confere os dados antes de gravar. São aceites as colunas Data, Descrição e Valor; Tipo, Categoria e Moeda são opcionais.</p><div className="import-result"><div className="import-result-heading"><span><strong>{fileName}</strong> · {rows.length} linhas prontas</span><span>{issues.length ? `${issues.length} aviso(s)` : 'Pronto para importar'}</span></div>{rows.length > 0 && <div className="import-table-wrap"><table className="import-table"><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor</th><th /></tr></thead><tbody>{rows.slice(0, 8).map((row, index) => <tr key={`${row.data}-${row.descricao}-${index}`}><td>{dateFormatter.format(new Date(`${row.data}T12:00:00`))}</td><td>{row.descricao}</td><td>{row.categoria}</td><td>{row.tipo}</td><td>{formatMoney(row.valor, row.moeda)}</td><td><button type="button" onClick={() => onRemoveRow(index)}>Remover</button></td></tr>)}</tbody></table></div>}{rows.length > 8 && <p className="import-more">A mostrar 8 de {rows.length} lançamentos. Todos serão importados.</p>}{issues.length > 0 && <details className="import-issues"><summary>Ver linhas que não serão importadas</summary><ul>{issues.slice(0, 10).map(issue => <li key={issue}>{issue}</li>)}</ul></details>}{rows.length > 0 && <button type="button" className="button primary import-confirm" onClick={onImport} disabled={busy}>{busy ? 'Importando…' : `Importar ${rows.length} lançamentos`}</button>}</div></>}
  </section>
}

export default App

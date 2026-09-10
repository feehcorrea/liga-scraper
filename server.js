const express      = require('express')
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

chromium.use(StealthPlugin())

const app = express()
let browser       = null
let browserUses   = 0
let warmStatus    = { done: false, title: '', hasCookie: false }

const PROXY_USER = process.env.DECODO_USER
const PROXY_PASS = process.env.DECODO_PASS

const HEADERS = {
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Referer':         'https://www.ligapokemon.com.br/',
}

// Fila simples: só 1 página do Playwright aberta por vez. Com o proxy
// residencial fora do ar, toda navegação fica presa até o timeout — sem essa
// fila, chamadas simultâneas (cron + usuário) multiplicavam páginas presas ao
// mesmo tempo no mesmo browser, cada uma segurando memória por vários
// segundos, até estourar o limite da instância no Render.
let queueTail = Promise.resolve()
function withBrowserQueue(fn) {
  const run = queueTail.then(fn, fn)
  queueTail = run.catch(() => {})
  return run
}

// Reinicia o browser a cada N usos — Chromium de longa duração tende a
// inchar em memória mesmo fechando página por página corretamente.
const MAX_BROWSER_USES = 30

async function getBrowser() {
  if (browser?.isConnected() && browserUses < MAX_BROWSER_USES) {
    browserUses++
    return browser
  }
  if (browser) {
    try { await browser.close() } catch {}
    browser = null
  }
  browserUses = 1

  // Porta 10000 = sticky session (mesmo IP para todos os requests da sessão)
  // Necessário para o Cloudflare Turnstile validar o token corretamente
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    proxy: PROXY_USER ? {
      server:   'http://gate.decodo.com:10000',
      username: PROXY_USER,
      password: PROXY_PASS,
    } : undefined,
  })

  // Pre-warm: visita página principal para resolver Cloudflare e obter cf_clearance
  const wp = await browser.newPage()
  try {
    await wp.setExtraHTTPHeaders(HEADERS)
    const wpResponses = []
    wp.on('response', r => {
      if (r.url().includes('ligapokemon') || r.url().includes('cloudflare'))
        wpResponses.push(`${r.status()} ${r.url().slice(0,70)}`)
    })

    await wp.goto('https://www.ligapokemon.com.br/', { waitUntil: 'networkidle', timeout: 30000 })

    // Espera cf_clearance cookie
    const ctx     = browser.contexts()[0]
    const cookies = await ctx.cookies('https://www.ligapokemon.com.br')
    const hasCf   = cookies.some(c => c.name === 'cf_clearance')
    const title   = await wp.title().catch(() => '?')

    warmStatus = { done: true, title, hasCookie: hasCf, responses: wpResponses }
    console.log('[warm] title:', title, '| cf_clearance:', hasCf, '| responses:', wpResponses)
  } catch (e) {
    warmStatus = { done: true, error: e.message }
    console.warn('[warm] erro:', e.message)
  } finally {
    await wp.close()
  }

  return browser
}

app.get('/ping', (_req, res) => res.json({ ok: true, warm: warmStatus }))

// Testa se o Render consegue acessar o HTML completo da carta (cards_stock)
app.get('/test-card-html', async (req, res) => {
  const url = req.query.url || 'https://www.ligapokemon.com.br/?view=cards/card&tipo=1&card=Charizard+ex+(006/165)'
  try {
    const r = await fetch(String(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://www.ligapokemon.com.br/',
      }
    })
    const html = await r.text()
    res.json({
      status:       r.status,
      has_stock:    html.includes('cards_stock'),
      has_editions: html.includes('cards_editions'),
      cloudflare:   html.includes('Just a moment') || html.includes('Um momento'),
      size:         html.length,
    })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// ── Proxy de preços da Liga (Render tem IP não bloqueado) ────────────────────
const LIGA_AJAX = 'https://www.ligapokemon.com.br/ajax/cards/main.php'
const AJAX_HDR  = {
  'Content-Type':     'application/x-www-form-urlencoded',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language':  'pt-BR,pt;q=0.9',
}

function parsePrice(s) {
  const m = String(s).trim().match(/[\d.,]+/)
  if (!m) return null
  const v = parseFloat(m[0].replace(/\./g, '').replace(',', '.'))
  return isNaN(v) ? null : v
}

function parseAjaxHtml(html) {
  const cards = []
  // Aceita qualquer formato de número: 006/165, TG01/TG30, GG01/GG70, SV001/SV122, etc.
  const re = /card=[^&"]+\(([^)]+)\)[^"]*"[\s\S]*?price-min">([^<]*)[\s\S]*?price-avg">([^<]*)[\s\S]*?price-max">([^<]*)/g
  let m
  while ((m = re.exec(html)) !== null) {
    const [num, total] = m[1].split('/')
    if (!num || !total) continue
    cards.push({ num: num.trim(), total: total.trim(), min: parsePrice(m[2]), avg: parsePrice(m[3]), max: parsePrice(m[4]) })
  }
  return cards
}

// GET /liga-prices?name=Charizard+ex&num=006&total=165&ref=Charizard+ex+006/165
app.get('/liga-prices', async (req, res) => {
  const { name, num, total, ref } = req.query
  if (!name || !num || !total) return res.status(400).json({ error: 'name, num, total obrigatórios' })

  // ref = referência pré-formatada pelo Vercel usando ligaCardRef (nome completo + número correto)
  // Fallback: usa primeira palavra do nome + número com pad3
  const numPad = String(num).padStart(3, '0')
  const search = ref
    ? String(ref)
    : `${String(name).split(/[\s-]/)[0]} ${numPad}/${total}`

  // Para matching: normaliza número removendo zeros à esquerda para comparar
  const numNorm = String(num).replace(/^0+(\d)/, '$1')

  let key = 'init'

  for (let page = 1; page <= 3; page++) {
    try {
      const body = new URLSearchParams({ opc: 'nextPage', page: String(page), totalReg: '0', tipo: '1', search, orderBy: '', fav: '0', iTCG: '2', idPokemon: '0', key })
      const r    = await fetch(LIGA_AJAX, { method: 'POST', headers: AJAX_HDR, body: body.toString() })
      if (!r.ok) return res.status(502).json({ error: `Liga HTTP ${r.status}` })

      const json = await r.json()
      key        = json.key ?? key
      const cards = parseAjaxHtml(json.html ?? '')

      // Tenta match exato primeiro, depois match por número normalizado
      const match = cards.find(c => {
        const cNorm = c.num.replace(/^0+(\d)/, '$1')
        return (c.num === String(num) || c.num === numPad || cNorm === numNorm)
      })

      if (match && (match.avg ?? 0) > 0) {
        return res.json({ avg: match.avg, min: match.min, max: match.max, found: true })
      }

      if (!json.nextPage) break
    } catch (e) {
      return res.status(500).json({ error: String(e) })
    }
  }

  res.json({ found: false })
})

// GET /liga-sealed-prices?name=...&ref=...&pcode=...
// ref = ligaProductRef() = "(PT) Box de Booster Megaevolução Caos Ascendente"
// Usa o mesmo AJAX da Liga mas com tipo=2 (produto) e busca pelo ref
app.get('/liga-sealed-prices', async (req, res) => {
  const { name, ref, pcode } = req.query
  if (!name) return res.status(400).json({ error: 'name obrigatório' })

  const search = ref ? String(ref) : String(name)

  // O AJAX de produtos usa o mesmo endpoint mas com tipo=2
  // Tenta buscar e extrai price-min/avg/max do HTML retornado
  let key = 'init'

  for (let page = 1; page <= 3; page++) {
    try {
      const body = new URLSearchParams({
        opc:      'nextPage',
        page:     String(page),
        totalReg: '0',
        tipo:     '2',   // tipo 2 = produtos/selados
        search,
        orderBy:  '',
        fav:      '0',
        iTCG:     '2',
        idPokemon:'0',
        key,
        ...(pcode ? { pcode: String(pcode) } : {}),
      })
      const r = await fetch(LIGA_AJAX, { method: 'POST', headers: AJAX_HDR, body: body.toString() })
      if (!r.ok) return res.status(502).json({ error: `Liga HTTP ${r.status}` })

      const json = await r.json()
      key        = json.key ?? key
      const html = json.html ?? ''

      // Extrai price-min, price-avg, price-max
      const minM = html.match(/class="price-min"[^>]*>([^<]+)/)
      const avgM = html.match(/class="price-avg"[^>]*>([^<]+)/)
      const maxM = html.match(/class="price-max"[^>]*>([^<]+)/)

      const avg = parsePrice(avgM?.[1])
      const min = parsePrice(minM?.[1])
      const max = parsePrice(maxM?.[1])

      if (avg && avg > 0) {
        return res.json({ found: true, avg, min, max })
      }

      if (!json.nextPage) break
    } catch (e) {
      return res.status(500).json({ error: String(e) })
    }
  }

  res.json({ found: false })
})

app.get('/fetch', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'url obrigatória' })

  await withBrowserQueue(async () => {
  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()
    await page.setExtraHTTPHeaders(HEADERS)

    const responses = []
    page.on('response', r => {
      if (r.url().includes('ligapokemon') || r.url().includes('cloudflare'))
        responses.push(`${r.status()} ${r.url().slice(0,70)}`)
    })

    // Timeout baixo de propósito: com o proxy residencial fora do ar, uma
    // navegação que não vai dar certo mesmo assim ficava presa até 45s
    // segurando memória — falhar rápido aqui é melhor que memória vazando.
    await page.goto(url, { waitUntil: 'networkidle', timeout: 12000 })

    const title1 = await page.title().catch(() => '')
    if (title1.includes('momento') || title1.includes('moment')) {
      console.log('[fetch] ainda no challenge, aguardando...')
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(() => {})
    }

    await page.waitForFunction(
      () => typeof window.cards_editions !== 'undefined' || typeof window.cards_stock !== 'undefined',
      { timeout: 8000 }
    ).catch(() => {})

    const html  = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
    const title = await page.title().catch(() => '?')
    const pgUrl = page.url()

    console.log('[fetch] url:', pgUrl, '| title:', title, '| size:', html.length, '| responses:', responses)

    if (html.includes('cards_editions') || html.includes('cards_stock')) {
      console.log('[fetch] SUCCESS!')
      return res.send(html)
    }

    return res.status(502).json({ error: 'sem conteúdo da Liga', title, url: pgUrl, size: html.length, responses, warm: warmStatus })

  } catch (e) {
    console.error('[fetch] erro:', e.message)
    try { await browser?.close() } catch {}
    browser = null
    return res.status(500).json({ error: e.message })
  } finally {
    try { await page?.close() } catch {}
  }
  })
})

// ── Listagens por loja/condição (preço por qualid, sem CSS a decodificar) ────
// Reaproveita o /fetch (Playwright + browser aquecido) pra carregar a página
// geral do card e extrai o array `cards_stock` embutido no HTML — já vem com
// qualid/idioma/lj_id em texto puro; só o preço de alguns itens (os
// "impulsionados") vem ofuscado via precoCss, daí o fallback na vitrine.
app.get('/liga-card-listings', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'url obrigatória' })

  await withBrowserQueue(async () => {
  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()
    await page.setExtraHTTPHeaders(HEADERS)

    // networkidle trava nessa página (trackers/ads nunca param) — domcontentloaded
    // + esperar cards_stock aparecer no window é um sinal muito mais direto.
    // Timeouts baixos de propósito (ver /fetch): falhar rápido é melhor que
    // segurar memória enquanto o proxy residencial estiver fora do ar.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })

    const title1 = await page.title().catch(() => '')
    if (title1.includes('momento') || title1.includes('moment')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})
    }

    await page.waitForFunction(
      () => typeof window.cards_stock !== 'undefined',
      { timeout: 8000 }
    ).catch(() => {})

    const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')

    const m = html.match(/var cards_stock = (\[[\s\S]*?\]);/)
    if (!m) return res.status(502).json({ error: 'cards_stock não encontrado', size: html.length })

    let raw
    try { raw = JSON.parse(m[1]) } catch (e) { return res.status(502).json({ error: 'JSON inválido: ' + e.message }) }

    // Só repassa os campos não-ofuscados que interessam — preço só quando vier limpo.
    const listings = raw.map(item => ({
      qualid:  String(item.qualid),
      idioma:  String(item.idioma),
      extras:  item.extras ?? null,
      lj_id:   item.lj_id,
      isGraded: !!item.is_graded,
      price:   item.precoFinal != null ? parseFloat(item.precoFinal) : (item.preco != null ? parseFloat(item.preco) : null),
    }))

    return res.json({ found: true, listings })
  } catch (e) {
    console.error('[liga-card-listings] erro:', e.message)
    return res.status(500).json({ error: e.message })
  } finally {
    try { await page?.close() } catch {}
  }
  })
})

// GET /liga-store-showcase?store=97457&q=Pikachu+ex+(057/191)
// AJAX da vitrine da própria loja — retorna preço/condição limpos, sem CSS.
app.get('/liga-store-showcase', async (req, res) => {
  const { store, q } = req.query
  if (!store || !q) return res.status(400).json({ error: 'store e q obrigatórios' })

  const params = new URLSearchParams({
    opc:               'showcase',
    tcg:               '2',
    store:             String(store),
    show:              'cards',
    'filters[text]':   String(q),
    pageStart:         '0',
    pageCount:         '20',
  })

  try {
    const r = await fetch(`https://www.ligapokemon.com.br/ajax/mp/marketplace.php?${params}`, {
      headers: AJAX_HDR,
    })
    if (!r.ok) return res.status(502).json({ error: `Liga HTTP ${r.status}` })
    const json = await r.json()
    if (json?.error) return res.json({ found: false, itens: [] })
    return res.json({ found: true, itens: json.itens ?? [] })
  } catch (e) {
    return res.status(500).json({ error: String(e) })
  }
})

// GET /liga-latest-sales?cardId=796&cardEd=406&cardNum=125&cookie=...
// Proxy do histórico de vendas (opc=latestsales) — a Vercel toma 403 do
// Cloudflare nesse endpoint específico, o IP do Render passa. Exige cookie
// de uma sessão logada (a Liga bloqueia latestsales pra visitante anônimo).
app.get('/liga-latest-sales', async (req, res) => {
  const { cardId, cardEd, cardNum, cookie, tcg, filterPeriod } = req.query
  if (!cardId || !cardEd || !cardNum || !cookie) {
    return res.status(400).json({ error: 'cardId, cardEd, cardNum e cookie são obrigatórios' })
  }

  const params = new URLSearchParams({
    opc:            'latestsales',
    tcg:            String(tcg || '2'),
    card_id:        String(cardId),
    card_ed:        String(cardEd),
    card_num:       String(cardNum),
    filter_set:     '',
    filter_cond:    '-1',
    filter_extras:  '-1',
    filter_period:  String(filterPeriod || '2'),
    has_extras:     '0',
  })

  try {
    const r = await fetch(`https://www.ligapokemon.com.br/ajax/mp/marketplace.php?${params}`, {
      headers: { ...AJAX_HDR, Cookie: String(cookie) },
    })
    if (!r.ok) return res.status(502).json({ error: `Liga HTTP ${r.status}` })
    const json = await r.json()
    if (json?.error) return res.json({ data: null, error: json.message || 'Liga retornou erro' })
    return res.json({ data: json })
  } catch (e) {
    return res.status(500).json({ error: String(e) })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`liga-scraper porta ${PORT}`))

const express      = require('express')
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

chromium.use(StealthPlugin())

const app = express()
let browser     = null
let warmStatus  = { done: false, title: '', hasCookie: false }

const PROXY_USER = process.env.DECODO_USER
const PROXY_PASS = process.env.DECODO_PASS

const HEADERS = {
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Referer':         'https://www.ligapokemon.com.br/',
}

async function getBrowser() {
  if (browser?.isConnected()) return browser

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

    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })

    const title1 = await page.title().catch(() => '')
    if (title1.includes('momento') || title1.includes('moment')) {
      console.log('[fetch] ainda no challenge, aguardando...')
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    }

    await page.waitForFunction(
      () => typeof window.cards_editions !== 'undefined' || typeof window.cards_stock !== 'undefined',
      { timeout: 15000 }
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

// ── Embedding visual (scan de cartas pokespace) ──────────────────────────────
// POST /embed { imageBase64 } → { embedding: number[768], ms }
// Modelo SigLIP base patch16-224 q8 (~95MB, baixado no build do Docker)

const EMBED_MODEL = 'Xenova/siglip-base-patch16-224'
let embedReady = false
let embedPipeline = null

function getEmbedder() {
  if (!embedPipeline) {
    embedPipeline = (async () => {
      const { AutoProcessor, SiglipVisionModel, RawImage } = await import('@huggingface/transformers')
      console.log('[embed] carregando SigLIP...')
      const processor = await AutoProcessor.from_pretrained(EMBED_MODEL)
      const model     = await SiglipVisionModel.from_pretrained(EMBED_MODEL, { dtype: 'q8' })
      embedReady = true
      console.log('[embed] SigLIP pronto')
      return { processor, model, RawImage }
    })()
    embedPipeline.catch(e => {
      console.error('[embed] falha ao carregar modelo:', e.message)
      embedPipeline = null
    })
  }
  return embedPipeline
}
getEmbedder() // pré-carrega no boot (keepalive mantém o serviço acordado)

// Fila: 1 inferência por vez para não estourar RAM no free tier
let embedQueue = Promise.resolve()
function enqueueEmbed(fn) {
  const run = embedQueue.then(fn, fn)
  embedQueue = run.catch(() => {})
  return run
}

app.get('/health', (_req, res) => res.json({ ok: true, model: EMBED_MODEL, ready: embedReady }))

app.post('/embed', express.json({ limit: '8mb' }), async (req, res) => {
  try {
    const { imageBase64 } = req.body ?? {}
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 obrigatório' })

    const { processor, model, RawImage } = await getEmbedder()
    const t0 = Date.now()
    const embedding = await enqueueEmbed(async () => {
      const data  = String(imageBase64).replace(/^data:image\/[^;]+;base64,/, '')
      const image = await RawImage.fromBlob(new Blob([Buffer.from(data, 'base64')]))
      const inputs = await processor([image])
      const { pooler_output } = await model(inputs)
      const vec  = pooler_output.tolist()[0]
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
      return vec.map(v => v / norm)
    })
    res.json({ embedding, ms: Date.now() - t0 })
  } catch (e) {
    console.error('[embed] erro:', e.message)
    res.status(400).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`liga-scraper porta ${PORT}`))

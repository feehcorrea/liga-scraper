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

  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    proxy: PROXY_USER ? {
      server:   'http://gate.decodo.com:10001',
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

// Proxy simples para o AJAX da Liga — sem Playwright, só fetch
app.get('/ajax-prices', async (req, res) => {
  const { search } = req.query
  if (!search) return res.status(400).json({ error: 'search obrigatório' })
  try {
    const body = new URLSearchParams({
      opc: 'nextPage', page: '1', totalReg: '0', tipo: '1',
      search: String(search), orderBy: '', fav: '0', iTCG: '2', idPokemon: '0', key: 'init',
    })
    const r = await fetch('https://www.ligapokemon.com.br/ajax/cards/main.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      body: body.toString(),
    })
    res.json({ status: r.status, ok: r.ok, size: (await r.text()).length })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`liga-scraper porta ${PORT}`))

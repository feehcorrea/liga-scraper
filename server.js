const express    = require('express')
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

chromium.use(StealthPlugin())

const app = express()
let browser = null

const PROXY_USER = process.env.DECODO_USER
const PROXY_PASS = process.env.DECODO_PASS

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
  console.log('[browser] launched')
  return browser
}

app.get('/ping', (_req, res) => res.json({ ok: true }))

app.get('/fetch', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'url obrigatória' })

  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Referer':         'https://www.ligapokemon.com.br/',
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Aguarda Cloudflare resolver (máx 15s) — stealth evita o challenge
    await page.waitForFunction(
      () => typeof window.cards_editions !== 'undefined' || typeof window.cards_stock !== 'undefined',
      { timeout: 15000 }
    ).catch(() => {})

    const html = await page.content()
    const title = await page.title().catch(() => '?')

    if (html.includes('cards_editions') || html.includes('cards_stock')) {
      console.log('[fetch] OK -', url, '| title:', title, '| size:', html.length)
      return res.send(html)
    }

    console.warn('[fetch] sem conteúdo | title:', title, '| preview:', html.slice(0, 200))
    return res.status(502).json({ error: 'sem conteúdo da Liga', title, preview: html.slice(0, 300) })

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
app.listen(PORT, () => console.log(`liga-scraper rodando na porta ${PORT}`))

const express     = require('express')
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

chromium.use(StealthPlugin())

const app = express()
let browser = null

const PROXY_USER = process.env.DECODO_USER
const PROXY_PASS = process.env.DECODO_PASS
// SET PROXY_DISABLED=true para testar sem proxy
const PROXY_DISABLED = process.env.PROXY_DISABLED === 'true'

async function getBrowser() {
  if (browser?.isConnected()) return browser
  const proxyConfig = (!PROXY_DISABLED && PROXY_USER) ? {
    server:   'http://gate.decodo.com:10001',
    username: PROXY_USER,
    password: PROXY_PASS,
  } : undefined

  console.log('[browser] proxy:', proxyConfig ? 'decodo' : 'direto')
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    proxy: proxyConfig,
  })
  return browser
}

app.get('/ping', (_req, res) => res.json({ ok: true, proxy: !PROXY_DISABLED && !!PROXY_USER }))

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

    // networkidle espera o Cloudflare challenge executar JS e redirecionar
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })

    const title1 = await page.title().catch(() => '')
    console.log('[fetch] após goto | title:', title1)

    // Se ainda no challenge, aguarda navegar para a página real (até 20s)
    if (title1.includes('momento') || title1.includes('moment')) {
      console.log('[fetch] ainda no challenge, aguardando navegação...')
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    }

    // Aguarda dados da Liga aparecerem no DOM (até 10s)
    await page.waitForFunction(
      () => typeof window.cards_editions !== 'undefined' || typeof window.cards_stock !== 'undefined',
      { timeout: 10000 }
    ).catch(() => {})

    const html  = await page.content()
    const title = await page.title().catch(() => '?')

    if (html.includes('cards_editions') || html.includes('cards_stock')) {
      console.log('[fetch] OK | title:', title, '| size:', html.length)
      return res.send(html)
    }

    console.warn('[fetch] sem conteúdo | title:', title)
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
app.listen(PORT, () => console.log(`liga-scraper porta ${PORT} | proxy: ${!PROXY_DISABLED && !!PROXY_USER ? 'decodo' : 'direto'}`))

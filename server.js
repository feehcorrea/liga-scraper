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
  // Sticky session: mesmo IP para toda a sessão (alphanumeric apenas)
  const sessionId = 'ps' + Date.now().toString(36)  // ex: "psooo64800"
  console.log('[browser] lançando | sticky session:', sessionId)
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    proxy: PROXY_USER ? {
      server:   'http://gate.decodo.com:10001',
      username: `${PROXY_USER}-session-${sessionId}`,
      password: PROXY_PASS,
    } : undefined,
  })

  // Visita a página principal da Liga para obter o cookie cf_clearance
  // Assim as páginas de cartas pulam o Cloudflare challenge
  const warmPage = await browser.newPage()
  try {
    await warmPage.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })
    await warmPage.goto('https://www.ligapokemon.com.br/', { waitUntil: 'networkidle', timeout: 30000 })
    const title = await warmPage.title().catch(() => '?')
    console.log('[browser] pre-aquecido | Liga title:', title)
  } catch (e) {
    console.warn('[browser] falha no pre-aquecimento:', e.message)
  } finally {
    await warmPage.close()
  }

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

    // Log de todas as respostas HTTP para debug
    const responses = []
    page.on('response', r => {
      if (r.url().includes('ligapokemon') || r.url().includes('cloudflare')) {
        responses.push(`${r.status()} ${r.url().slice(0, 80)}`)
      }
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

    // Garante que estamos na URL da Liga (não numa página de erro)
    await page.waitForURL(/ligapokemon\.com\.br/, { timeout: 15000 }).catch(() => {})

    // Espera o DOM estar pronto
    await page.waitForLoadState('domcontentloaded').catch(() => {})

    // Aguarda dados da Liga aparecerem no DOM (até 15s)
    await page.waitForFunction(
      () => typeof window.cards_editions !== 'undefined' || typeof window.cards_stock !== 'undefined',
      { timeout: 15000 }
    ).catch(() => {})

    // Usa evaluate para garantir que pega o HTML atual (não de uma navegação anterior)
    const html  = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
    const title = await page.title().catch(() => '?')
    const pgUrl = page.url()

    console.log('[fetch] url final:', pgUrl, '| title:', title, '| size:', html.length)

    if (html.includes('cards_editions') || html.includes('cards_stock')) {
      console.log('[fetch] OK!')
      return res.send(html)
    }

    console.warn('[fetch] responses:', responses)
    return res.status(502).json({ error: 'sem conteúdo da Liga', title, url: pgUrl, size: html.length, responses, preview: html.slice(0, 300) })

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

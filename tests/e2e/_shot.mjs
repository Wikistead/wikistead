import { chromium } from '@playwright/test'

const out = '/tmp/claude-1000/-home-owner-tmp-knowledge-saas-wikistead/d04e4efb-2288-4550-a2d0-69d4fdc9a2d2/scratchpad'
const base = 'http://localhost:4323'
const pages = process.argv.slice(2)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
for (const p of pages) {
  const page = await ctx.newPage()
  await page.goto(base + p, { waitUntil: 'networkidle' })
  const name = p.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'home'
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false })
  console.log('shot', name)
  await page.close()
}
await browser.close()

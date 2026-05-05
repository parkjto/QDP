import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const APP_URL = 'http://127.0.0.1:4173/QDP/'
const PDF_PATH =
  '/Users/parkjto/Desktop/정보처리기사 필기_시험대비자료/2023년 기사필기 기출문제/1. 2023년01회_정보처리기사필기기출문제.pdf'
const SCREEN_DIR = 'ui-scan'
const DEPLOY_ROOT = '.deploy-preview'

const ensureDir = async () => {
  await fs.mkdir(SCREEN_DIR, { recursive: true })
}

const shot = async (page, name) => {
  await page.screenshot({ path: `${SCREEN_DIR}/${name}.png`, fullPage: true })
}

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

const createStaticServer = () =>
  http.createServer(async (req, res) => {
    try {
      const reqPath = (req.url ?? '/').split('?')[0]
      const normalized = decodeURIComponent(reqPath).replace(/^\/+/, '')
      const targetPath = path.join(DEPLOY_ROOT, normalized)
      const stat = await fs.stat(targetPath).catch(() => null)
      if (stat?.isFile()) {
        const ext = path.extname(targetPath)
        res.writeHead(200, { 'Content-Type': mimeByExt[ext] ?? 'application/octet-stream' })
        res.end(await fs.readFile(targetPath))
        return
      }
      const indexPath = path.join(DEPLOY_ROOT, 'QDP', 'index.html')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(await fs.readFile(indexPath))
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('server error')
    }
  })

const main = async () => {
  await ensureDir()
  await fs.rm(DEPLOY_ROOT, { recursive: true, force: true })
  await fs.mkdir(path.join(DEPLOY_ROOT, 'QDP'), { recursive: true })
  await fs.cp('dist', path.join(DEPLOY_ROOT, 'QDP'), { recursive: true })

  const server = createStaticServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(4173, '127.0.0.1', resolve)
  })

  try {
    const browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox'],
    })
    const page = await browser.newPage({ viewport: { width: 430, height: 820 } })

    try {
      await page.goto(APP_URL, { waitUntil: 'networkidle' })
      await page.waitForSelector('#pdf-file-input', { timeout: 15000, state: 'attached' })
      await shot(page, 'deploy-01-home')

      await page.setInputFiles('#pdf-file-input', PDF_PATH)
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.recentItem').length > 0 ||
          document.querySelectorAll('.libraryBook').length > 0,
        {},
        { timeout: 120000 },
      )
      await page.waitForTimeout(500)
      await shot(page, 'deploy-02-after-upload')

      await page.getByRole('button', { name: '내 책장', exact: true }).click()
      await page.waitForSelector('.libraryBook', { timeout: 15000 })
      await shot(page, 'deploy-03-library')

      await fs.writeFile(
        `${SCREEN_DIR}/deploy-report.json`,
        JSON.stringify(
          {
            ok: true,
            url: APP_URL,
            captures: ['deploy-01-home.png', 'deploy-02-after-upload.png', 'deploy-03-library.png'],
          },
          null,
          2,
        ),
      )
      console.log('deploy-flow-ok')
    } finally {
      await browser.close()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch(async (error) => {
  await fs.writeFile(
    `${SCREEN_DIR}/deploy-report.json`,
    JSON.stringify({ ok: false, reason: String(error?.message ?? error) }, null, 2),
  )
  console.error(error)
  process.exit(1)
})


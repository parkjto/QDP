/**
 * 로컬 dev 서버에서 PDF 업로드 → 순차 출제 → 5번 문항까지 이동 후
 * `.questionFigure` 존재 여부를 검증합니다.
 *
 * 환경변수:
 *   APP_URL        기본 http://127.0.0.1:5173 (실제 실행 포트와 같아야 합니다.
 *                   5174를 쓰면 APP_URL=http://127.0.0.1:5174 로 맞춤)
 *   QDF_VERIFY_PDF 검증용 PDF 절대 경로
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173'
const PDF_PATH =
  process.env.QDF_VERIFY_PDF ??
  path.resolve(
    '/Users/parkjto/Desktop/정보처리기사 필기_시험대비자료/2024년 기사필기 기출문제/1. 2024년1회_정보처리기사필기기출문제.pdf',
  )

const SCREEN_DIR = 'ui-scan'

const shot = async (page, name) => {
  await fs.mkdir(SCREEN_DIR, { recursive: true })
  await page.screenshot({ path: `${SCREEN_DIR}/${name}.png`, fullPage: true })
}

const launch = async () => {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  } catch {
    try {
      return await chromium.launch({
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox'],
      })
    } catch {
      return await chromium.launch({ headless: true })
    }
  }
}

const main = async () => {
  try {
    await fs.access(PDF_PATH)
  } catch {
    console.error('[verify-q5-figure] PDF 없음:', PDF_PATH)
    process.exit(1)
  }

  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForSelector('#pdf-file-input', { timeout: 15000 })
    await page.setInputFiles('#pdf-file-input', PDF_PATH)

    await page.waitForFunction(
      () => document.querySelectorAll('.recentItem').length > 0,
      {},
      { timeout: 180000 },
    )

    await page.locator('.recentItem').first().click()
    await page.waitForSelector('text=출제 순서', { timeout: 30000 })
    await page.getByText('순차', { exact: true }).click()

    const startBtn = page.getByRole('button', { name: '시작하기' })
    await startBtn.waitFor({ state: 'visible', timeout: 10000 })
    if (!(await startBtn.isEnabled())) {
      throw new Error('시작하기 버튼 비활성')
    }
    await startBtn.click()

    await page.waitForSelector('.quizProgressHeader', { timeout: 60000 })

    /** 순차 시작 시 항상 1번부터 — 5번까지 다음 문제 버튼으로 이동 */
    for (let guard = 0; guard < 25; guard += 1) {
      const meta = (await page.locator('.quizQuestionMeta').first().innerText()).trim()
      if (meta.includes('5번')) break
      if (guard === 24) throw new Error('5번 문제 화면 도달 실패')
      await page.locator('.quickArrowButton[aria-label="다음 문제"]').first().click()
      await page.waitForTimeout(250)
    }

    const probe = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img.questionFigure')]
      return {
        meta: document.querySelector('.quizQuestionMeta')?.textContent?.trim() ?? '',
        figureCount: imgs.length,
        srcPrefixes: imgs.map((img) => img.currentSrc.slice(0, 72)),
        hasImageHint: Boolean(document.querySelector('.questionImageHint')),
      }
    })

    await shot(page, 'verify-q5-figure-result')

    const ok = probe.figureCount > 0 && probe.srcPrefixes.some((p) => p.startsWith('data:image'))
    const report = {
      ok,
      appUrl: APP_URL,
      pdfPath: PDF_PATH,
      ...probe,
      screenshot: `${SCREEN_DIR}/verify-q5-figure-result.png`,
    }
    await fs.writeFile(`${SCREEN_DIR}/verify-q5-figure-report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))

    if (!ok) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[verify-q5-figure]', error instanceof Error ? error.message : String(error))
  process.exit(1)
})

import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'

const APP_URL = 'http://localhost:5173'
const PDF_PATH =
  '/Users/parkjto/Desktop/정보처리기사 필기_시험대비자료/2023년 기사필기 기출문제/1. 2023년01회_정보처리기사필기기출문제.pdf'
const SCREEN_DIR = 'ui-scan'

const ensureDir = async () => {
  await fs.mkdir(SCREEN_DIR, { recursive: true })
}

const shot = async (page, name) => {
  await page.screenshot({ path: `${SCREEN_DIR}/${name}.png`, fullPage: true })
}

const failWithReport = async (page, stage, reason) => {
  await shot(page, `error-${stage}`)
  await fs.writeFile(
    `${SCREEN_DIR}/report.json`,
    JSON.stringify({ ok: false, stage, reason }, null, 2),
  )
  throw new Error(`[${stage}] ${reason}`)
}

const main = async () => {
  await ensureDir()

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  })

  const page = await browser.newPage({
    viewport: { width: 375, height: 667 },
  })

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle' })
    await shot(page, '01-empty')

    await page.waitForSelector('#pdf-file-input', { timeout: 10000 })

    await page.setInputFiles('#pdf-file-input', PDF_PATH)
    try {
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.recentItem').length > 0 ||
          document.querySelectorAll('.libraryBook').length > 0,
        {},
        { timeout: 120000 },
      )
    } catch {
      const hint = (await page.locator('.dropzoneHint').first().innerText().catch(() => '')) ?? ''
      await failWithReport(page, 'upload-to-library', hint || '업로드 후 보관함 목록 갱신 실패')
    }
    await shot(page, '02-after-upload')

    await page.getByRole('button', { name: '내 책장', exact: true }).click()
    await page.waitForSelector('.libraryShelf .libraryBook', { timeout: 10000 })
    await page.locator('.libraryShelf .libraryBook').first().click()
    await page.waitForSelector('text=출제 순서', { timeout: 30000 })

    const orderOption = page.getByText('순차', { exact: true })
    if ((await orderOption.count()) === 0) {
      await failWithReport(page, 'setup-order', '출제 순서 옵션 미노출')
    }
    await orderOption.click()

    const startBtn = page.getByRole('button', { name: '시작하기' })
    if (!(await startBtn.isEnabled())) {
      await failWithReport(page, 'setup-start', '시작하기 버튼 비활성')
    }
    await startBtn.click()

    try {
      await page.waitForSelector('.quizProgressHeader', { timeout: 30000 })
    } catch {
      await failWithReport(page, 'setup-to-quiz', '문제 풀이 화면 진입 실패')
    }
    await shot(page, '03-quiz-start')

    for (let idx = 0; idx < 5; idx += 1) {
      const progressBeforeCheck = await page.locator('.quizProgressHeader .progressMeta').innerText()
      const firstChoice = page.locator('.choices .optionCard').first()
      await firstChoice.click()
      await page.getByRole('button', { name: '정답 확인' }).click()
      const progressAfterCheck = await page.locator('.quizProgressHeader .progressMeta').innerText()
      if (progressBeforeCheck !== progressAfterCheck) {
        await failWithReport(page, 'quiz-progress', '정답 확인 직후 진행도가 변경됨')
      }
      await page.waitForTimeout(250)
      await shot(page, `04-q${idx + 1}-checked`)
      const nextBtn = page.locator('.quickArrowButton[aria-label="다음 문제"]').first()
      await nextBtn.click()
      await page.waitForTimeout(250)
    }

    await shot(page, '05-after-complete')

    await shot(page, '06-after-session')

    await shot(page, '07-session-finished')

    const result = await page.evaluate(() => {
      const getRect = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { width: Math.round(rect.width), height: Math.round(rect.height) }
      }
      return {
        ok: true,
        uploadDropzone: getRect('.dashedDropzone'),
        startButton: getRect('.startButton'),
        hasQuizSection: Boolean(document.querySelector('.quizActionBar')),
      }
    })

    await fs.writeFile(`${SCREEN_DIR}/report.json`, JSON.stringify(result, null, 2))
    console.log('scan-complete', result)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

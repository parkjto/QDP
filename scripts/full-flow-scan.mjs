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

    await page.setInputFiles('#pdf-file-input', PDF_PATH)
    try {
      await page.waitForSelector('.libraryShelf .libraryBook', { timeout: 120000 })
    } catch {
      const hint = (await page.locator('.dropzoneHint').first().innerText().catch(() => '')) ?? ''
      await failWithReport(page, 'upload-to-library', hint || '업로드 후 보관함 목록 갱신 실패')
    }
    await shot(page, '02-after-upload')

    await page.getByRole('button', { name: '다음', exact: true }).click()
    await page.waitForSelector('text=학습 타입', { timeout: 30000 })

    const studyOption = page.getByText('문제 풀기', { exact: true })
    if ((await studyOption.count()) === 0) {
      await failWithReport(page, 'setup-study', '학습 타입 선택 옵션 미노출')
    }
    await studyOption.click()

    const countOption = page.getByText('5문제', { exact: true })
    if ((await countOption.count()) === 0) {
      await failWithReport(page, 'setup-count', '문제 수 선택 옵션 미노출')
    }
    await countOption.click()

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
      await page.waitForSelector('text=문제 풀이', { timeout: 30000 })
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
      const statText = await page.locator('.quizStatChips').innerText().catch(() => '')
      if (!statText.includes('정답') || !statText.includes('오답')) {
        await failWithReport(page, 'quiz-stats', '정답/오답 카운터 미노출')
      }
      await page.waitForTimeout(250)
      await shot(page, `04-q${idx + 1}-checked`)
      const nextBtn = page.getByRole('button', { name: '다음 문제' })
      if ((await nextBtn.count()) === 0) break
      await nextBtn.click()
      await page.waitForTimeout(250)
    }

    await shot(page, '05-after-complete')

    const wrongOption = page.getByText(/오답풀기/)
    if ((await wrongOption.count()) > 0) {
      await wrongOption.first().click()
      const wrongStartBtn = page.getByRole('button', { name: '시작하기' })
      if (await wrongStartBtn.isEnabled()) {
        await wrongStartBtn.click()
        await page.waitForTimeout(600)
      }
      await shot(page, '06-wrong-only')
    }

    await page.getByRole('button', { name: '보관함', exact: true }).click()
    await page.waitForSelector('.libraryBookDelete', { timeout: 10000 })
    const deleteBtn = page.locator('.libraryBookDelete').first()
    if ((await deleteBtn.count()) === 0) {
      await failWithReport(page, 'library-delete', '삭제 버튼 미노출')
    }
    const beforeCancelCount = await page.locator('.libraryBook').count()
    page.once('dialog', async (dialog) => {
      await dialog.dismiss()
    })
    await deleteBtn.click()
    await page.waitForTimeout(250)
    const afterCancelCount = await page.locator('.libraryBook').count()
    if (beforeCancelCount !== afterCancelCount) {
      await failWithReport(page, 'library-delete-cancel', '삭제 취소 후 문제집 개수가 변경됨')
    }

    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await deleteBtn.click()
    await page.waitForTimeout(350)
    const afterConfirmCount = await page.locator('.libraryBook').count()
    if (afterConfirmCount !== Math.max(beforeCancelCount - 1, 0)) {
      await failWithReport(page, 'library-delete-confirm', '삭제 확인 후 문제집 개수 감소가 반영되지 않음')
    }
    await shot(page, '07-library-deleted')

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

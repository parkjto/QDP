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

const main = async () => {
  await ensureDir()

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  })

  const page = await browser.newPage({
    viewport: { width: 540, height: 720 },
  })

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#pdf-file-input', { timeout: 10000 })
    await shot(page, 'all-01-home')

    await page.setInputFiles('#pdf-file-input', PDF_PATH)
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.recentItem').length > 0 ||
        document.querySelectorAll('.libraryBook').length > 0,
      {},
      { timeout: 120000 },
    )
    await page.waitForTimeout(400)
    await shot(page, 'all-02-home-after-upload')

    await page.getByRole('button', { name: '내 책장', exact: true }).click()
    await page.waitForSelector('.libraryBook', { timeout: 15000 })
    await shot(page, 'all-03-library')

    await page.locator('.libraryBook').first().click()
    await page.waitForSelector('.setupHero', { timeout: 15000 })
    await shot(page, 'all-04-setup')

    const studyOption = page.getByText('문제 풀기', { exact: true })
    if (await studyOption.count()) await studyOption.first().click()
    const countOption = page.getByText('5문제', { exact: true })
    if (await countOption.count()) await countOption.first().click()
    const orderOption = page.getByText('순차', { exact: true })
    if (await orderOption.count()) await orderOption.first().click()

    await page.getByRole('button', { name: '시작하기' }).click()
    await page.waitForSelector('.quizProgressHeader', { timeout: 20000 })
    await shot(page, 'all-05-quiz')

    await page.locator('.quizExitButton').first().click()
    await page.waitForSelector('.setupHero', { timeout: 15000 })

    await page.getByRole('button', { name: '복습', exact: true }).click()
    await page.waitForSelector('.reviewSummaryGrid, .reviewEmptyHint', { timeout: 15000 })
    await shot(page, 'all-06-review')

    await page.getByRole('button', { name: '통계', exact: true }).click()
    await page.waitForSelector('.analyticsHeroCard', { timeout: 15000 })
    await shot(page, 'all-07-analytics')

    await page.getByRole('button', { name: '마이페이지', exact: true }).click()
    await page.waitForSelector('.mypageCard', { timeout: 15000 })
    await shot(page, 'all-08-mypage')

    await fs.writeFile(
      `${SCREEN_DIR}/all-screens-report.json`,
      JSON.stringify(
        {
          ok: true,
          captures: [
            'all-01-home.png',
            'all-02-home-after-upload.png',
            'all-03-library.png',
            'all-04-setup.png',
            'all-05-quiz.png',
            'all-06-review.png',
            'all-07-analytics.png',
            'all-08-mypage.png',
          ],
        },
        null,
        2,
      ),
    )

    console.log('all-screens-captured')
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})


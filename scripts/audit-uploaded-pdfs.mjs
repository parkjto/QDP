import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { parseQuestionsFromPdfFile } from '../src/features/pdf/parser.ts'

const ROOT_DIR =
  process.env.QDF_AUDIT_ROOT ??
  '/Users/parkjto/Desktop/정보처리기사 필기_시험대비자료'
const APP_URL = process.env.QDF_AUDIT_URL ?? 'http://localhost:5173'
const REPORT_PATH = 'ui-scan/uploaded-pdf-audit-report.json'

const PLACEHOLDER_PATTERN = /원문 이미지\/도표|선택지 원문 복구 필요|원문을 복구하지 못했습니다/

const walkPdfFiles = async (dir) => {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkPdfFiles(target)))
      continue
    }
    if (entry.isFile() && target.toLowerCase().endsWith('.pdf')) out.push(target)
  }
  return out
}

const buildNodeParseReport = async (filePath) => {
  const buffer = await fs.readFile(filePath)
  const file = new File([buffer], path.basename(filePath), { type: 'application/pdf' })
  const { questions } = await parseQuestionsFromPdfFile(file, file.name)
  const placeholders = questions
    .filter(
      (q) =>
        PLACEHOLDER_PATTERN.test(q.stem) ||
        q.choices.every((choice) => PLACEHOLDER_PATTERN.test(choice)),
    )
    .map((q) => q.number)
  return {
    filePath,
    fileName: path.basename(filePath),
    questionCount: questions.length,
    placeholderCount: placeholders.length,
    firstPlaceholder: placeholders[0] ?? null,
  }
}

const clearWebStorage = async (page) => {
  await page.evaluate(async () => {
    window.localStorage.clear()
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  })
}

const checkFigureOnPlaceholderQuestion = async (page, filePath, targetQuestion) => {
  await page.goto(APP_URL, { waitUntil: 'networkidle' })
  await clearWebStorage(page)
  await page.reload({ waitUntil: 'networkidle' })

  await page.setInputFiles('#pdf-file-input', filePath)
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.recentItem').length > 0 ||
      document.querySelectorAll('.libraryBook').length > 0,
    {},
    { timeout: 120000 },
  )

  await page.getByRole('button', { name: '내 책장', exact: true }).click()
  await page.waitForSelector('.libraryShelf .libraryBook', { timeout: 30000 })
  await page.locator('.libraryShelf .libraryBook').first().click()
  await page.getByText('순차', { exact: true }).click()
  await page.getByRole('button', { name: '시작하기' }).click()
  await page.waitForSelector('.quizProgressHeader', { timeout: 30000 })

  for (let index = 1; index < targetQuestion; index += 1) {
    await page.locator('.quickArrowButton').last().click()
  }
  await page.waitForTimeout(150)

  const qMeta = await page.locator('.quizQuestionMeta').innerText()
  const hasFigure = (await page.locator('.questionFigure').count()) > 0
  const firstChoice = await page.locator('.choices .choiceText').first().innerText()
  const hasPlaceholderChoice = PLACEHOLDER_PATTERN.test(firstChoice)
  return { qMeta, hasFigure, firstChoice, hasPlaceholderChoice }
}

const main = async () => {
  const pdfFiles = (await walkPdfFiles(ROOT_DIR)).sort()
  const parseResults = []
  for (const pdfFile of pdfFiles) {
    try {
      parseResults.push(await buildNodeParseReport(pdfFile))
    } catch (error) {
      parseResults.push({
        filePath: pdfFile,
        fileName: path.basename(pdfFile),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const targets = parseResults.filter(
    (item) =>
      !item.error &&
      item.placeholderCount > 0 &&
      item.firstPlaceholder !== null &&
      /([123])회/.test(item.fileName.normalize('NFC')),
  )

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })

  const browserChecks = []
  for (const target of targets) {
    try {
      const check = await checkFigureOnPlaceholderQuestion(
        page,
        target.filePath,
        target.firstPlaceholder,
      )
      browserChecks.push({
        fileName: target.fileName,
        targetQuestion: target.firstPlaceholder,
        ...check,
      })
    } catch (error) {
      browserChecks.push({
        fileName: target.fileName,
        targetQuestion: target.firstPlaceholder,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await browser.close()

  const report = {
    ok: true,
    rootDir: ROOT_DIR,
    fileCount: pdfFiles.length,
    parseResults,
    browserChecks,
    checkedAt: new Date().toISOString(),
  }
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch(async (error) => {
  const result = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    checkedAt: new Date().toISOString(),
  }
  await fs.writeFile(REPORT_PATH, JSON.stringify(result, null, 2))
  console.error(result)
  process.exit(1)
})

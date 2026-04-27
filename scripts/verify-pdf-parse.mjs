import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePdfTextStructure, extractTextFromPdf, parseQuestionsFromPdfText } from '../src/features/pdf/parser.ts'

const DEFAULT_SAMPLE_PDF =
  '/Users/parkjto/Desktop/정보처리기사 필기_시험대비자료/2023년 기사필기 기출문제/1. 2023년01회_정보처리기사필기기출문제.pdf'
const MIN_QUESTION_COUNT = 80

const run = async () => {
  const targetPdf = process.env.QDF_SAMPLE_PDF ?? DEFAULT_SAMPLE_PDF
  const resolvedPath = path.resolve(targetPdf)
  const fileBuffer = await fs.readFile(resolvedPath)
  const file = new File([fileBuffer], path.basename(resolvedPath), { type: 'application/pdf' })

  const text = await extractTextFromPdf(file)
  const profile = analyzePdfTextStructure(text)
  const questions = parseQuestionsFromPdfText(text, file.name)

  const malformed = questions.filter(
    (question) => !question.stem || question.choices.length !== 4 || question.choices.some((choice) => !choice),
  )

  if (questions.length < MIN_QUESTION_COUNT) {
    throw new Error(`파싱 문항 수 부족: ${questions.length}개 (최소 ${MIN_QUESTION_COUNT}개 필요)`)
  }
  if (malformed.length > 0) {
    throw new Error(`형식 불완전 문항 발견: ${malformed.length}개`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        samplePdf: resolvedPath,
        profile,
        questionCount: questions.length,
        firstQuestion: {
          number: questions[0]?.number,
          stem: questions[0]?.stem.slice(0, 60) ?? '',
        },
      },
      null,
      2,
    ),
  )
}

run().catch((error) => {
  console.error('[verify-pdf-parse] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})

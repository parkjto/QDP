import type { Question } from '../../types'
import {
  extractSpatialFigureCropsForPage,
  overlaySpatialFiguresOntoQuestions,
} from './spatialFigureCrop'

const CHOICE_MARKERS = ['①', '②', '③', '④']
const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024
const PDF_MAGIC_HEADER = '%PDF-'
const MIN_STEM_LENGTH = 12
const MAX_FALLBACK_QUESTIONS = 60
export type PdfErrorCode =
  | 'INVALID_TYPE'
  | 'TOO_LARGE'
  | 'INVALID_PDF'
  | 'MALFORMED_PDF'
  | 'PARSE_FAILED'

export class PdfParseError extends Error {
  code: PdfErrorCode

  constructor(code: PdfErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'PdfParseError'
    this.code = code
  }
}

const normalizeText = (raw: string): string =>
  raw
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/-- \d+ of \d+ --/g, '')
    .trim()

type PositionedText = {
  text: string
  x: number
  y: number
}

const toPositionedTexts = (items: unknown[]): PositionedText[] =>
  items
    .map((item) => {
      if (!item || typeof item !== 'object' || !('str' in item) || !('transform' in item)) return null
      const str = String((item as { str: string }).str ?? '').trim()
      const transform = (item as { transform: number[] }).transform
      if (!str || !Array.isArray(transform) || transform.length < 6) return null
      return {
        text: str,
        x: Number(transform[4] ?? 0),
        y: Number(transform[5] ?? 0),
      }
    })
    .filter((entry): entry is PositionedText => entry !== null)

const rebuildLinearText = (positioned: PositionedText[]): string => {
  const sorted = positioned.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y
    return a.x - b.x
  })

  let output = ''
  let prev: PositionedText | null = null
  for (const token of sorted) {
    if (!prev) {
      output += token.text
      prev = token
      continue
    }

    const yDiff = Math.abs(token.y - prev.y)
    const xGap = token.x - prev.x

    if (yDiff > 4) {
      output += '\n'
    } else if (xGap > 12) {
      output += ' '
    }

    output += token.text
    prev = token
  }

  return output
}

const rebuildPageText = (items: unknown[]): string => {
  const positioned = toPositionedTexts(items)
  if (!positioned.length) return ''

  const xValues = positioned.map((item) => item.x)
  const minX = Math.min(...xValues)
  const maxX = Math.max(...xValues)
  const width = maxX - minX

  // Most exam PDFs are two-column layouts. Rebuild each column independently to prevent
  // left/right texts from being interleaved by global y-order sorting.
  if (width > 280) {
    const pivot = minX + width / 2
    const left = positioned.filter((item) => item.x < pivot)
    const right = positioned.filter((item) => item.x >= pivot)
    const bigger = Math.max(left.length, right.length)
    const smaller = Math.min(left.length, right.length)
    const hasTwoColumns = smaller > 30 && bigger / smaller < 4
    if (hasTwoColumns) {
      return `${rebuildLinearText(left)}\n${rebuildLinearText(right)}`
    }
  }

  return rebuildLinearText(positioned)
}

const rebuildFallbackText = (items: unknown[]): string =>
  items
    .map((item) => {
      if (!item || typeof item !== 'object' || !('str' in item)) return ''
      const str = String((item as { str: string }).str ?? '').trim()
      if (!str) return ''
      const hasEol = Boolean((item as { hasEOL?: boolean }).hasEOL)
      return hasEol ? `${str}\n` : `${str} `
    })
    .join('')
    .trim()

const parseAnswerMap = (text: string): Map<number, number> => {
  const answerMap = new Map<number, number>()
  const answerZoneStart = text.indexOf('정답')
  if (answerZoneStart < 0) return answerMap

  const answerZone = text.slice(answerZoneStart)
  const answerRegex = /(\d{1,3})\s*[.)]?\s*([①②③④])/g
  let match = answerRegex.exec(answerZone)
  while (match) {
    const questionNumber = Number(match[1])
    const symbol = match[2]
    const answerIdx = CHOICE_MARKERS.indexOf(symbol)
    if (answerIdx >= 0) answerMap.set(questionNumber, answerIdx)
    match = answerRegex.exec(answerZone)
  }

  return answerMap
}

const NOISE_LINE_PATTERNS = [
  /^-\s*\d+\s*-$/,
  /^기출문제\s*&\s*정답.*해설/i,
  /^\d+회\s*정보처리기사\s*필기/i,
  /^저작권\s*안내$/,
  /^허락\s*없이\s*복제/i,
  /^이 자료는 .*시나공/i,
]

const isNoiseLine = (line: string): boolean => {
  const normalized = line.trim()
  if (!normalized) return true
  if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) return true
  if (/^[^\w가-힣]+$/.test(normalized)) return true
  return false
}

const normalizeBlock = (value: string): string =>
  value
    .replace(/[ \t]+/g, ' ')
    // PDF 추출 시 단어 중간에 "시스 , 템"처럼 비정상 쉼표가 끼는 경우를 복구
    .replace(/([가-힣A-Za-z0-9])\s+,\s+([가-힣A-Za-z0-9])/g, '$1$2')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

const isLikelyExamSourceName = (sourceName: string): boolean => {
  const normalized = sourceName.normalize('NFC')
  return /정보처리기사/.test(normalized) && /([123])회/.test(normalized)
}

const splitByChoiceMarkers = (block: string): { stem: string; choices: string[] } | null => {
  const indices = {
    a: [...block.matchAll(/①/g)].map((match) => match.index ?? -1).filter((index) => index >= 0),
    b: [...block.matchAll(/②/g)].map((match) => match.index ?? -1).filter((index) => index >= 0),
    c: [...block.matchAll(/③/g)].map((match) => match.index ?? -1).filter((index) => index >= 0),
    d: [...block.matchAll(/④/g)].map((match) => match.index ?? -1).filter((index) => index >= 0),
  }
  if (!indices.a.length || !indices.b.length || !indices.c.length || !indices.d.length) return null

  let best: { i1: number; i2: number; i3: number; i4: number } | null = null
  for (const i1 of indices.a) {
    const i2 = indices.b.find((index) => index > i1)
    if (i2 === undefined) continue
    const i3 = indices.c.find((index) => index > i2)
    if (i3 === undefined) continue
    const i4 = indices.d.find((index) => index > i3)
    if (i4 === undefined) continue
    if (!best || i1 > best.i1) {
      best = { i1, i2, i3, i4 }
    }
  }
  if (!best) return null

  return {
    stem: normalizeBlock(block.slice(0, best.i1)),
    choices: [
      normalizeBlock(block.slice(best.i1 + 1, best.i2)),
      normalizeBlock(block.slice(best.i2 + 1, best.i3)),
      normalizeBlock(block.slice(best.i3 + 1, best.i4)),
      normalizeBlock(block.slice(best.i4 + 1)),
    ],
  }
}

const splitByPartialChoiceMarkers = (block: string): { stem: string; choices: string[] } | null => {
  const markerEntries = [...block.matchAll(/[①②③④]/g)].map((match) => ({
    marker: match[0],
    index: match.index ?? -1,
  }))
  const ordered = markerEntries.filter((entry) => entry.index >= 0)
  if (ordered.length < 3) return null

  const choices = ['', '', '', '']
  const markerToIdx: Record<string, number> = { '①': 0, '②': 1, '③': 2, '④': 3 }
  const first = ordered[0]
  const stem = normalizeBlock(block.slice(0, first.index))

  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i]
    const currentChoiceIdx = markerToIdx[current.marker]
    const next = ordered[i + 1]
    const end = next ? next.index : block.length
    choices[currentChoiceIdx] = normalizeBlock(block.slice(current.index + 1, end))
  }

  const filled = choices.map(
    (choice, idx) => choice || `${idx + 1}번 선택지는 원문 이미지/도표를 확인해 주세요.`,
  )
  if (!stem) return null
  return { stem, choices: filled }
}

const splitByNumberedChoices = (block: string): { stem: string; choices: string[] } | null => {
  const patterns = [
    /(.*?)(?:^|\s)1[.)]\s*(.*?)(?:^|\s)2[.)]\s*(.*?)(?:^|\s)3[.)]\s*(.*?)(?:^|\s)4[.)]\s*([\s\S]*)/s,
    /(.*?)(?:^|\s)\(1\)\s*(.*?)(?:^|\s)\(2\)\s*(.*?)(?:^|\s)\(3\)\s*(.*?)(?:^|\s)\(4\)\s*([\s\S]*)/s,
    /(.*?)(?:^|\s)A[.)]\s*(.*?)(?:^|\s)B[.)]\s*(.*?)(?:^|\s)C[.)]\s*(.*?)(?:^|\s)D[.)]\s*([\s\S]*)/s,
  ]

  for (const pattern of patterns) {
    const matched = pattern.exec(block)
    if (!matched) continue
    return {
      stem: normalizeBlock(matched[1]),
      choices: [matched[2], matched[3], matched[4], matched[5]].map((choice) => normalizeBlock(choice)),
    }
  }
  return null
}

const splitOptionsFromBlock = (block: string): { stem: string; choices: string[] } | null => {
  const byMarker = splitByChoiceMarkers(block)
  if (byMarker) return byMarker

  const relaxed = /(.*?)①([\s\S]*?)②([\s\S]*?)③([\s\S]*?)④([\s\S]*)/s.exec(block)
  if (relaxed) {
    return {
      stem: normalizeBlock(relaxed[1]),
      choices: [relaxed[2], relaxed[3], relaxed[4], relaxed[5]].map((choice) => normalizeBlock(choice)),
    }
  }

  const partial = splitByPartialChoiceMarkers(block)
  if (partial) return partial

  return splitByNumberedChoices(block)
}

const splitQuestionBlocksBySequence = (text: string): Array<{ number: number; block: string }> => {
  const questionZone = text.split(/(?:^|\n)\s*(?:\d+회\s*)?정답\s*(?:및)?\s*해설[\s\S]*$/m)[0] ?? text
  const points = [...questionZone.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s*/g)].map((match) => ({
    number: Number(match[1]),
    index: (match.index ?? 0) + match[0].lastIndexOf(match[1]),
  }))
  if (!points.length) return []

  return points.map((point, idx) => {
    const start = point.index
    const end = points[idx + 1]?.index ?? questionZone.length
    return {
      number: point.number,
      block: questionZone.slice(start, end).replace(/^\d{1,3}\.\s*/, '').trim(),
    }
  })
}

const splitSentenceCandidates = (text: string): string[] =>
  text
    .split(/[\n.!?]+/)
    .map((line) => normalizeBlock(line))
    .filter((line) => line.length >= 25)

const extractWordCandidates = (value: string): string[] => {
  const matches = value.match(/[A-Za-z가-힣][A-Za-z가-힣0-9]{2,}/g) ?? []
  return [...new Set(matches.map((item) => item.trim()))]
}

const pickBlankWord = (sentence: string): string | null => {
  const words = extractWordCandidates(sentence).filter((word) => word.length >= 3)
  if (!words.length) return null
  return [...words].sort((a, b) => b.length - a.length)[0] ?? null
}

const generateFallbackQuestions = (text: string, sourceName: string): Question[] => {
  const sentences = splitSentenceCandidates(text)
  if (!sentences.length) return []

  const vocabulary = [...new Set(sentences.flatMap((sentence) => extractWordCandidates(sentence)))]
  const generated: Question[] = []
  let number = 1

  for (const sentence of sentences) {
    const answerWord = pickBlankWord(sentence)
    if (!answerWord) continue
    if (!sentence.includes(answerWord)) continue
    const stem = sentence.replace(answerWord, '_____')
    if (stem.length < MIN_STEM_LENGTH) continue

    const distractors = vocabulary.filter(
      (word) => word !== answerWord && Math.abs(word.length - answerWord.length) <= 4,
    )
    if (distractors.length < 3) continue

    const choices = [answerWord, distractors[0], distractors[1], distractors[2]]
    const shuffled = [...choices]
    for (let idx = shuffled.length - 1; idx > 0; idx -= 1) {
      const rand = Math.floor(Math.random() * (idx + 1))
      ;[shuffled[idx], shuffled[rand]] = [shuffled[rand], shuffled[idx]]
    }
    const answer = shuffled.indexOf(answerWord)
    if (answer < 0) continue

    generated.push({
      id: `${sourceName}-fallback-${number}`,
      number,
      stem: `[자동 생성] 빈칸에 들어갈 가장 알맞은 단어를 고르세요.\n${stem}`,
      choices: shuffled,
      answer,
      sourceName,
    })
    number += 1
    if (generated.length >= MAX_FALLBACK_QUESTIONS) break
  }

  return generated
}

const parseStructuredQuestions = (text: string, sourceName: string): Question[] => {
  const answerMap = parseAnswerMap(text)
  const examSource = isLikelyExamSourceName(sourceName)
  const examLike = examSource || answerMap.size >= 40
  const blocks = splitQuestionBlocksBySequence(text)
  const questions: Question[] = []

  for (const { number, block } of blocks) {
    const sanitizedBlock = block
      .split(/(?:^|\n)\s*(?:\d+회\s*)?정답 및 해설[\s\S]*$/m)[0]
      .trim()
    const parsed = splitOptionsFromBlock(sanitizedBlock)
    if (!parsed) {
      if (!examLike) continue
      const recoveredStem = normalizeBlock(sanitizedBlock)
      questions.push({
        id: `${sourceName}-${number}`,
        number,
        stem: recoveredStem || `${number}번 문항 원문을 확인해 주세요.`,
        choices: [
          '1번 선택지 원문 복구 필요',
          '2번 선택지 원문 복구 필요',
          '3번 선택지 원문 복구 필요',
          '4번 선택지 원문 복구 필요',
        ],
        answer: answerMap.get(number),
        sourceName,
      })
      continue
    }
    const filledChoices = parsed.choices.map((choice, idx) =>
      choice || `${idx + 1}번 선택지는 원문 이미지/도표를 확인해 주세요.`,
    )

    questions.push({
      id: `${sourceName}-${number}`,
      number,
      stem: parsed.stem,
      choices: filledChoices,
      answer: answerMap.get(number),
      sourceName,
    })
  }

  const uniqueByNumber = new Map<number, Question>()
  const qualityScore = (question: Question) =>
    question.stem.length + question.choices.reduce((sum, choice) => sum + choice.length, 0)
  for (const question of questions) {
    const existing = uniqueByNumber.get(question.number)
    if (!existing || qualityScore(question) > qualityScore(existing)) {
      uniqueByNumber.set(question.number, question)
    }
  }

  const maxNumberFromAnswerMap = Math.max(0, ...answerMap.keys())
  const numberingMax = Math.max(
    0,
    ...[...text.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s*/g)].map((match) => Number(match[1])),
  )
  const normalizedSourceName = sourceName.normalize('NFC')
  const expectedCountFromSource =
    (isLikelyExamSourceName(normalizedSourceName) || /(?:^|[^0-9])100문항/.test(text)) ? 100 : 0
  const safeNumberingMax = numberingMax >= 80 && numberingMax <= 130 ? numberingMax : 0
  const expectedCount =
    expectedCountFromSource > 0
      ? expectedCountFromSource
      : Math.max(maxNumberFromAnswerMap, safeNumberingMax)

  // 누락 번호를 placeholder 문항으로 보강해 번호 누락을 방지
  if (expectedCount > 0 && examLike) {
    for (const number of [...uniqueByNumber.keys()]) {
      if (number > expectedCount) uniqueByNumber.delete(number)
    }
    for (let number = 1; number <= expectedCount; number += 1) {
      if (uniqueByNumber.has(number)) continue
      uniqueByNumber.set(number, {
        id: `${sourceName}-${number}`,
        number,
        stem: `${number}번 문항 원문을 복구하지 못했습니다. PDF 원문을 확인해 주세요.`,
        choices: [
          '1번 선택지 원문 복구 필요',
          '2번 선택지 원문 복구 필요',
          '3번 선택지 원문 복구 필요',
          '4번 선택지 원문 복구 필요',
        ],
        answer: answerMap.get(number),
        sourceName,
      })
    }
  }
  return [...uniqueByNumber.values()].sort((a, b) => a.number - b.number)
}

const parseQuestions = (text: string, sourceName: string): Question[] => {
  const structured = parseStructuredQuestions(text, sourceName).filter(
    (question) => question.stem.length >= MIN_STEM_LENGTH,
  )
  if (structured.length > 0) return structured
  return generateFallbackQuestions(text, sourceName)
}

const detectExpectedQuestionCount = (text: string, sourceName: string): number => {
  const normalizedSourceName = sourceName.normalize('NFC')
  if (isLikelyExamSourceName(normalizedSourceName)) return 100

  const questionZone = text.split(/(?:^|\n)\s*(?:\d+회\s*)?정답\s*(?:및)?\s*해설[\s\S]*$/m)[0] ?? text
  const answerMap = parseAnswerMap(text)
  const answerMax = Math.max(0, ...answerMap.keys())
  const safeAnswerMax = answerMap.size >= 60 && answerMax >= 80 && answerMax <= 130 ? answerMax : 0

  const numberingMax = Math.max(
    0,
    ...[...questionZone.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s*/g)].map((match) => Number(match[1])),
  )
  const safeNumberingMax = numberingMax >= 80 && numberingMax <= 130 ? numberingMax : 0

  const explicitCount = Number(questionZone.match(/(\d{2,3})\s*문항/)?.[1] ?? 0)
  const safeExplicitCount = explicitCount >= 80 && explicitCount <= 130 ? explicitCount : 0

  return Math.max(safeAnswerMax, safeNumberingMax, safeExplicitCount)
}

const ensureQuestionCompleteness = (questions: Question[], text: string, sourceName: string): void => {
  const expectedCount = detectExpectedQuestionCount(text, sourceName)
  if (expectedCount <= 0) return

  const questionNums = new Set(questions.map((question) => question.number))
  const missing: number[] = []
  for (let n = 1; n <= expectedCount; n += 1) {
    if (!questionNums.has(n)) missing.push(n)
  }
  if (!missing.length) return

  const preview = missing.slice(0, 12).join(', ')
  const suffix = missing.length > 12 ? ' ...' : ''
  throw new PdfParseError(
    'PARSE_FAILED',
    `문항 누락 감지: 총 ${expectedCount}문항 중 ${missing.length}개 누락 (${preview}${suffix})`,
  )
}

const loadPdfRuntime = async (): Promise<{ isBrowser: boolean; pdfjs: any }> => {
  const isBrowser = typeof window !== 'undefined'
  const pdfjs = isBrowser
    ? await import('pdfjs-dist')
    : await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (isBrowser && 'GlobalWorkerOptions' in pdfjs) {
    let workerSrc = ''
    try {
      const workerModule = await import('pdfjs-dist/build/pdf.worker.mjs?url')
      workerSrc = String((workerModule as { default?: string }).default ?? '')
    } catch {
      workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
    }
    ;(pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = workerSrc
  }
  return { isBrowser, pdfjs }
}

type PdfUtilSingleton = { transform: (a: number[], b: number[]) => number[] }

/** 일부 브라우저(GPU 메모리)에서 초대형 캔버스 렌더/.toDataURL() 이 연쇄 실패할 때를 줄이기 위한 상한 */
const MAX_RENDER_CANVAS_DIMENSION = 6144

const renderPageRasterAndSpatial = async (
  page: any,
  pdfUtil: PdfUtilSingleton | null,
): Promise<{ pageImage: string | null; spatial: Map<number, string> }> => {
  const emptySpatial = new Map<number, string>()
  if (typeof document === 'undefined') return { pageImage: null, spatial: emptySpatial }
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return { pageImage: null, spatial: emptySpatial }

  const tries = [
    { scale: 1.05, quality: 0.42 },
    { scale: 0.92, quality: 0.4 },
    { scale: 0.82, quality: 0.38 },
    { scale: 0.68, quality: 0.35 },
    { scale: 0.55, quality: 0.32 },
    { scale: 0.45, quality: 0.3 },
    { scale: 0.38, quality: 0.28 },
  ] as const

  for (const { scale: baseScale, quality } of tries) {
    try {
      let renderScale = baseScale
      let viewport = page.getViewport({ scale: renderScale })
      while (
        viewport.width > MAX_RENDER_CANVAS_DIMENSION ||
        viewport.height > MAX_RENDER_CANVAS_DIMENSION
      ) {
        renderScale *= 0.88
        if (renderScale < 0.34) break
        viewport = page.getViewport({ scale: renderScale })
      }
      const width = Math.max(1, Math.floor(viewport.width))
      const height = Math.max(1, Math.floor(viewport.height))
      canvas.width = width
      canvas.height = height
      const renderTask = page.render({
        canvasContext: ctx,
        canvas,
        viewport,
        background: 'rgb(255, 255, 255)',
      })
      await renderTask.promise
      const jpegUrl = canvas.toDataURL('image/jpeg', quality)
      if (!jpegUrl.startsWith('data:image/jpeg') || jpegUrl.length < 96) continue

      let spatial = emptySpatial
      if (pdfUtil) {
        spatial = await extractSpatialFigureCropsForPage(page, canvas, viewport, pdfUtil)
      }

      return { pageImage: jpegUrl, spatial }
    } catch {
      // 다음 해상도 시도
    }
  }
  return { pageImage: null, spatial: emptySpatial }
}

const readPageTextSafely = async (page: any): Promise<string> => {
  const attempts: Array<Record<string, unknown>> = [
    {},
    { disableNormalization: true },
    { disableNormalization: true, includeMarkedContent: true },
  ]
  for (const options of attempts) {
    try {
      const content = await page.getTextContent(options)
      const primary = normalizeText(rebuildPageText(content.items))
      const fallback = normalizeText(rebuildFallbackText(content.items))
      const score = (value: string) =>
        [...value.matchAll(/(?:^|\n)\s*\d{1,3}\.\s+/g)].length * 3 +
        [...value.matchAll(/[①②③④]/g)].length
      const text = score(primary) >= score(fallback) ? primary : fallback
      if (text) return text
    } catch {
      // try next extraction option
    }
  }
  return ''
}

/** PDF 추출 텍스트에서 문항 번호 후보 (반각/전각 점, 괄호 번호 일부 지원, 번호·점이 줄바꿈으로 끊기는 경우 포함) */
const extractQuestionNumbersInText = (text: string): number[] => {
  const normalizedAscii = text.replace(/[\uFF10-\uFF19]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  )
  const fromLineStart = [
    ...normalizedAscii.matchAll(/(?:^|\n)\s*(\d{1,3})\s*[.．]\s*/g),
    ...normalizedAscii.matchAll(/(?:^|\n)\s*(\d{1,3})\s*\)\s*/g),
  ].map((match) => Number(match[1]))
  const splitDot = [...normalizedAscii.matchAll(/(?:^|\r?\n)\s*(\d{1,3})\s*\r?\n\s*[.．]/g)].map(
    (match) => Number(match[1]),
  )
  return [...fromLineStart, ...splitDot]
}

const isPlaceholderChoice = (choice: string): boolean =>
  /원문 이미지\/도표|선택지 원문 복구 필요|원문을 복구하지 못했습니다|원문 복구 필요/.test(
    choice,
  )

export const questionNeedsFigureImageFallback = (question: Question): boolean =>
  question.choices.some(isPlaceholderChoice) ||
  /원문을 복구하지 못했습니다/.test(question.stem)

const normalizeForMatch = (value: string): string =>
  value.replace(/\s+/g, '').replace(/[^0-9A-Za-z가-힣]/g, '')

export const attachFigureImages = (
  questions: Question[],
  pageRecords: Array<{ text: string; image: string | null }>,
): Question[] => {
  const sortedQuestions = [...questions].sort((a, b) => a.number - b.number)
  const figureByNumber = new Map<number, string>()
  const pageAnchors: Array<{ min: number; max: number; image: string }> = []
  for (const page of pageRecords) {
    if (!page.image) continue
    const nums = extractQuestionNumbersInText(page.text).filter((num) => num > 0 && num <= 200)
    const numberSet = new Set(nums)
    if (!numberSet.size) continue
    const numbers = [...numberSet]
    const min = Math.min(...numbers)
    const max = Math.max(...numbers)
    pageAnchors.push({ min, max, image: page.image })
    for (const number of numbers) {
      if (!figureByNumber.has(number)) figureByNumber.set(number, page.image)
    }
  }

  const withMappedImages = sortedQuestions.map((question) => {
    const mapped = figureByNumber.get(question.number) ?? question.figureImage
    if (!mapped) return question
    /** 전체 페이지 스냅은 일반 객관식에 붙이지 않음 → 도표/plcholder 문항만 연결 */
    if (!questionNeedsFigureImageFallback(question)) return question
    return { ...question, figureImage: mapped }
  })

  // 선택지가 placeholder인 문항은 근접 페이지 이미지를 강제로 연결해
  // 기호/도형 문항이 텍스트 없이도 풀 수 있도록 보강한다.
  const fallbackAnchors = pageAnchors.sort((a, b) => a.min - b.min)
  const pagesWithImage = pageRecords.filter((page) => Boolean(page.image))
  const maxQuestionNumber = Math.max(1, ...withMappedImages.map((item) => item.number))

  return withMappedImages.map((question) => {
    if (question.figureImage) return question
    if (!questionNeedsFigureImageFallback(question)) return question

    const stemToken = normalizeForMatch(question.stem).slice(0, 24)
    if (stemToken.length >= 8) {
      for (const page of pageRecords) {
        if (!page.image) continue
        const pageTextToken = normalizeForMatch(page.text)
        if (pageTextToken.includes(stemToken)) {
          return { ...question, figureImage: page.image }
        }
      }
    }

    for (const anchor of fallbackAnchors) {
      if (question.number >= anchor.min && question.number <= anchor.max) {
        return { ...question, figureImage: anchor.image }
      }
    }

    // 마지막 fallback: 페이지 번호 구간으로 대략 매핑
    // (텍스트 좌표가 불안정한 PDF에서도 이미지 미노출을 방지)
    if (pagesWithImage.length > 0) {
      const pageIdx = Math.min(
        pagesWithImage.length - 1,
        Math.max(0, Math.floor(((question.number - 1) / maxQuestionNumber) * pagesWithImage.length)),
      )
      const bucketImage = pagesWithImage[pageIdx]?.image ?? null
      if (bucketImage) return { ...question, figureImage: bucketImage }
    }

    let nearestImage: string | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const anchor of fallbackAnchors) {
      const distance =
        question.number < anchor.min
          ? anchor.min - question.number
          : question.number > anchor.max
            ? question.number - anchor.max
            : 0
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestImage = anchor.image
      }
    }
    if (nearestImage) return { ...question, figureImage: nearestImage }

    return question
  })
}

export type PdfPageRecord = {
  text: string
  image: string | null
}

export type PdfReadResult = {
  pages: PdfPageRecord[]
  spatialCropsByQuestionNumber: Map<number, string>
  totalPages: number
}

/**
 * 동일 바이너리로 여러 페이지를 순회/readPdfPages/지연 래스터 에서 재사용.
 */
const createPdfJsDocument = async (
  dataInput: Uint8Array,
): Promise<{
  pdf: any
  pdfUtil: PdfUtilSingleton | null
  isBrowser: boolean
  destroyLoadingTask: () => Promise<void>
}> => {
  const data =
    dataInput.byteOffset === 0 && dataInput.byteLength === dataInput.buffer.byteLength
      ? dataInput
      : new Uint8Array(dataInput)

  const { isBrowser, pdfjs } = await loadPdfRuntime()
  const { getDocument } = pdfjs
  const pdfNs = pdfjs as { Util?: PdfUtilSingleton }
  const pdfUtil: PdfUtilSingleton | null =
    isBrowser && typeof pdfNs.Util?.transform === 'function' ? (pdfNs.Util as PdfUtilSingleton) : null

  let loadingTask = getDocument({ data, stopAtErrors: false, isEvalSupported: false })
  try {
    const pdf = await loadingTask.promise
    return {
      pdf,
      pdfUtil,
      isBrowser,
      destroyLoadingTask: () => loadingTask.destroy(),
    }
  } catch {
    try {
      await loadingTask.destroy()
    } catch {
      // ignore cleanup failure
    }
    loadingTask = getDocument({
      data,
      stopAtErrors: false,
      isEvalSupported: false,
      disableWorker: true,
    })
    try {
      const pdf = await loadingTask.promise
      return {
        pdf,
        pdfUtil,
        isBrowser,
        destroyLoadingTask: () => loadingTask.destroy(),
      }
    } catch {
      try {
        await loadingTask.destroy()
      } catch {
        // ignore cleanup failure
      }
      loadingTask = getDocument({
        data,
        stopAtErrors: false,
        isEvalSupported: true,
        disableWorker: true,
      })
      const pdf = await loadingTask.promise
      return {
        pdf,
        pdfUtil,
        isBrowser,
        destroyLoadingTask: () => loadingTask.destroy(),
      }
    }
  }
}

const readPdfPages = async (file: File): Promise<PdfReadResult> => {
  if (file.size > MAX_PDF_SIZE_BYTES) throw new PdfParseError('TOO_LARGE')
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new PdfParseError('INVALID_TYPE')
  }

  const header = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer())
  if (!header.includes(PDF_MAGIC_HEADER)) throw new PdfParseError('INVALID_PDF')

  const data = new Uint8Array(await file.arrayBuffer())

  try {
    const { pdf, pdfUtil, isBrowser, destroyLoadingTask } = await createPdfJsDocument(data)
    try {
      const totalPages = pdf.numPages
      const pageTexts: string[] = []
      const renderedImages: Array<string | null> = []
      const spatialMerged = new Map<number, string>()

      for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
        try {
          const page = await pdf.getPage(pageNum)
          const pageText = await readPageTextSafely(page)
          pageTexts.push(pageText)
          if (isBrowser) {
            try {
              const { pageImage, spatial } = await renderPageRasterAndSpatial(page as never, pdfUtil)
              renderedImages.push(pageImage)
              for (const [number, cropUrl] of spatial) {
                const prev = spatialMerged.get(number)
                if (!prev) spatialMerged.set(number, cropUrl)
                /** 여러 페이지에서 같은 번호가 나오면 더 상세해 보이는(데이터량이 큰) 크롭을 선호해 잘못 된 얇은 줄 스캔을 덜어 줌 */
                else if (cropUrl.length > prev.length * 1.08) spatialMerged.set(number, cropUrl)
              }
            } catch {
              renderedImages.push(null)
            }
          } else {
            renderedImages.push(null)
          }
        } catch {
          pageTexts.push('')
          renderedImages.push(null)
        }
      }

      if (!pageTexts.some((text) => text.trim().length > 0)) {
        throw new PdfParseError('MALFORMED_PDF')
      }

      return {
        pages: pageTexts.map((text, index) => ({
          text,
          image: renderedImages[index] ?? null,
        })),
        spatialCropsByQuestionNumber: spatialMerged,
        totalPages,
      }
    } finally {
      try {
        await destroyLoadingTask()
      } catch {
        // ignore cleanup failure
      }
    }
  } catch (error) {
    if (error instanceof PdfParseError) throw error
    throw new PdfParseError('MALFORMED_PDF')
  }
}

/** 저장된 PDF 바이너리에서 총 페이지 수만 조회할 때 사용 */
export const getPdfPageCountFromBytes = async (pdfBytes: Uint8Array): Promise<number | null> => {
  if (typeof window === 'undefined') return null
  try {
    const { pdf, destroyLoadingTask } = await createPdfJsDocument(pdfBytes)
    try {
      const n = pdf.numPages
      return typeof n === 'number' && n > 0 ? n : null
    } finally {
      try {
        await destroyLoadingTask()
      } catch {
        // ignore cleanup failure
      }
    }
  } catch {
    return null
  }
}

/** 풀이 화면 지연 렌더: 저장된 원본에서 특정 페이지만 JPEG Data URL 로 변환 */
export const renderPdfPageIndexToDataUrl = async (
  pdfBytes: Uint8Array,
  pageNumber1Based: number,
): Promise<string | null> => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  try {
    const { pdf, pdfUtil, destroyLoadingTask } = await createPdfJsDocument(pdfBytes)
    try {
      const n = pdf.numPages
      const clamped = Math.min(Math.max(1, Math.floor(pageNumber1Based)), Math.max(1, n))
      const page = await pdf.getPage(clamped)
      const { pageImage } = await renderPageRasterAndSpatial(page as never, pdfUtil)
      return pageImage
    } finally {
      try {
        await destroyLoadingTask()
      } catch {
        // ignore cleanup failure
      }
    }
  } catch {
    return null
  }
}

export const extractTextFromPdf = async (file: File): Promise<string> => {
  const { pages } = await readPdfPages(file)
  return normalizeText(pages.map((page) => page.text).join('\n'))
}

export const parseQuestionsFromPdfText = (text: string, sourceName: string): Question[] =>
  parseQuestions(normalizeText(text), sourceName)

const attachNearestRasterPageToPlaceholder = (
  questions: Question[],
  pageRasters: Array<string | null>,
): Question[] => {
  const rasters = pageRasters.filter((url): url is string => Boolean(url))
  if (!rasters.length) return questions

  const maxNum = Math.max(1, ...questions.map((q) => q.number))
  return questions.map((question) => {
    if (!questionNeedsFigureImageFallback(question)) return question
    if (question.figureImage || question.figures?.length) return question

    const pageIdx = Math.min(
      rasters.length - 1,
      Math.max(0, Math.floor(((question.number - 1) / maxNum) * rasters.length)),
    )
    const fallbackUrl = rasters[pageIdx]!
    return {
      ...question,
      figureImage: fallbackUrl,
      hasFigure: true,
      figures: [{ dataUrl: fallbackUrl }],
    }
  })
}

export const parseQuestionsFromPdfFile = async (
  file: File,
  sourceName: string,
): Promise<{ questions: Question[]; totalPages: number }> => {
  const { pages, spatialCropsByQuestionNumber, totalPages } = await readPdfPages(file)
  const text = normalizeText(pages.map((page) => page.text).join('\n'))
  const parsed = parseQuestions(text, sourceName)
  ensureQuestionCompleteness(parsed, text, sourceName)
  const withMapped = attachFigureImages(parsed, pages)
  /** 고해상도 페이지 래스터를 붙인 뒤에도 플레이스홀더 도표 문항에는 spatial 크롭이 덮어씌워지도록 유지한다. */
  let overlaid = overlaySpatialFiguresOntoQuestions(
    withMapped,
    spatialCropsByQuestionNumber,
    (question) => questionNeedsFigureImageFallback(question),
  )
  overlaid = attachNearestRasterPageToPlaceholder(
    overlaid,
    pages.map((p) => p.image),
  )
  const questions = overlaid.map((question) => ({
    ...question,
    hasFigure: Boolean(question.figureImage || question.figures?.length),
  }))
  return { questions, totalPages }
}

export const analyzePdfTextStructure = (
  text: string,
): {
  estimatedType: 'exam' | 'document'
  questionStartCount: number
  markerChoiceCount: number
  sentenceCount: number
} => {
  const normalized = normalizeText(text)
  const questionStartCount = [...normalized.matchAll(/(?:^|\n)\s*\d{1,3}[.)]\s+/g)].length
  const markerChoiceCount = [...normalized.matchAll(/[①②③④]/g)].length
  const sentenceCount = splitSentenceCandidates(normalized).length
  return {
    estimatedType: questionStartCount >= 5 && markerChoiceCount >= 20 ? 'exam' : 'document',
    questionStartCount,
    markerChoiceCount,
    sentenceCount,
  }
}

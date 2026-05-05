import type { Question } from '../../types'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'

const CHOICE_MARKERS = ['①', '②', '③', '④']
const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024
const PDF_MAGIC_HEADER = '%PDF-'
const MIN_STEM_LENGTH = 12
const MAX_FALLBACK_QUESTIONS = 60
const FIGURE_HINT_REGEX =
  /(다음\s*(그래프|그림|도표)|아래\s*(그래프|그림|도표)|(?:다음|아래)\s*표\b|<그림>|도식|다이어그램)/i

export type PdfErrorCode =
  | 'INVALID_TYPE'
  | 'TOO_LARGE'
  | 'INVALID_PDF'
  | 'MALFORMED_PDF'
  | 'PARSE_FAILED'

export class PdfParseError extends Error {
  code: PdfErrorCode

  constructor(code: PdfErrorCode) {
    super(code)
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
  const points = [...text.matchAll(/(?:^|[\s)])(\d{1,3})\.\s*/g)].map((match) => ({
    number: Number(match[1]),
    index: (match.index ?? 0) + match[0].lastIndexOf(match[1]),
  }))
  if (!points.length) return []

  const accepted: Array<{ number: number; index: number }> = []
  let expected = 1
  for (const point of points) {
    if (point.number !== expected) {
      // allow restarting when a new exam section begins
      if (expected > 50 && point.number === 1) {
        expected = 1
      } else {
        continue
      }
    }
    accepted.push(point)
    expected += 1
  }

  if (!accepted.length) return []
  return accepted.map((point, idx) => {
    const start = point.index
    const end = accepted[idx + 1]?.index ?? text.length
    return {
      number: point.number,
      block: text.slice(start, end).replace(/^\d{1,3}\.\s*/, '').trim(),
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
  const blocks = splitQuestionBlocksBySequence(text)
  const questions: Question[] = []

  for (const { number, block } of blocks) {
    const sanitizedBlock = block
      .split(/(?:^|\n)\s*(?:\d+회\s*)?정답 및 해설[\s\S]*$/m)[0]
      .trim()
    const parsed = splitOptionsFromBlock(sanitizedBlock)
    if (!parsed) continue
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
  for (const question of questions) {
    if (!uniqueByNumber.has(question.number)) {
      uniqueByNumber.set(question.number, question)
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

const loadPdfRuntime = async (): Promise<{ isBrowser: boolean; pdfjs: any }> => {
  const isBrowser = typeof window !== 'undefined'
  const pdfjs = isBrowser
    ? await import('pdfjs-dist')
    : await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (isBrowser && 'GlobalWorkerOptions' in pdfjs) {
    ;(pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = pdfWorkerSrc
  }
  return { isBrowser, pdfjs }
}

const renderPageImage = async (page: any): Promise<string | null> => {
  if (typeof document === 'undefined') return null
  const viewport = page.getViewport({ scale: 1.15 })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', 0.58)
}

const extractQuestionNumbersInText = (text: string): number[] =>
  [...text.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s*/g)].map((match) => Number(match[1]))

const attachFigureImages = (
  questions: Question[],
  pageRecords: Array<{ text: string; image: string | null }>,
): Question[] => {
  const figureByNumber = new Map<number, string>()
  for (const page of pageRecords) {
    if (!page.image) continue
    if (!FIGURE_HINT_REGEX.test(page.text)) continue
    for (const number of extractQuestionNumbersInText(page.text)) {
      if (!figureByNumber.has(number)) figureByNumber.set(number, page.image)
    }
  }
  return questions.map((question) => ({
    ...question,
    figureImage: figureByNumber.get(question.number) ?? question.figureImage,
  }))
}

const readPdfPages = async (file: File): Promise<Array<{ text: string; image: string | null }>> => {
  if (file.size > MAX_PDF_SIZE_BYTES) throw new PdfParseError('TOO_LARGE')
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new PdfParseError('INVALID_TYPE')
  }

  const header = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer())
  if (header !== PDF_MAGIC_HEADER) throw new PdfParseError('INVALID_PDF')

  const { isBrowser, pdfjs } = await loadPdfRuntime()
  const { getDocument } = pdfjs

  const data = await file.arrayBuffer()
  const loadingTask = getDocument({ data, stopAtErrors: true, isEvalSupported: false })

  try {
    const pdf = await loadingTask.promise
    const pageTexts: string[] = []
    const figurePageIndexes: number[] = []

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum)
      const content = await page.getTextContent()
      const pageText = normalizeText(rebuildPageText(content.items))
      pageTexts.push(pageText)
      if (isBrowser && FIGURE_HINT_REGEX.test(pageText)) {
        figurePageIndexes.push(pageNum - 1)
      }
    }

    const imagesByIndex = new Map<number, string>()
    if (isBrowser) {
      for (const pageIndex of figurePageIndexes) {
        const page = await pdf.getPage(pageIndex + 1)
        try {
          const rendered = await renderPageImage(page as never)
          if (rendered) imagesByIndex.set(pageIndex, rendered)
        } catch {
          // Image rendering failures should not block text parsing.
        }
      }
    }
    return pageTexts.map((text, index) => ({
      text,
      image: imagesByIndex.get(index) ?? null,
    }))
  } catch {
    throw new PdfParseError('MALFORMED_PDF')
  } finally {
    try {
      await loadingTask.destroy()
    } catch {
      // ignore cleanup failure
    }
  }
}

export const extractTextFromPdf = async (file: File): Promise<string> => {
  const pages = await readPdfPages(file)
  return normalizeText(pages.map((page) => page.text).join('\n'))
}

export const parseQuestionsFromPdfText = (text: string, sourceName: string): Question[] =>
  parseQuestions(normalizeText(text), sourceName)

export const parseQuestionsFromPdfFile = async (file: File, sourceName: string): Promise<Question[]> => {
  const pages = await readPdfPages(file)
  const text = normalizeText(pages.map((page) => page.text).join('\n'))
  const parsed = parseQuestions(text, sourceName)
  return attachFigureImages(parsed, pages)
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

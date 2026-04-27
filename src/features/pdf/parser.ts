import type { Question } from '../../types'

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
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

const splitByChoiceMarkers = (block: string): { stem: string; choices: string[] } | null => {
  const i1 = block.indexOf('①')
  const i2 = block.indexOf('②')
  const i3 = block.indexOf('③')
  const i4 = block.indexOf('④')
  if ([i1, i2, i3, i4].some((idx) => idx < 0)) return null
  if (!(i1 < i2 && i2 < i3 && i3 < i4)) return null

  return {
    stem: normalizeBlock(block.slice(0, i1)),
    choices: [
      normalizeBlock(block.slice(i1 + 1, i2)),
      normalizeBlock(block.slice(i2 + 1, i3)),
      normalizeBlock(block.slice(i3 + 1, i4)),
      normalizeBlock(block.slice(i4 + 1)),
    ],
  }
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

  return splitByNumberedChoices(block)
}

const splitQuestionBlocksBySequence = (text: string): Array<{ number: number; block: string }> => {
  const points = [...text.matchAll(/(?:^|\n)\s*(\d{1,3})\.\s*/g)].map((match) => ({
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
    const parsed = splitOptionsFromBlock(block)
    if (!parsed || parsed.choices.some((choice) => !choice)) continue

    questions.push({
      id: `${sourceName}-${number}`,
      number,
      stem: parsed.stem,
      choices: parsed.choices,
      answer: answerMap.get(number),
      sourceName,
    })
  }

  return questions
}

const parseQuestions = (text: string, sourceName: string): Question[] => {
  const structured = parseStructuredQuestions(text, sourceName).filter(
    (question) => question.stem.length >= MIN_STEM_LENGTH,
  )
  if (structured.length > 0) return structured
  return generateFallbackQuestions(text, sourceName)
}

export const extractTextFromPdf = async (file: File): Promise<string> => {
  if (file.size > MAX_PDF_SIZE_BYTES) throw new PdfParseError('TOO_LARGE')
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new PdfParseError('INVALID_TYPE')
  }

  const header = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer())
  if (header !== PDF_MAGIC_HEADER) throw new PdfParseError('INVALID_PDF')

  const isBrowser = typeof window !== 'undefined'
  const pdfjs = isBrowser
    ? await import('pdfjs-dist')
    : await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { getDocument } = pdfjs

  if (isBrowser && 'GlobalWorkerOptions' in pdfjs) {
    const workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
    ;(pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = workerSrc
  }
  const data = await file.arrayBuffer()
  const loadingTask = getDocument({ data, stopAtErrors: true, isEvalSupported: false })

  try {
    const pdf = await loadingTask.promise
    let output = ''

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum)
      const content = await page.getTextContent()
      const pageText = rebuildPageText(content.items)
      output += `\n${pageText}`
    }
    return normalizeText(output)
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

export const parseQuestionsFromPdfText = (text: string, sourceName: string): Question[] =>
  parseQuestions(normalizeText(text), sourceName)

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

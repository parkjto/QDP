/**
 * PDF.js 텍스트 transform(뷰포트 좌표)으로 문항 세로 블록을 추정하고,
 * 동일 페이지 캔버스에서 해당 영역을 잘라 문항별 figure Data URL 생성.
 *
 * 2단(multi-column) 레이아웃: 뷰포트 중앙 X를 기준으로 좌/우 텍스트를 분리해
 * Y 밴드 계산 시 옆 단 문제 번호·텍스트가 섞이지 않도록 한다.
 */

import type { Question } from '../../types'

/** pdf.js TextContent 아이템에서 Util.transform 결과로 뷰포트 사각형 추정 */
const LINE_Y_BUCKET = 5

/** 뷰포트 중앙 근처 허용 오차 (좌·우 단 경계 블리딩) */
const COLUMN_EDGE_EPS = 4

export type SpatialCropResult = Map<number, string>

/** 추출 시 사용할 단: 전체 / 좌 / 우 */
export type ColumnFilter = 'all' | 'left' | 'right'

type ViewportLike = {
  transform: number[]
  width: number
  height: number
}

type PdfUtil = {
  transform: (m1: number[], m2: number[]) => number[]
}

const itemToBBox = (
  raw: unknown,
  viewport: ViewportLike,
  Util: PdfUtil,
): { x: number; yBaseline: number; top: number; bottom: number; str: string } | null => {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { str?: string; transform?: number[]; width?: number; height?: number }
  const str = String(obj.str ?? '')
  const tr = obj.transform
  if (!Array.isArray(tr) || tr.length < 6) return null
  const t = Util.transform(viewport.transform, tr)
  const x = Number(t[4] ?? 0)
  const yBaseline = Number(t[5] ?? 0)
  const scale = Math.hypot(Number(t[0] ?? 1), Number(t[1] ?? 0))
  const fh = Math.max(10, Math.abs(Number(obj.height ?? 12)) * scale)
  const top = yBaseline - fh * 1.08
  const bottom = yBaseline + fh * 0.12
  return { x, yBaseline, top, bottom, str }
}

const clusterLineKey = (yBaseline: number): number =>
  Math.round(yBaseline / LINE_Y_BUCKET) * LINE_Y_BUCKET

const normalizeAsciiDigitsInString = (value: string): string =>
  value.replace(/[\uFF10-\uFF19]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  )

const extractLeadingQuestionNumber = (rawLineText: string): number | null => {
  const trimmed = normalizeAsciiDigitsInString(rawLineText.trim())
  const compact = trimmed.replace(/\s+/g, '')
  let matched = trimmed.match(/^(\d{1,3})\s*(?:번)?\s*[.．)\]]\s*/)
  if (!matched) matched = compact.match(/^(\d{1,3})[.．)\]]/)
  if (!matched) return null
  const num = Number(matched[1])
  if (num <= 0 || num > 200) return null
  return num
}

/**
 * 페이지 하단 표기 등 "- 1 -" 줄이 문항 1번 앵커로 잡히는 것 방지 (2단 페이지에서 특히 크롭 Y가 크게 어긋남).
 */
export const shouldSkipLineAsQuestionAnchor = (lineText: string): boolean => {
  let compact = normalizeAsciiDigitsInString(lineText.trim()).replace(/\s+/g, '')
  compact = compact.replace(/[—–]/g, '-')
  if (!compact.length) return true
  if (/^-+\d{1,3}-+$/.test(compact)) return true
  return false
}

type LineRow = {
  key: number
  text: string
  avgY: number
  top: number
  bottom: number
  minX: number
}

const stitchSplitQuestionNumberLines = (sortedByY: LineRow[]): LineRow[] => {
  const out: LineRow[] = []
  let i = 0
  while (i < sortedByY.length) {
    const cur = sortedByY[i]
    const next = sortedByY[i + 1]
    if (next) {
      const dy = Math.abs(next.avgY - cur.avgY)
      const t1 = normalizeAsciiDigitsInString(cur.text.trim())
      const t2 = normalizeAsciiDigitsInString(next.text.trim())
      if (
        dy < 32 &&
        /^(\d{1,3})$/.test(t1.replace(/\s+/g, '')) &&
        /^[.．)\]]/.test(t2)
      ) {
        out.push({
          key: cur.key,
          text: `${t1}${t2}`,
          avgY: (cur.avgY + next.avgY) / 2,
          top: Math.min(cur.top, next.top),
          bottom: Math.max(cur.bottom, next.bottom),
          minX: Math.min(cur.minX, next.minX),
        })
        i += 2
        continue
      }
    }
    out.push(cur)
    i += 1
  }
  return out
}

/**
 * 페이지를 좌우 2단으로 나눌지 여부: 한쪽 단에 문자가 거의 없으면 1단으로 처리.
 */
export const shouldUseTwoColumnBands = (
  items: unknown[],
  viewport: ViewportLike,
  Util: PdfUtil,
): boolean => {
  if (viewport.width < 310) return false
  let left = 0
  let right = 0
  const pivot = viewport.width / 2
  for (const raw of items) {
    const b = itemToBBox(raw, viewport, Util)
    if (!b || !b.str.trim()) continue
    if (b.x < pivot - COLUMN_EDGE_EPS) left += 1
    else if (b.x >= pivot - COLUMN_EDGE_EPS) right += 1
  }
  const minSide = Math.min(left, right)
  const total = left + right
  /** 실제 한 단만 쓴 PDF: 한쪽 문자 박스만 몰린 경우에는 전폭 크롭이 더 나음 */
  if (minSide < 8) return false
  /** 기출처럼 넓은 2단: 양쪽에 충분한 글피스가 있는 한 좌우로 나눔 (옛 설정 minSide≥14 때문에 풀폭 깨진 케이스 방지) */
  return total >= 16 && minSide >= 8
}

const passesColumnGate = (
  column: ColumnFilter,
  x: number,
  pivot: number,
): boolean => {
  if (column === 'all') return true
  if (column === 'left') return x < pivot - COLUMN_EDGE_EPS
  return x >= pivot - COLUMN_EDGE_EPS
}

/** 뷰포트 내 문항 번호 줄 → 다음 번호 직전까지의 세로 픽셀 밴드 */
export const extractQuestionBandsFromViewport = (
  items: unknown[],
  viewport: ViewportLike,
  Util: PdfUtil,
  column: ColumnFilter = 'all',
): Map<number, { topPx: number; bottomPx: number }> => {
  const pivot = viewport.width / 2
  type Seg = { x: number; top: number; bottom: number; str: string; yBaseline: number }
  const buckets = new Map<number, Seg[]>()

  for (const raw of items) {
    const b = itemToBBox(raw, viewport, Util)
    if (!b || !b.str.trim()) continue
    if (!passesColumnGate(column, b.x, pivot)) continue
    const key = clusterLineKey(b.yBaseline)
    const seg = { x: b.x, top: b.top, bottom: b.bottom, str: b.str, yBaseline: b.yBaseline }
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(seg)
  }

  const lineRows: LineRow[] = [...buckets.entries()]
    .map(([key, segs]) => {
      const sorted = [...segs].sort((a, b) => a.x - b.x)
      const text = sorted.map((item) => item.str).join('')
      const avgY =
        sorted.reduce((sum, item) => sum + item.yBaseline, 0) /
        Math.max(1, sorted.length)
      const top = Math.min(...sorted.map((item) => item.top))
      const bottom = Math.max(...sorted.map((item) => item.bottom))
      const minX = Math.min(...sorted.map((item) => item.x))
      return { key, text, avgY, top, bottom, minX }
    })
    .sort((a, b) =>
      Math.abs(a.avgY - b.avgY) > 4 ? a.avgY - b.avgY : a.minX - b.minX,
    )

  const lines = stitchSplitQuestionNumberLines(lineRows)

  const anchors: Array<{ num: number; top: number; bottom: number }> = []
  for (const line of lines) {
    if (shouldSkipLineAsQuestionAnchor(line.text)) continue
    const num = extractLeadingQuestionNumber(line.text)
    if (num === null) continue
    anchors.push({
      num,
      top: line.top,
      bottom: line.bottom,
    })
  }

  anchors.sort((a, b) => (a.top !== b.top ? a.top - b.top : a.num - b.num))

  const out = new Map<number, { topPx: number; bottomPx: number }>()
  const pageBottom = viewport.height
  /** 다음 번호 줄과의 간격을 넓혀 서로 다른 문항이 한 이미지에 섞이는 것을 줄임 */
  const alpha = 14

  for (let idx = 0; idx < anchors.length; idx += 1) {
    const anchor = anchors[idx]
    const nextTop = anchors[idx + 1]?.top ?? pageBottom
    /** 이전 문제 본문이 너무 많이 포함되지 않도록 상단 여백을 줄임 */
    let topPx = anchor.top - 4
    const bottomPx = Math.min(nextTop - alpha, pageBottom)

    topPx = Math.max(0, Math.min(topPx, pageBottom - 40))
    if (bottomPx - topPx < 56) continue
    const cappedBottom = Math.min(topPx + pageBottom * 0.92, bottomPx + 36)
    if (cappedBottom - topPx < 56) continue
    /** 동일 회차 레이아웃 재현 시 같은 번호가 좌우에 중복될 때는 더 넓은 밴드를 유리하게 택하지 않음: 먼저 확정 값 유지 */
    if (!out.has(anchor.num)) out.set(anchor.num, { topPx, bottomPx: cappedBottom })
  }

  return out
}

/** 개발 디버그: 브라우저 콘솔에서 `window.__QDF_DEBUG_FIGURE_BANDS__ = true` 후 재업로드 */
export const isFigureBandDebugEnabled = (): boolean =>
  typeof window !== 'undefined' &&
  (window as unknown as { __QDF_DEBUG_FIGURE_BANDS__?: boolean }).__QDF_DEBUG_FIGURE_BANDS__ === true

const paintDebugBandsOnCanvas = (
  source: HTMLCanvasElement,
  bands: Map<number, { topPx: number; bottomPx: number }>,
  clipLeftPx: number,
  clipWidthPx: number,
): void => {
  const ctx = source.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 0, 0, 0.92)'
  ctx.lineWidth = 2
  for (const [, { topPx, bottomPx }] of bands) {
    const y1 = Math.max(0, topPx)
    const y2 = Math.min(source.height, bottomPx)
    if (y2 - y1 < 40) continue
    ctx.strokeRect(Math.max(0, clipLeftPx) + 0.5, y1 + 0.5, Math.max(1, clipWidthPx - 1), y2 - y1)
  }
  ctx.restore()

  console.info('[QDF] figure bands debug (red rects). Columns clip:', {
    clipLeftPx,
    clipWidthPx,
    count: bands.size,
  })
}

export const cropCanvasVerticalRegion = (
  source: HTMLCanvasElement,
  topPx: number,
  bottomPx: number,
  clipLeftPx: number,
  clipWidthPx: number,
  quality = 0.42,
): string | null => {
  if (!source.getContext('2d') || bottomPx <= topPx + 24) return null

  const sx = Math.max(0, Math.floor(clipLeftPx))
  const sw = Math.min(source.width - sx, Math.floor(clipWidthPx))
  if (sw < 32) return null

  let sy = Math.max(0, Math.floor(topPx))
  let dh = Math.min(source.height - sy, Math.floor(bottomPx - topPx))
  const maxH = Math.floor(source.height * 0.9)
  if (dh > maxH) dh = maxH
  if (dh < 48) return null

  const out = document.createElement('canvas')
  out.width = sw
  out.height = dh
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.fillStyle = '#ffffff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(source, sx, sy, sw, dh, 0, 0, sw, dh)
  const url = out.toDataURL('image/jpeg', quality)
  return url.length > 80 ? url : null
}

export const cropCanvasVertical = (
  source: HTMLCanvasElement,
  topPx: number,
  bottomPx: number,
  quality = 0.42,
): string | null => cropCanvasVerticalRegion(source, topPx, bottomPx, 0, source.width, quality)

const collectBandsAndCropsForPage = async (
  _page: any,
  canvas: HTMLCanvasElement,
  viewport: ViewportLike,
  pdfUtil: PdfUtil,
  items: unknown[],
): Promise<SpatialCropResult> => {
  const out = new Map<number, string>()
  if (typeof document === 'undefined') return out

  const scaleX = canvas.width / Math.max(1, viewport.width)
  /** 캔버스 X 기준 분할선 */
  const canvasPivotPx = Math.min(canvas.width - 1, Math.max(1, Math.floor((viewport.width / 2) * scaleX)))
  const leftClipW = canvasPivotPx
  const rightClipW = canvas.width - canvasPivotPx

  const split = shouldUseTwoColumnBands(items, viewport, pdfUtil)

  if (!split) {
    const bands = extractQuestionBandsFromViewport(items, viewport, pdfUtil, 'all')
    if (import.meta.env.DEV && isFigureBandDebugEnabled()) {
      const dbgCanvas = document.createElement('canvas')
      dbgCanvas.width = canvas.width
      dbgCanvas.height = canvas.height
      const dctx = dbgCanvas.getContext('2d')
      if (dctx) {
        dctx.drawImage(canvas, 0, 0)
        paintDebugBandsOnCanvas(dbgCanvas, bands, 0, canvas.width)
        ;(
          window as unknown as {
            __QDF_LAST_FIGURE_DEBUG_DATA_URL__?: string
          }
        ).__QDF_LAST_FIGURE_DEBUG_DATA_URL__ = dbgCanvas.toDataURL('image/png')
        console.info('[QDF] window.__QDF_LAST_FIGURE_DEBUG_DATA_URL__ 에 전체 페이지 밴드 시각화 저장됨')
      }
    }

    for (const [num, { topPx, bottomPx }] of bands) {
      const cropped = cropCanvasVertical(canvas, topPx, bottomPx)
      if (cropped) out.set(num, cropped)
    }
    return out
  }

  const leftBands = extractQuestionBandsFromViewport(items, viewport, pdfUtil, 'left')
  const rightBands = extractQuestionBandsFromViewport(items, viewport, pdfUtil, 'right')

  if (import.meta.env.DEV && isFigureBandDebugEnabled()) {
    const dbgCanvas = document.createElement('canvas')
    dbgCanvas.width = canvas.width
    dbgCanvas.height = canvas.height
    const dctx = dbgCanvas.getContext('2d')
    if (dctx) {
      dctx.drawImage(canvas, 0, 0)
      paintDebugBandsOnCanvas(dbgCanvas, leftBands, 0, leftClipW)
      paintDebugBandsOnCanvas(dbgCanvas, rightBands, canvasPivotPx, rightClipW)
      ;(
        window as unknown as {
          __QDF_LAST_FIGURE_DEBUG_DATA_URL__?: string
        }
      ).__QDF_LAST_FIGURE_DEBUG_DATA_URL__ = dbgCanvas.toDataURL('image/png')
      console.info('[QDF] window.__QDF_LAST_FIGURE_DEBUG_DATA_URL__ 에 2단 밴드 시각화 저장됨')
    }
  }

  for (const [num, { topPx, bottomPx }] of leftBands) {
    const cropped = cropCanvasVerticalRegion(canvas, topPx, bottomPx, 0, leftClipW)
    if (cropped) out.set(num, cropped)
  }
  for (const [num, { topPx, bottomPx }] of rightBands) {
    const cropped = cropCanvasVerticalRegion(canvas, topPx, bottomPx, canvasPivotPx, rightClipW)
    if (!cropped) continue
    const existing = out.get(num)
    if (!existing) {
      out.set(num, cropped)
      continue
    }
    if (cropped.length > existing.length) out.set(num, cropped)
  }

  return out
}

/**
 * 페이지를 한 번 그린 canvas로부터 텍스트 기반 블록을 잘라 문항번호→크롭 URL.
 */
export const extractSpatialFigureCropsForPage = async (
  page: any,
  canvas: HTMLCanvasElement,
  viewport: ViewportLike,
  pdfUtil: PdfUtil,
): Promise<SpatialCropResult> => {
  if (typeof document === 'undefined') return new Map<number, string>()

  let items: unknown[] = []
  try {
    const content = await page.getTextContent()
    items = content.items ?? []
  } catch {
    return new Map<number, string>()
  }

  return collectBandsAndCropsForPage(page, canvas, viewport, pdfUtil, items)
}

export const overlaySpatialFiguresOntoQuestions = (
  questions: Question[],
  globalCrops: Map<number, string>,
  shouldApply: (q: Question) => boolean,
): Question[] =>
  questions.map((q) => {
    const crop = globalCrops.get(q.number)
    if (!crop || !shouldApply(q)) {
      return { ...q, hasFigure: Boolean(q.figureImage || q.figures?.length) }
    }
    const primary = crop
    return {
      ...q,
      figureImage: primary,
      hasFigure: true,
      figures: [{ dataUrl: primary }],
    }
  })

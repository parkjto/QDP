import { describe, expect, it } from 'vitest'
import {
  extractQuestionBandsFromViewport,
  shouldSkipLineAsQuestionAnchor,
  shouldUseTwoColumnBands,
} from './spatialFigureCrop'

/** 단위 테스트용: 항등 뷰포트 변환만 사용 */
const noopViewport = { transform: [1, 0, 0, 1, 0, 0], width: 400, height: 800 }

describe('extractQuestionBandsFromViewport', () => {
  it('번호 시작 줄부터 다음 번호까지 세로 구간 산출', () => {
    const Util = { transform: (_viewportTr: number[], itemTr: number[]) => [...itemTr] as number[] }

    const items = [
      { str: '4. 다른 문항 라인이야', transform: [1, 0, 0, 1, 20, 100] },
      { str: '5. 선택 관계 문제', transform: [1, 0, 0, 1, 20, 200] },
      { str: '① 표시', transform: [1, 0, 0, 1, 20, 220] },
      { str: '6. 다음 시작', transform: [1, 0, 0, 1, 20, 400] },
    ]

    const bands = extractQuestionBandsFromViewport(items, noopViewport, Util)
    const band5 = bands.get(5)
    expect(band5).toBeTruthy()
    expect(band5!.topPx).toBeLessThan(band5!.bottomPx)
    expect(band5!.bottomPx).toBeLessThanOrEqual(noopViewport.height)
  })

  it('줄 버킷이 나뉘어도 "5" 다음 줄 "." 를 이어 번호 줄로 인식', () => {
    const Util = { transform: (_viewportTr: number[], itemTr: number[]) => [...itemTr] as number[] }
    /** y=208 → bucket 205, y=216 → bucket 215 (버킷이 달라 한 줄 합치기 없이 두 줄이 됨) */
    const items = [
      { str: '4.', transform: [1, 0, 0, 1, 20, 100] },
      { str: '5', transform: [1, 0, 0, 1, 20, 208] },
      { str: '.', transform: [1, 0, 0, 1, 32, 216] },
      { str: '6.', transform: [1, 0, 0, 1, 20, 400] },
    ]
    const bands = extractQuestionBandsFromViewport(items, noopViewport, Util)
    expect(bands.get(5)).toBeTruthy()
  })

  it('전각 숫자·점으로 시작하는 줄도 번호 인식', () => {
    const Util = { transform: (_viewportTr: number[], itemTr: number[]) => [...itemTr] as number[] }
    const items = [{ str: '５．문항', transform: [1, 0, 0, 1, 20, 200] }]
    const bands = extractQuestionBandsFromViewport(items, noopViewport, Util)
    expect(bands.get(5)).toBeTruthy()
  })

  it('2단 레이아웃에서 왼쪽 단만 보면 오른쪽 열 번호가 Y밴드에 섞이지 않음', () => {
    const Util = { transform: (_viewportTr: number[], itemTr: number[]) => [...itemTr] as number[] }
    const wide = { ...noopViewport, width: 400 }
    const leftFiller = Array.from({ length: 14 }, (_, idx) => ({
      str: `가${idx}`,
      transform: [1, 0, 0, 1, 40, 50 + idx * 12] as number[],
    }))
    const rightFiller = Array.from({ length: 14 }, (_, idx) => ({
      str: `나${idx}`,
      transform: [1, 0, 0, 1, 300, 50 + idx * 12] as number[],
    }))
    const items = [
      ...leftFiller,
      ...rightFiller,
      { str: '5. 좌측 문제', transform: [1, 0, 0, 1, 40, 200] },
      { str: '6. 좌측 다음', transform: [1, 0, 0, 1, 40, 420] },
      { str: '22. 우측 열 텍스트', transform: [1, 0, 0, 1, 300, 210] },
    ]
    expect(shouldUseTwoColumnBands(items, wide, Util)).toBe(true)
    const leftOnly = extractQuestionBandsFromViewport(items, wide, Util, 'left')
    expect(leftOnly.get(5)).toBeTruthy()
    expect(leftOnly.has(22)).toBe(false)
  })
})

describe('shouldSkipLineAsQuestionAnchor', () => {
  it('페이지 중앙 번호 줄은 문항 탐지에서 제외', () => {
    expect(shouldSkipLineAsQuestionAnchor('- 1 -')).toBe(true)
    expect(shouldSkipLineAsQuestionAnchor('— 12 —')).toBe(true)
    expect(shouldSkipLineAsQuestionAnchor('1. 다음 중 객체지향')).toBe(false)
  })
})

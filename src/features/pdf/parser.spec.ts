import { describe, expect, it } from 'vitest'
import type { Question } from '../../types'
import { attachFigureImages, parseQuestionsFromPdfText } from './parser'

describe('parseQuestionsFromPdfText', () => {
  it('문제/선지/정답을 파싱한다', () => {
    const sample = `
    1. 워크스루 설명으로 틀린 것은?
    ① 보기하나 ② 보기둘 ③ 보기셋 ④ 보기넷
    2. 메시지 지향 미들웨어 설명으로 틀린 것은?
    ① A ② B ③ C ④ D
    정답
    1 ③ 2 ①
    `
    const questions = parseQuestionsFromPdfText(sample, 'sample.pdf')
    expect(questions).toHaveLength(2)
    expect(questions[0].choices).toHaveLength(4)
    expect(questions[0].answer).toBe(2)
    expect(questions[1].answer).toBe(0)
  })
})

describe('attachFigureImages', () => {
  it('페이지 텍스트에 번호가 없어도 placeholder 문항에 버킷 이미지를 붙인다', () => {
    const stem = '데이터 사전에서 선택 관계 표기를 고르시오'
    const questions: Question[] = [
      {
        id: 't-5',
        number: 5,
        stem,
        choices: ['1번 선택지는 원문 이미지/도표를 확인해 주세요.'],
        answer: undefined,
        sourceName: 'x.pdf',
      },
    ]
    const pages = Array.from({ length: 40 }, (_, i) => ({
      text: `이 페이지에는 문항번호 텍스트가 없습니다 페이지 ${i + 1}`,
      image: `data:image/jpeg;base64,/9j/${i}`, // 테스트용 더미 문자열 (형식만 유사)
    }))
    const out = attachFigureImages(questions, pages)
    expect(out[0]?.figureImage).toBeTruthy()
    expect(out[0]?.figureImage).toContain('data:image')
  })

  it('전각 점이 있는 페이지 텍스트에서 문항 번호를 추출한다', () => {
    const questions: Question[] = [
      {
        id: 't-10',
        number: 10,
        stem: 'placeholder stem',
        choices: ['① 원문 이미지/도표 확인'],
        answer: undefined,
        sourceName: 'x.pdf',
      },
    ]
    const pageImage = 'data:image/jpeg;base64,ZZZ'
    const pages = [{ text: '다음부터\n\n10． 질문 본문 ① 두번째 줄', image: pageImage }]
    const out = attachFigureImages(questions, pages)
    expect(out[0]?.figureImage).toBe(pageImage)
  })

  it('일반 객관식(placeholder 아님)은 페이지에 문항 번호가 있어도 figureImage를 붙이지 않는다', () => {
    const questions: Question[] = [
      {
        id: 't-3',
        number: 3,
        stem: '텍스트만 있는 문항',
        choices: ['① A', '② B', '③ C', '④ D'],
        answer: 0,
        sourceName: 'x.pdf',
      },
    ]
    const pageImage = 'data:image/jpeg;base64,WWW'
    const pages = [{ text: '다음 페이지\n\n3. 질문 본문 ① A\n② B\n③ C\n④ D', image: pageImage }]
    const out = attachFigureImages(questions, pages)
    expect(out[0]?.figureImage).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { parseQuestionsFromPdfText } from './parser'

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

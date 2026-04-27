import { describe, expect, it } from 'vitest'
import { collectWrongAnswers, createSession, getCurrentChunkIds, submitChunkAnswers } from './engine'
import type { Question } from '../../types'

const mockQuestions: Question[] = [
  { id: 'q1', number: 1, stem: 'q1', choices: ['a', 'b', 'c', 'd'], answer: 0, sourceName: 'a' },
  { id: 'q2', number: 2, stem: 'q2', choices: ['a', 'b', 'c', 'd'], answer: 2, sourceName: 'a' },
]

describe('quiz engine', () => {
  it('chunkSize 만큼 문제를 반환한다', () => {
    const session = createSession(mockQuestions, { order: 'sequential', chunkSize: 1 })
    expect(getCurrentChunkIds(session)).toEqual(['q1'])
  })

  it('오답만 수집한다', () => {
    const session = createSession(mockQuestions, { order: 'sequential', chunkSize: 1 })
    const next = submitChunkAnswers(session, { q1: 1, q2: 2 })
    const wrong = collectWrongAnswers(next, mockQuestions, 'bundle-a')
    expect(wrong).toHaveLength(1)
    expect(wrong[0].questionId).toBe('q1')
    expect(wrong[0].bundleId).toBe('bundle-a')
  })

  it('마지막 제출 후 currentIndex가 길이를 넘지 않는다', () => {
    const session = createSession(mockQuestions, { order: 'sequential', chunkSize: 5 })
    const next = submitChunkAnswers(session, { q1: 0, q2: 2 })
    expect(next.currentIndex).toBe(2)
  })
})

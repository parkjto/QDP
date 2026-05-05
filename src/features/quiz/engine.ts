import type { Question, SessionConfig, SessionState, WrongAnswerItem } from '../../types'

const shuffle = <T,>(items: T[]): T[] => {
  const clone = [...items]
  for (let idx = clone.length - 1; idx > 0; idx -= 1) {
    const rand = Math.floor(Math.random() * (idx + 1))
    ;[clone[idx], clone[rand]] = [clone[rand], clone[idx]]
  }
  return clone
}

export const createSession = (questions: Question[], config: SessionConfig): SessionState => {
  const ids = questions.map((question) => question.id)
  return {
    config,
    questionIds: config.order === 'random' ? shuffle(ids) : ids,
    currentIndex: 0,
    answers: {},
  }
}

const resolveChunkSize = (session: SessionState): number =>
  session.config.chunkSize === 'all' ? session.questionIds.length : session.config.chunkSize

export const getCurrentChunkIds = (session: SessionState): string[] =>
  session.questionIds.slice(session.currentIndex, session.currentIndex + resolveChunkSize(session))

export const submitChunkAnswers = (
  session: SessionState,
  chunkAnswers: Record<string, number>,
): SessionState => ({
  ...session,
  answers: { ...session.answers, ...chunkAnswers },
  currentIndex: Math.min(session.currentIndex + resolveChunkSize(session), session.questionIds.length),
})

export const isSessionFinished = (session: SessionState): boolean =>
  session.questionIds.every((id) => session.answers[id] !== undefined)

export const collectWrongAnswers = (
  session: SessionState,
  questions: Question[],
  bundleId: string,
): WrongAnswerItem[] => {
  const byId = new Map(questions.map((question) => [question.id, question]))
  return Object.entries(session.answers)
    .map(([questionId, selected]) => {
      const question = byId.get(questionId)
      if (question?.answer === undefined) return null
      if (question.answer === selected) return null
      return {
        bundleId,
        questionId,
        selected,
        answeredAt: new Date().toISOString(),
      }
    })
    .filter((item): item is WrongAnswerItem => item !== null)
}

export type OptionSymbol = '①' | '②' | '③' | '④'

export interface Question {
  id: string
  number: number
  stem: string
  choices: string[]
  answer?: number
  sourceName: string
}

export interface QuestionBundle {
  id: string
  title: string
  createdAt: string
  questions: Question[]
}

export type QuestionOrder = 'sequential' | 'random'
export type QuestionChunkSize = 1 | 5

export interface SessionConfig {
  order: QuestionOrder
  chunkSize: QuestionChunkSize
}

export interface SessionState {
  config: SessionConfig
  questionIds: string[]
  currentIndex: number
  answers: Record<string, number>
}

export interface WrongAnswerItem {
  bundleId: string
  questionId: string
  selected: number
  answeredAt: string
}

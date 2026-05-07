export type OptionSymbol = '①' | '②' | '③' | '④'

/** 문항에 붙은 개별 참고 이미지(좌표 기반 크롭 등) */
export interface QuestionFigure {
  dataUrl: string
}

export interface Question {
  id: string
  number: number
  stem: string
  choices: string[]
  figureImage?: string
  figures?: QuestionFigure[]
  /** placeholder·크롭 등 시각 참고 포함 여부(표시/UI용) */
  hasFigure?: boolean
  answer?: number
  sourceName: string
}

export interface QuestionBundle {
  id: string
  title: string
  createdAt: string
  questions: Question[]
  /** 원본 PDF 페이지 수(문항↔페이지 추정·지연 렌더에 사용) */
  pdfPageCount?: number
  /** `config/figurePipeline.ts` 의 FIGURE_PIPELINE_VERSION 과 맞추어 마이그레이션·재업로드 안내에 사용 */
  figurePipelineVersion?: number
}

export type QuestionOrder = 'sequential' | 'random'
export type QuestionChunkSize = 1 | 5 | 'all'

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

export interface BookmarkItem {
  bundleId: string
  questionId: string
  bookmarkedAt: string
}

export interface QuizAttemptItem {
  bundleId: string
  questionId: string
  selected: number
  correct: boolean
  answeredAt: string
}

export interface LocalAppData {
  bundles: QuestionBundle[]
  wrongAnswers: WrongAnswerItem[]
  bookmarks: BookmarkItem[]
  quizAttempts: QuizAttemptItem[]
}

export interface SyncSnapshot extends LocalAppData {
  schemaVersion: number
  deviceId: string
  updatedAt: string
}

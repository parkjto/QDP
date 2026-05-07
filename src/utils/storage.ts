import type {
  BookmarkItem,
  LocalAppData,
  QuestionBundle,
  QuizAttemptItem,
  WrongAnswerItem,
} from '../types'

const QUESTION_BANK_KEY = 'pdfQuiz.questionBank.v2'
const WRONG_NOTE_KEY = 'pdfQuiz.wrongAnswers.v1'
const BOOKMARK_KEY = 'pdfQuiz.bookmarks.v1'
const QUIZ_ATTEMPTS_KEY = 'pdfQuiz.quizAttempts.v1'
const FIGURE_CACHE_KEY = 'pdfQuiz.figureCache.v1'

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.removeItem(key)
    return fallback
  }
}

const writeJson = <T,>(key: string, value: T): void => {
  window.localStorage.setItem(key, JSON.stringify(value))
}

export const loadQuestionBundles = (): QuestionBundle[] =>
  readJson<QuestionBundle[]>(QUESTION_BANK_KEY, [])

export const upsertQuestionBundle = (bundle: QuestionBundle): QuestionBundle[] => {
  const prev = loadQuestionBundles()
  const next = [bundle, ...prev.filter((item) => item.id !== bundle.id)]
  writeJson(QUESTION_BANK_KEY, next)
  return next
}

export const deleteQuestionBundle = (bundleId: string): QuestionBundle[] => {
  const next = loadQuestionBundles().filter((item) => item.id !== bundleId)
  writeJson(QUESTION_BANK_KEY, next)
  return next
}

export const loadWrongAnswers = (): WrongAnswerItem[] =>
  readJson<WrongAnswerItem[]>(WRONG_NOTE_KEY, [])

export const appendWrongAnswers = (items: WrongAnswerItem[]): void => {
  const byKey = new Map<string, WrongAnswerItem>()
  for (const item of loadWrongAnswers()) {
    byKey.set(`${item.bundleId}:${item.questionId}`, item)
  }
  for (const item of items) {
    byKey.set(`${item.bundleId}:${item.questionId}`, item)
  }
  writeJson(WRONG_NOTE_KEY, [...byKey.values()])
}

export const reconcileWrongAnswers = (
  bundleId: string,
  answeredIds: string[],
  wrongItems: WrongAnswerItem[],
): WrongAnswerItem[] => {
  const wrongIdSet = new Set(wrongItems.map((item) => item.questionId))
  const filtered = loadWrongAnswers().filter((item) => {
    if (item.bundleId !== bundleId) return true
    if (!answeredIds.includes(item.questionId)) return true
    return wrongIdSet.has(item.questionId)
  })
  const byKey = new Map(filtered.map((item) => [`${item.bundleId}:${item.questionId}`, item]))
  for (const item of wrongItems) {
    byKey.set(`${item.bundleId}:${item.questionId}`, item)
  }
  const next = [...byKey.values()]
  writeJson(WRONG_NOTE_KEY, next)
  return next
}

export const removeWrongAnswersByBundleId = (bundleId: string): WrongAnswerItem[] => {
  const next = loadWrongAnswers().filter((item) => item.bundleId !== bundleId)
  writeJson(WRONG_NOTE_KEY, next)
  return next
}

export const loadBookmarks = (): BookmarkItem[] => readJson<BookmarkItem[]>(BOOKMARK_KEY, [])

export const toggleBookmark = (bundleId: string, questionId: string): BookmarkItem[] => {
  const prev = loadBookmarks()
  const exists = prev.some((item) => item.bundleId === bundleId && item.questionId === questionId)
  const next = exists
    ? prev.filter((item) => !(item.bundleId === bundleId && item.questionId === questionId))
    : [...prev, { bundleId, questionId, bookmarkedAt: new Date().toISOString() }]
  writeJson(BOOKMARK_KEY, next)
  return next
}

export const removeBookmarksByBundleId = (bundleId: string): BookmarkItem[] => {
  const next = loadBookmarks().filter((item) => item.bundleId !== bundleId)
  writeJson(BOOKMARK_KEY, next)
  return next
}

export const loadQuizAttempts = (): QuizAttemptItem[] =>
  readJson<QuizAttemptItem[]>(QUIZ_ATTEMPTS_KEY, [])

export const appendQuizAttempts = (items: QuizAttemptItem[]): QuizAttemptItem[] => {
  const next = [...loadQuizAttempts(), ...items]
  writeJson(QUIZ_ATTEMPTS_KEY, next)
  return next
}

export const removeQuizAttemptsByBundleId = (bundleId: string): QuizAttemptItem[] => {
  const next = loadQuizAttempts().filter((item) => item.bundleId !== bundleId)
  writeJson(QUIZ_ATTEMPTS_KEY, next)
  return next
}

export const loadFigureCache = (): Record<string, string> =>
  readJson<Record<string, string>>(FIGURE_CACHE_KEY, {})

export const saveFigureCache = (cache: Record<string, string>): Record<string, string> => {
  writeJson(FIGURE_CACHE_KEY, cache)
  return cache
}

export const mergeFigureCache = (items: Record<string, string>): Record<string, string> => {
  const next = { ...loadFigureCache(), ...items }
  writeJson(FIGURE_CACHE_KEY, next)
  return next
}

export const removeFigureCacheByBundleId = (bundleId: string): Record<string, string> => {
  const next = Object.fromEntries(
    Object.entries(loadFigureCache()).filter(([questionId]) => !questionId.startsWith(`${bundleId}-`)),
  )
  writeJson(FIGURE_CACHE_KEY, next)
  return next
}

export const clearFigureCache = (): void => {
  writeJson(FIGURE_CACHE_KEY, {})
}

export const loadLocalAppData = (): LocalAppData => ({
  bundles: loadQuestionBundles(),
  wrongAnswers: loadWrongAnswers(),
  bookmarks: loadBookmarks(),
  quizAttempts: loadQuizAttempts(),
})

export const replaceLocalAppData = (data: LocalAppData): LocalAppData => {
  writeJson(QUESTION_BANK_KEY, data.bundles)
  writeJson(WRONG_NOTE_KEY, data.wrongAnswers)
  writeJson(BOOKMARK_KEY, data.bookmarks)
  writeJson(QUIZ_ATTEMPTS_KEY, data.quizAttempts)
  return loadLocalAppData()
}

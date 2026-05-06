import { useEffect, useMemo, useState } from 'react'
import {
  extractTextFromPdf,
  parseQuestionsFromPdfText,
  parseQuestionsFromPdfFile,
  PdfParseError,
  type PdfErrorCode,
} from './features/pdf/parser'
import {
  collectWrongAnswers,
  createSession,
} from './features/quiz/engine'
import type { QuestionBundle, SessionConfig, SessionState } from './types'
import {
  appendQuizAttempts,
  appendWrongAnswers,
  deleteQuestionBundle,
  loadBookmarks,
  loadQuizAttempts,
  loadQuestionBundles,
  loadWrongAnswers,
  reconcileWrongAnswers,
  removeBookmarksByBundleId,
  removeQuizAttemptsByBundleId,
  removeWrongAnswersByBundleId,
  toggleBookmark,
  upsertQuestionBundle,
} from './utils/storage'
import { calculatePassProbability } from './utils/analytics'

type ScreenStep = 'home' | 'library' | 'setup' | 'quiz' | 'review' | 'analytics' | 'mypage' | 'result'
type MyPageView = 'main' | 'terms' | 'privacy' | 'cache' | 'oss'
interface QuizResultSummary {
  correct: number
  wrong: number
  score: number
  elapsedSeconds: number
}
interface UploadDebugInfo {
  time: string
  code: PdfErrorCode
  message: string
  errorName: string
  errorMessage: string
  fileName: string
  fileSize: number
  fileType: string
  userAgent: string
}
type AnalyticsRange = '7d' | '30d' | 'all'
type AnalyticsMode = 'live' | 'stress'
type SubjectId = 1 | 2 | 3 | 4 | 5

const SUBJECT_LABELS: Record<SubjectId, string> = {
  1: '1과목 소프트웨어 설계',
  2: '2과목 소프트웨어 개발',
  3: '3과목 데이터베이스 구축',
  4: '4과목 프로그래밍 언어 활용',
  5: '5과목 정보시스템 구축 관리',
}

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0'

function App() {
  const [bundles, setBundles] = useState<QuestionBundle[]>(loadQuestionBundles())
  const [selectedBundleId, setSelectedBundleId] = useState<string>('')
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessionBundleId, setSessionBundleId] = useState<string>('')
  const [sessionQuestions, setSessionQuestions] = useState<QuestionBundle['questions']>([])
  const [draftAnswers, setDraftAnswers] = useState<Record<string, number>>({})
  const [wrongAnswers, setWrongAnswers] = useState(loadWrongAnswers())
  const [quizAttempts, setQuizAttempts] = useState(loadQuizAttempts())
  const [bookmarks, setBookmarks] = useState(loadBookmarks())
  const [order, setOrder] = useState<SessionConfig['order'] | null>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const [selectedFileSize, setSelectedFileSize] = useState('')
  const [uploadDebugInfo, setUploadDebugInfo] = useState<UploadDebugInfo | null>(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isAnswerChecked, setIsAnswerChecked] = useState(false)
  const [isCurrentAnswerCorrect, setIsCurrentAnswerCorrect] = useState<boolean | null>(null)
  const [isExplanationOpen, setIsExplanationOpen] = useState(false)
  const [screen, setScreen] = useState<ScreenStep>('home')
  const [settingsNotice, setSettingsNotice] = useState('')
  const [myPageView, setMyPageView] = useState<MyPageView>('main')
  const [quizStartedAt, setQuizStartedAt] = useState<number | null>(null)
  const [quizResult, setQuizResult] = useState<QuizResultSummary | null>(null)
  const [timerNow, setTimerNow] = useState<number>(Date.now())
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>('all')
  const [analyticsMode, setAnalyticsMode] = useState<AnalyticsMode>('live')
  const [figureByQuestionId, setFigureByQuestionId] = useState<Record<string, string>>({})
  const [librarySort, setLibrarySort] = useState<'recent' | 'oldest' | 'name' | 'count'>('recent')

  const selectedBundle = useMemo(
    () => bundles.find((bundle) => bundle.id === selectedBundleId) ?? bundles[0] ?? null,
    [bundles, selectedBundleId],
  )
  const sortedBundles = useMemo(() => {
    const items = [...bundles]
    if (librarySort === 'recent') {
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return items
    }
    if (librarySort === 'oldest') {
      items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return items
    }
    if (librarySort === 'name') {
      items.sort((a, b) => a.title.localeCompare(b.title, 'ko-KR'))
      return items
    }
    items.sort((a, b) => b.questions.length - a.questions.length)
    return items
  }, [bundles, librarySort])
  const questions = selectedBundle?.questions ?? []
  const questionById = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions])
  const wrongQuestionIds = useMemo(
    () =>
      new Set(
        wrongAnswers
          .filter((item) => item.bundleId === (selectedBundle?.id ?? ''))
          .map((item) => item.questionId),
      ),
    [wrongAnswers, selectedBundle?.id],
  )
  const wrongQuestionCount = useMemo(
    () => questions.filter((question) => wrongQuestionIds.has(question.id)).length,
    [questions, wrongQuestionIds],
  )
  const bookmarkIds = useMemo(
    () =>
      new Set(
        bookmarks
          .filter((item) => item.bundleId === (selectedBundle?.id ?? ''))
          .map((item) => item.questionId),
      ),
    [bookmarks, selectedBundle?.id],
  )
  const bookmarkQuestionCount = useMemo(
    () => questions.filter((question) => bookmarkIds.has(question.id)).length,
    [questions, bookmarkIds],
  )
  const reviewQuestionCount = useMemo(
    () => new Set([...wrongQuestionIds, ...bookmarkIds]).size,
    [wrongQuestionIds, bookmarkIds],
  )
  const canStartQuiz =
    Boolean(selectedBundle) &&
    questions.length > 0 &&
    Boolean(order)
  const hasBundles = bundles.length > 0
  const currentQuestion = useMemo(() => {
    if (!session) return null
    const currentId = session.questionIds[session.currentIndex]
    return currentId ? questionById.get(currentId) ?? null : null
  }, [session, questionById])
  const totalQuestionsInSession = session?.questionIds.length ?? 0
  const answeredCount = session ? Object.keys(session.answers).length : 0
  const currentStep = totalQuestionsInSession
    ? Math.min((session?.currentIndex ?? 0) + 1, totalQuestionsInSession)
    : 0
  const progressPercent = totalQuestionsInSession
    ? Math.round((answeredCount / totalQuestionsInSession) * 100)
    : 0
  const isTouchDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return true
    return navigator.maxTouchPoints > 0
  }, [])

  useEffect(() => {
    if (!session || !quizStartedAt) return
    const timer = window.setInterval(() => {
      setTimerNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [session, quizStartedAt])

  const elapsedSecondsLive = useMemo(() => {
    if (!quizStartedAt) return 0
    return Math.max(0, Math.floor((timerNow - quizStartedAt) / 1000))
  }, [quizStartedAt, timerNow])

  const formatElapsed = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }


  const formatExamRound = (rawTitle: string): string => {
    const normalized = rawTitle.normalize('NFC')
    const examMatch = normalized.match(/(\d{4})\D*([123])\D*회/)
    if (examMatch) {
      return `${examMatch[1]}년 ${examMatch[2]}회`
    }
    return '기출 문제집'
  }

  const resolveSubjectId = (questionNumber: number): SubjectId => {
    const idx = Math.floor((Math.max(1, questionNumber) - 1) / 20) + 1
    if (idx <= 1) return 1
    if (idx === 2) return 2
    if (idx === 3) return 3
    if (idx === 4) return 4
    return 5
  }

  useEffect(() => {
    if (!hasBundles && (screen === 'setup' || screen === 'quiz')) setScreen('home')
  }, [hasBundles, screen])

  useEffect(() => {
    setIsExplanationOpen(false)
  }, [currentQuestion?.id])

  const uploadPdf = async (file: File): Promise<void> => {
    try {
      setIsParsing(true)
      setUploadDebugInfo(null)
      let parsed = await parseQuestionsFromPdfFile(file, file.name)
      if (!parsed.length) {
        const fallbackText = await extractTextFromPdf(file)
        parsed = parseQuestionsFromPdfText(fallbackText, file.name)
      }
      if (!parsed.length) throw new Error('문제 파싱 실패')
      const bundleId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const nextFigureByQuestionId: Record<string, string> = {}
      const bundledQuestions = parsed.map((question) => {
        const id = `${bundleId}-${question.number}`
        if (question.figureImage) nextFigureByQuestionId[id] = question.figureImage
        return {
          ...question,
          id,
          // Keep image in memory only to avoid localStorage quota issues.
          figureImage: undefined,
        }
      })
      const bundle: QuestionBundle = {
        id: bundleId,
        title: file.name,
        createdAt: new Date().toISOString(),
        questions: bundledQuestions,
      }
      setBundles(upsertQuestionBundle(bundle))
      setFigureByQuestionId((prev) => ({ ...prev, ...nextFigureByQuestionId }))
      setSelectedBundleId(bundle.id)
      setOrder(null)
      setScreen('home')
    } catch (error) {
      const code: PdfErrorCode =
        error instanceof PdfParseError ? error.code : 'PARSE_FAILED'
      const safeMessageMap: Record<PdfErrorCode, string> = {
        INVALID_TYPE: 'PDF 파일만 업로드할 수 있어요.',
        TOO_LARGE: '파일이 너무 커요. 최대 20MB 파일을 업로드해 주세요.',
        INVALID_PDF: '유효한 PDF 파일이 아니에요.',
        MALFORMED_PDF: '파일을 읽을 수 없어요. 다른 PDF로 다시 시도해 주세요.',
        PARSE_FAILED: '문제를 추출하지 못했어요. 다른 PDF로 다시 시도해 주세요.',
      }
      const alertMessage =
        code === 'PARSE_FAILED' &&
        error instanceof Error &&
        error.message &&
        error.message !== code
          ? error.message
          : safeMessageMap[code]
      setUploadDebugInfo({
        time: new Date().toISOString(),
        code,
        message: alertMessage,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'unknown',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      })
      window.alert(alertMessage)
    } finally {
      setIsParsing(false)
    }
  }

  const startQuiz = (): void => {
    if (!selectedBundle) {
      return
    }
    if (!questions.length) return

    if (!order) {
      return
    }
    const sourceQuestions = questions

    if (!sourceQuestions.length) {
      return
    }

    const config: SessionConfig = { order, chunkSize: 'all' }
    const prepared = createSession(sourceQuestions, config)
    setSession(prepared)
    setSessionBundleId(selectedBundle.id)
    setSessionQuestions(sourceQuestions)
    setDraftAnswers({})
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
    setQuizStartedAt(Date.now())
    setQuizResult(null)
    setScreen('quiz')
  }

  const checkCurrentAnswer = (): void => {
    if (!currentQuestion) return
    const selected = draftAnswers[currentQuestion.id]
    if (selected === undefined) {
      return
    }
    setIsAnswerChecked(true)
    setIsCurrentAnswerCorrect(
      currentQuestion.answer === undefined ? null : selected === currentQuestion.answer,
    )
  }

  const moveToNextQuestion = (): void => {
    if (!session || !currentQuestion) return
    const selected = draftAnswers[currentQuestion.id]

    const updatedAnswers =
      selected === undefined
        ? session.answers
        : { ...session.answers, [currentQuestion.id]: selected }
    const updatedSession: SessionState = {
      ...session,
      answers: updatedAnswers,
    }

    const nextIndex = updatedSession.currentIndex + 1
    if (nextIndex >= updatedSession.questionIds.length) {
      const answeredAt = new Date().toISOString()
      const attemptItems = Object.entries(updatedSession.answers).map(([questionId, answer]) => {
        const question = questionById.get(questionId)
        return {
          bundleId: sessionBundleId,
          questionId,
          selected: answer,
          correct: question?.answer !== undefined && question.answer === answer,
          answeredAt,
        }
      })
      if (attemptItems.length) {
        const nextAttempts = appendQuizAttempts(attemptItems)
        setQuizAttempts(nextAttempts)
      }
      const wrongItems = collectWrongAnswers(updatedSession, sessionQuestions, sessionBundleId)
      appendWrongAnswers(wrongItems)
      const reconciled = reconcileWrongAnswers(sessionBundleId, updatedSession.questionIds, wrongItems)
      setWrongAnswers(reconciled)
      const gradedEntries = Object.entries(updatedSession.answers).filter(([questionId]) => {
        const question = questionById.get(questionId)
        return question?.answer !== undefined
      })
      const correct = gradedEntries.filter(([questionId, selected]) => {
        const question = questionById.get(questionId)
        return question?.answer === selected
      }).length
      const wrong = gradedEntries.length - correct
      const scoreBase = gradedEntries.length === 0 ? updatedSession.questionIds.length : gradedEntries.length
      const score = scoreBase > 0 ? Math.round((correct / scoreBase) * 100) : 0
      const elapsedSeconds = Math.max(
        1,
        Math.round(((Date.now() - (quizStartedAt ?? Date.now())) / 1000)),
      )
      setQuizResult({ correct, wrong, score, elapsedSeconds })
      setSession(null)
      setDraftAnswers({})
      setIsAnswerChecked(false)
      setIsCurrentAnswerCorrect(null)
      setSessionQuestions([])
      setScreen('result')
      return
    }

    setSession({ ...updatedSession, currentIndex: nextIndex })
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
  }

  const moveToPrevQuestion = (): void => {
    if (!session) return
    const prevIndex = session.currentIndex - 1
    if (prevIndex < 0) return
    setSession({ ...session, currentIndex: prevIndex })
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
  }

  const clearAppCache = async (): Promise<void> => {
    const ok = window.confirm(
      '경고: 캐시 삭제를 진행하면 업로드한 문제집, 오답노트, 책갈피, 설정 데이터가 모두 삭제됩니다.\n\n정말 삭제할까요?',
    )
    if (!ok) return

    window.localStorage.clear()
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }

    setBundles([])
    setSelectedBundleId('')
    setWrongAnswers([])
    setQuizAttempts([])
    setBookmarks([])
    setSession(null)
    setSessionBundleId('')
    setSessionQuestions([])
    setDraftAnswers({})
    setFigureByQuestionId({})
    setOrder(null)
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
    setQuizStartedAt(null)
    setQuizResult(null)
    setScreen('home')
    setSettingsNotice('캐시 및 로컬 데이터가 모두 삭제되었습니다.')
    window.alert('캐시 및 로컬 데이터가 모두 삭제되었습니다.')
  }

  const startReviewQuiz = (mode: 'wrong' | 'bookmark' | 'mixed'): void => {
    if (!selectedBundle || !questions.length) {
      setScreen('library')
      return
    }
    const sourceQuestions = questions.filter((question) => {
      if (mode === 'wrong') return wrongQuestionIds.has(question.id)
      if (mode === 'bookmark') return bookmarkIds.has(question.id)
      return wrongQuestionIds.has(question.id) || bookmarkIds.has(question.id)
    })
    if (!sourceQuestions.length) return

    const prepared = createSession(sourceQuestions, { order: 'sequential', chunkSize: 1 })
    setSession(prepared)
    setSessionBundleId(selectedBundle.id)
    setSessionQuestions(sourceQuestions)
    setDraftAnswers({})
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
    setQuizStartedAt(Date.now())
    setQuizResult(null)
    setScreen('quiz')
  }

  const deleteBundleById = (bundleId: string): void => {
    const target = bundles.find((bundle) => bundle.id === bundleId)
    if (!target) return
    const ok = window.confirm(
      `"${target.title}" 문제집을 삭제할까요?\n삭제 후에는 복구할 수 없고, 관련 오답 기록도 함께 삭제됩니다.`,
    )
    if (!ok) return

    const nextBundles = deleteQuestionBundle(bundleId)
    const nextWrongAnswers = removeWrongAnswersByBundleId(bundleId)
    const nextAttempts = removeQuizAttemptsByBundleId(bundleId)
    const nextBookmarks = removeBookmarksByBundleId(bundleId)
    setBundles(nextBundles)
    setWrongAnswers(nextWrongAnswers)
    setQuizAttempts(nextAttempts)
    setBookmarks(nextBookmarks)
    setFigureByQuestionId((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([questionId]) => !questionId.startsWith(`${bundleId}-`)),
      ),
    )
    setSelectedBundleId(nextBundles[0]?.id ?? '')

    if (sessionBundleId === bundleId) {
      setSession(null)
      setSessionBundleId('')
      setSessionQuestions([])
      setDraftAnswers({})
      setIsAnswerChecked(false)
      setIsCurrentAnswerCorrect(null)
      setScreen('library')
    } else if (!nextBundles.length) {
      setScreen('library')
    }
  }

  const toggleCurrentBookmark = (): void => {
    if (!currentQuestion || !sessionBundleId) return
    const next = toggleBookmark(sessionBundleId, currentQuestion.id)
    setBookmarks(next)
  }

  const retryCurrentQuestion = (): void => {
    if (!currentQuestion) return
    setDraftAnswers((prev) => {
      const next = { ...prev }
      delete next[currentQuestion.id]
      return next
    })
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
  }

  const topScreenTitle = useMemo(() => {
    if (screen === 'home') return '홈'
    if (screen === 'library') return '내 책장'
    if (screen === 'setup') return '출제 설정'
    if (screen === 'review') return '복습'
    if (screen === 'analytics') return '학습 통계'
    if (screen === 'mypage') return '마이페이지'
    if (screen === 'result') return '풀이 결과'
    return ''
  }, [screen])

  const analyticsCutoff = useMemo(() => {
    if (analyticsRange === 'all') return 0
    const now = Date.now()
    if (analyticsRange === '7d') return now - 7 * 24 * 60 * 60 * 1000
    return now - 30 * 24 * 60 * 60 * 1000
  }, [analyticsRange])

  const analyticsAttempts = useMemo(
    () =>
      quizAttempts.filter((item) => {
        if (analyticsCutoff === 0) return true
        return new Date(item.answeredAt).getTime() >= analyticsCutoff
      }),
    [quizAttempts, analyticsCutoff],
  )

  const analyticsSubjectScores = useMemo(() => {
    const questionMap = new Map(
      bundles.flatMap((bundle) => bundle.questions.map((question) => [question.id, question] as const)),
    )
    const wrongBySubject: Record<SubjectId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    const attemptBySubject: Record<SubjectId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    const totalBySubject: Record<SubjectId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }

    for (const bundle of bundles) {
      for (const question of bundle.questions) {
        const subjectId = resolveSubjectId(question.number)
        totalBySubject[subjectId] += 1
      }
    }

    for (const attempt of analyticsAttempts) {
      const question = questionMap.get(attempt.questionId)
      if (!question) continue
      const subjectId = resolveSubjectId(question.number)
      attemptBySubject[subjectId] += 1
      if (!attempt.correct) wrongBySubject[subjectId] += 1
    }

    return ([1, 2, 3, 4, 5] as SubjectId[]).map((subjectId) => {
      const wrongCount = wrongBySubject[subjectId]
      const attemptCount = attemptBySubject[subjectId]
      const totalCount = totalBySubject[subjectId]
      const estimatedScore =
        attemptCount > 0
          ? Math.max(0, Math.round(((attemptCount - wrongCount) / attemptCount) * 100))
          : 0
      return {
        subjectId,
        label: SUBJECT_LABELS[subjectId],
        wrongCount,
        attemptCount,
        totalCount,
        estimatedScore,
      }
    })
  }, [bundles, analyticsAttempts])

  const displayedAnalyticsSubjectScores = useMemo(() => {
    if (analyticsMode === 'live') return analyticsSubjectScores
    return [
      { subjectId: 1, label: SUBJECT_LABELS[1], wrongCount: 13, attemptCount: 20, totalCount: 20, estimatedScore: 35 },
      { subjectId: 2, label: SUBJECT_LABELS[2], wrongCount: 2, attemptCount: 20, totalCount: 20, estimatedScore: 90 },
      { subjectId: 3, label: SUBJECT_LABELS[3], wrongCount: 10, attemptCount: 20, totalCount: 20, estimatedScore: 50 },
      { subjectId: 4, label: SUBJECT_LABELS[4], wrongCount: 6, attemptCount: 20, totalCount: 20, estimatedScore: 70 },
      { subjectId: 5, label: SUBJECT_LABELS[5], wrongCount: 12, attemptCount: 20, totalCount: 20, estimatedScore: 40 },
    ]
  }, [analyticsMode, analyticsSubjectScores])

  const analyticsAverageScore = displayedAnalyticsSubjectScores.length
    ? Math.round(
        displayedAnalyticsSubjectScores.reduce((sum, metric) => sum + metric.estimatedScore, 0) /
          displayedAnalyticsSubjectScores.length,
      )
    : 0
  const analyticsFailSubjects = displayedAnalyticsSubjectScores.filter((metric) => metric.estimatedScore < 40)
  const analyticsPassProbability = calculatePassProbability(
    displayedAnalyticsSubjectScores.map((metric) => metric.estimatedScore),
  )
  const weakestAnalyticsSubject = displayedAnalyticsSubjectScores.reduce(
    (prev, curr) => (curr.estimatedScore < prev.estimatedScore ? curr : prev),
    displayedAnalyticsSubjectScores[0],
  )

  const radar = useMemo(() => {
    const cx = 140
    const cy = 140
    const radius = 88
    const levels = [20, 40, 60, 80, 100]
    const count = displayedAnalyticsSubjectScores.length
    const angleAt = (index: number) => (-Math.PI / 2) + (index * 2 * Math.PI) / count
    const point = (score: number, index: number) => {
      const ratio = score / 100
      const angle = angleAt(index)
      return {
        x: cx + Math.cos(angle) * radius * ratio,
        y: cy + Math.sin(angle) * radius * ratio,
      }
    }
    const axisEnds = displayedAnalyticsSubjectScores.map((_, idx) => point(100, idx))
    const polygonPoints = displayedAnalyticsSubjectScores
      .map((metric, idx) => point(metric.estimatedScore, idx))
      .map((p) => `${p.x},${p.y}`)
      .join(' ')
    const valuePoints = displayedAnalyticsSubjectScores.map((metric, idx) =>
      point(metric.estimatedScore, idx),
    )
    const gridPolygons = levels.map((level) =>
      displayedAnalyticsSubjectScores
        .map((_, idx) => point(level, idx))
        .map((p) => `${p.x},${p.y}`)
        .join(' '),
    )
    const labels = displayedAnalyticsSubjectScores.map((metric, idx) => {
      const p = point(112, idx)
      return { ...p, text: metric.label.replace(/^\d과목\s*/, ''), score: metric.estimatedScore }
    })
    return { cx, cy, axisEnds, polygonPoints, valuePoints, gridPolygons, labels }
  }, [displayedAnalyticsSubjectScores])

  return (
    <main className={`app ${screen === 'quiz' ? 'appQuiz' : ''}`}>
      {screen !== 'quiz' && (
        <header className="topScreenBar" aria-label="현재 화면">
          <h1>{topScreenTitle}</h1>
        </header>
      )}

      {screen === 'home' && (
      <section className="card homeUploadCard">
        <label className="uploadField dashedDropzone" htmlFor="pdf-file-input">
          <div className="dropzoneContent">
            <div className="dropzoneIcon" aria-hidden="true">
              {selectedFileName ? (
                <svg viewBox="0 0 24 24">
                  <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
                  <path d="M14 2v5h5" />
                  <path d="M9 13h6M9 17h6" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5-5 5 5" />
                  <path d="M12 5v12" />
                </svg>
              )}
            </div>
            <p className="dropzoneTitle">{selectedFileName ? '파일 선택 완료' : 'PDF 업로드'}</p>
            <p className="dropzoneHint">
              {selectedFileName ||
                (isTouchDevice
                  ? '탭하여 PDF 파일을 선택하세요 (최대 20MB)'
                  : '파일을 여기에 끌어다 놓거나 선택하세요 (최대 20MB)')}
            </p>
            {selectedFileSize && <p className="dropzoneMeta">파일 크기: {selectedFileSize}</p>}
          </div>
          <input
            id="pdf-file-input"
            className="fileInputHidden"
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0]
              setSelectedFileName(file?.name ?? '')
              setSelectedFileSize(file ? `${(file.size / 1024 / 1024).toFixed(2)}MB` : '')
              if (file) void uploadPdf(file)
            }}
          />
        </label>
        {isParsing && (
          <div className="progressWrap" role="status" aria-live="polite">
            <p className="progressLabel">PDF 분석 중...</p>
            <div className="progressTrack">
              <div className="progressBarIndeterminate" />
            </div>
          </div>
        )}
        {uploadDebugInfo && (
          <details className="uploadDebugPanel">
            <summary>업로드 실패 진단 정보</summary>
            <pre>{JSON.stringify(uploadDebugInfo, null, 2)}</pre>
          </details>
        )}
      </section>
      )}

      {screen === 'home' && (
      <section className="card recentHomeCard">
        <h2>최근 학습자료</h2>
        {hasBundles ? (
          <div className="recentList">
            {bundles.slice(0, 3).map((bundle) => (
              <div key={bundle.id} className="recentItemWrap">
                <button
                  type="button"
                  className="recentItem"
                  onClick={() => {
                    setSelectedBundleId(bundle.id)
                    setScreen('setup')
                  }}
                >
                  <div className="recentCover">
                    <p className="recentCoverBadge">{(bundle.title.normalize('NFC').match(/(\d{2,4})년?\s*([123])회/)?.[0] ?? '기출')}</p>
                    <p className="recentCoverTitle">{formatExamRound(bundle.title)}</p>
                    <p className="recentCoverSub">정보처리기사 필기 기출문제</p>
                    <div className="recentMetaRow">
                      <p className="recentMeta">{bundle.questions.length}문제</p>
                      <p className="recentMeta muted">
                        {new Date(bundle.createdAt).toLocaleDateString('ko-KR', {
                          month: 'numeric',
                          day: 'numeric',
                        })}{' '}
                        추가
                      </p>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="recentItemDelete"
                  aria-label={`${bundle.title} 삭제`}
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteBundleById(bundle.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="emptyNotice">아직 학습자료가 없습니다. 위에서 PDF를 업로드해 주세요.</p>
        )}
      </section>
      )}

      {screen === 'library' && (
      <section className="card">
        {hasBundles ? (
          <>
            <div className="librarySectionHeader">
              <span className="libraryTotalText">총 {bundles.length}권</span>
              <label className="libraryFilterField">
                <span className="libraryFilterIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 7h16" />
                    <path d="M7 12h10" />
                    <path d="M10 17h4" />
                  </svg>
                </span>
                <span>필터</span>
                <select
                  aria-label="정렬 필터"
                  value={librarySort}
                  onChange={(event) =>
                    setLibrarySort(event.target.value as 'recent' | 'oldest' | 'name' | 'count')
                  }
                >
                  <option value="recent">최근 추가순</option>
                  <option value="oldest">과거 추가순</option>
                  <option value="name">이름순</option>
                  <option value="count">문제 수순</option>
                </select>
              </label>
            </div>
            <div className="chipRow libraryChipRowTop">
              <span className="chip">문제집 {bundles.length}개</span>
              <span className="chip">선택 문제 {questions.length}개</span>
            </div>
            <div className="libraryShelf bookshelf">
              {sortedBundles.map((bundle) => (
                <div key={bundle.id} className="libraryBookItem">
                  <button
                    type="button"
                    className={`libraryBook ${selectedBundle?.id === bundle.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedBundleId(bundle.id)
                      setScreen('setup')
                    }}
                  >
                    <div className="recentCover libraryBookCoverUnified">
                      <p className="recentCoverBadge">
                        {(bundle.title.normalize('NFC').match(/(\d{2,4})년?\s*([123])회/)?.[0] ?? '기출')}
                      </p>
                      <p className="recentCoverTitle">{formatExamRound(bundle.title)}</p>
                      <p className="recentCoverSub">정보처리기사 필기 기출문제</p>
                      <div className="recentMetaRow">
                        <p className="recentMeta">{bundle.questions.length}문제</p>
                        <p className="recentMeta muted">
                          {new Date(bundle.createdAt).toLocaleDateString('ko-KR', {
                            month: 'numeric',
                            day: 'numeric',
                          })}{' '}
                          추가
                        </p>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="libraryBookDelete"
                    aria-label={`${bundle.title} 삭제`}
                    onClick={() => deleteBundleById(bundle.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="emptyNotice">아직 업로드된 문제집이 없습니다. PDF를 먼저 올려주세요.</p>
        )}
      </section>
      )}

      {hasBundles && screen === 'setup' && (
        <section className="card setupCard">
          <div className="setupHeaderRow">
            <button
              type="button"
              className="setupBackButton"
              aria-label="내 책장으로 돌아가기"
              onClick={() => setScreen('library')}
            >
              &lt;
            </button>
          </div>
          {session && (
            <button
              type="button"
              className="resumeQuizButton"
              onClick={() => setScreen('quiz')}
            >
              이어서 풀기 ({Math.min(session.currentIndex + 1, session.questionIds.length)} / {session.questionIds.length})
            </button>
          )}
          <div className="setupHero">
            <p className="setupHeroLabel">선택한 문제집</p>
            <strong>{selectedBundle ? formatExamRound(selectedBundle.title) : '문제집 없음'}</strong>
            <p className="setupHeroExam">정보처리기사 필기 기출문제</p>
            <span>총 {questions.length}문항</span>
          </div>
          <div className="options">
            <fieldset className="optionGroup optionGridTwo">
              <legend className="fieldTitle">출제 순서</legend>
              <label className="optionCard optionCardLibrary">
                <input type="radio" name="order" checked={order === 'sequential'} onChange={() => setOrder('sequential')} />
                <span className="optionTextGroup">
                  <span className="optionTitle">순차</span>
                  <span className="optionMeta">문제 번호대로 진행합니다.</span>
                </span>
              </label>
              <label className="optionCard optionCardLibrary">
                <input type="radio" name="order" checked={order === 'random'} onChange={() => setOrder('random')} />
                <span className="optionTextGroup">
                  <span className="optionTitle">랜덤</span>
                  <span className="optionMeta">섞어서 실전처럼 풉니다.</span>
                </span>
              </label>
            </fieldset>

            <button className="startButton" onClick={startQuiz} disabled={!canStartQuiz}>
              시작하기
            </button>
          </div>
        </section>
      )}

      {hasBundles && session && screen === 'quiz' && (
        <section className="card quizCard">
          <div className="quizProgressHeader">
            <div className="quizTopRow">
              <div className="quizTopLeft">
                <button
                  type="button"
                  className="quizExitButton"
                  aria-label="문제 풀이 나가기"
                  onClick={() => {
                    setIsExplanationOpen(false)
                    setScreen('setup')
                  }}
                >
                  ×
                </button>
                <p className="quizQuestionMeta">
                  {currentQuestion ? `${currentQuestion.number}번 문제` : '문제 준비 중'}
                </p>
              </div>
              <div className="quizTopActions">
                <button
                  type="button"
                  className={`iconActionButton ${currentQuestion && bookmarkIds.has(currentQuestion.id) ? 'active' : ''}`}
                  onClick={toggleCurrentBookmark}
                  aria-label={currentQuestion && bookmarkIds.has(currentQuestion.id) ? '책갈피 해제' : '책갈피'}
                  title={currentQuestion && bookmarkIds.has(currentQuestion.id) ? '책갈피 해제' : '책갈피'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3-6 3V5a1 1 0 0 1 1-1z" />
                  </svg>
                </button>
                <button type="button" className="explanationToggle" onClick={() => setIsExplanationOpen(true)}>
                  해설
                </button>
                <span className="quizTimerChip" aria-live="polite">
                  {formatElapsed(elapsedSecondsLive)}
                </span>
                <button
                  type="button"
                  className={`checkInlineButton ${isAnswerChecked ? 'checked' : ''}`}
                  disabled={isAnswerChecked || !currentQuestion || draftAnswers[currentQuestion.id] === undefined}
                  onClick={checkCurrentAnswer}
                  aria-label={
                    isAnswerChecked
                      ? currentQuestion?.answer === undefined
                        ? '정답 정보 없음'
                        : `정답 ${currentQuestion.answer + 1}번`
                      : '정답 확인'
                  }
                >
                  {isAnswerChecked
                    ? currentQuestion?.answer === undefined
                      ? '-'
                      : `${currentQuestion.answer + 1}`
                    : '정답 확인'}
                </button>
              </div>
            </div>
            <div className="progressMeta">
              <span className="progressMetaText">진행도 {currentStep} / {totalQuestionsInSession}</span>
              <span className="progressMetaPercent">{progressPercent}%</span>
            </div>
            <div className="quizProgressTrack">
              <div className="quizProgressFill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
          {currentQuestion && (
            <article key={currentQuestion.id} className="question">
              {currentQuestion.figureImage && (
                <div className="questionFigureWrap">
                  <img
                    className="questionFigure"
                    src={currentQuestion.figureImage}
                    alt={`${currentQuestion.number}번 문항 참고 이미지`}
                    loading="lazy"
                  />
                </div>
              )}
              {!currentQuestion.figureImage && figureByQuestionId[currentQuestion.id] && (
                <div className="questionFigureWrap">
                  <img
                    className="questionFigure"
                    src={figureByQuestionId[currentQuestion.id]}
                    alt={`${currentQuestion.number}번 문항 참고 이미지`}
                    loading="lazy"
                  />
                </div>
              )}
              <h3>
                {currentQuestion.number}. {currentQuestion.stem}
              </h3>
              <div className="choices">
                {currentQuestion.choices.map((choice, idx) => (
                  <label key={`${currentQuestion.id}-${idx}`} className="optionCard">
                    <input
                      type="radio"
                      name={currentQuestion.id}
                      checked={draftAnswers[currentQuestion.id] === idx}
                      disabled={isAnswerChecked}
                      onChange={() => setDraftAnswers((prev) => ({ ...prev, [currentQuestion.id]: idx }))}
                    />
                    <span className="choiceText">{idx + 1}. {choice}</span>
                  </label>
                ))}
              </div>
            </article>
          )}
          <div className="quizActionBar">
            <div className="choiceQuickRow">
              <button
                type="button"
                className="quickArrowButton"
                aria-label="이전 문제"
                onClick={moveToPrevQuestion}
                disabled={!session || session.currentIndex === 0}
              >
                ←
              </button>
              {[0, 1, 2, 3].map((idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`choiceQuickButton ${currentQuestion && draftAnswers[currentQuestion.id] === idx ? 'active' : ''}`}
                  disabled={isAnswerChecked || !currentQuestion}
                  onClick={() => {
                    if (!currentQuestion) return
                    setDraftAnswers((prev) => ({ ...prev, [currentQuestion.id]: idx }))
                  }}
                >
                  {idx + 1}
                </button>
              ))}
              <button
                type="button"
                className="quickArrowButton"
                aria-label="다음 문제"
                onClick={moveToNextQuestion}
                disabled={!currentQuestion}
              >
                →
              </button>
            </div>
            {isAnswerChecked && isCurrentAnswerCorrect === false && (
              <div className="quizResultActions">
                <button type="button" className="ghostButton" onClick={retryCurrentQuestion}>다시 풀기</button>
              </div>
            )}
            {isAnswerChecked && (
              <div className="quizActionHint" aria-live="polite">
                다음 화살표를 눌러 다음 문제로 이동할 수 있습니다.
              </div>
            )}
          </div>
        </section>
      )}

      {screen === 'result' && quizResult && (
        <section className="card">
          <p className="cardDescription">한 세트 풀이를 완료했어요. 결과를 확인해보세요.</p>
          <div className="resultSummaryGrid">
            <div className="resultSummaryCard">
              <span>정답</span>
              <strong>{quizResult.correct}문제</strong>
            </div>
            <div className="resultSummaryCard">
              <span>오답</span>
              <strong>{quizResult.wrong}문제</strong>
            </div>
            <div className="resultSummaryCard">
              <span>점수</span>
              <strong>{quizResult.score}점</strong>
            </div>
            <div className="resultSummaryCard">
              <span>소요시간</span>
              <strong>{quizResult.elapsedSeconds}초</strong>
            </div>
          </div>
          <button
            type="button"
            className="nextButton"
            onClick={() => {
              setQuizStartedAt(null)
              setScreen('setup')
            }}
          >
            다시 설정하기
          </button>
        </section>
      )}

      {isExplanationOpen && currentQuestion && (
        <div className="explanationOverlay" role="dialog" aria-modal="true" aria-label="문제 해설">
          <section className="explanationSheet">
            <div className="explanationSheetHeader">
              <h3>{currentQuestion.number}번 문제 해설</h3>
              <button type="button" className="explanationClose" onClick={() => setIsExplanationOpen(false)}>
                ×
              </button>
            </div>
            <div className="explanationSheetBody">
              {currentQuestion.answer === undefined ? (
                <p className="explanationEmpty">이 문항은 정답 데이터가 없어 상세 해설을 제공할 수 없습니다.</p>
              ) : (
                <>
                  <p className="explanationAnswer">
                    정답 <strong>{currentQuestion.answer + 1}번</strong>
                  </p>
                  <p className="explanationAnswerText">{currentQuestion.choices[currentQuestion.answer]}</p>
                  <p className="explanationHint">
                    오답 선택지를 비교해 핵심 키워드를 정리하면 복습 효율이 높아집니다.
                  </p>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {screen === 'review' && (
        <section className="card">
          <div className="reviewSummaryGrid">
            <button
              type="button"
              className="reviewSummaryCard"
              onClick={() => startReviewQuiz('wrong')}
              disabled={wrongQuestionCount === 0}
            >
              <span className="reviewSummaryLabel">오답</span>
              <strong>{wrongQuestionCount}문제</strong>
            </button>
            <button
              type="button"
              className="reviewSummaryCard"
              onClick={() => startReviewQuiz('bookmark')}
              disabled={bookmarkQuestionCount === 0}
            >
              <span className="reviewSummaryLabel">책갈피</span>
              <strong>{bookmarkQuestionCount}문제</strong>
            </button>
            <button
              type="button"
              className="reviewSummaryCard total"
              onClick={() => startReviewQuiz('mixed')}
              disabled={reviewQuestionCount === 0}
            >
              <span className="reviewSummaryLabel">복습 가능 문항</span>
              <strong>{reviewQuestionCount}문제</strong>
            </button>
          </div>
          {reviewQuestionCount === 0 && (
            <p className="reviewEmptyHint">복습할 문항이 없어요. 문제를 풀면서 오답이나 책갈피를 쌓아보세요.</p>
          )}
        </section>
      )}

      {screen === 'analytics' && (
        <section className="card analyticsCard">
          <div className="analyticsFilterRow">
            <button
              type="button"
              className={`analyticsFilterButton ${analyticsRange === '7d' ? 'active' : ''}`}
              onClick={() => setAnalyticsRange('7d')}
            >
              최근 1주
            </button>
            <button
              type="button"
              className={`analyticsFilterButton ${analyticsRange === '30d' ? 'active' : ''}`}
              onClick={() => setAnalyticsRange('30d')}
            >
              최근 1개월
            </button>
            <button
              type="button"
              className={`analyticsFilterButton ${analyticsRange === 'all' ? 'active' : ''}`}
              onClick={() => setAnalyticsRange('all')}
            >
              전체
            </button>
          </div>
          <div className="analyticsModeRow">
            <button
              type="button"
              className={`analyticsModeButton ${analyticsMode === 'live' ? 'active' : ''}`}
              onClick={() => setAnalyticsMode('live')}
            >
              실데이터
            </button>
            <button
              type="button"
              className={`analyticsModeButton ${analyticsMode === 'stress' ? 'active' : ''}`}
              onClick={() => setAnalyticsMode('stress')}
            >
              테스트 데이터
            </button>
          </div>

          <div className="analyticsHeroCard light">
            <div className="analyticsTopSummary">
              <div className="analyticsHeroStats">
                <div>
                  <span>평균 점수</span>
                  <strong>{analyticsAverageScore}점</strong>
                </div>
                <div>
                  <span>취약 과목</span>
                  <strong className="weakSubjectValue">{weakestAnalyticsSubject?.label ?? '-'}</strong>
                </div>
              </div>
              <div className="analyticsDonutWrap compact">
                <div
                  className="analyticsDonut"
                  style={{
                    background: `conic-gradient(#4f9dff ${analyticsPassProbability * 3.6}deg, #d9e4f4 0deg)`,
                  }}
                >
                  <div className="analyticsDonutInner">
                    <strong>{analyticsPassProbability}%</strong>
                    <span>합격 확률</span>
                  </div>
                </div>
              </div>
            </div>
            <p className={`analyticsWarning ${weakestAnalyticsSubject && weakestAnalyticsSubject.estimatedScore < 60 ? 'danger' : 'safe'}`}>
              {analyticsFailSubjects.length > 0
                ? `⚠️ 과락 위험! 40점 미만 과목이 ${analyticsFailSubjects.length}개 있습니다. 집중 학습이 필요합니다.`
                : analyticsAverageScore < 60
                  ? `💡 전체 평균이 ${analyticsAverageScore}점으로 합격선(60점) 미만입니다. 전 범위 복습이 필요합니다.`
                  : '✅ 현재 과락 위험은 낮습니다. 약한 과목 위주로 유지 학습하세요.'}
            </p>

            <div className="analyticsVisualWrap">
              <div className="analyticsRadarWrap">
                <svg viewBox="0 0 280 280" className="analyticsRadarSvg" role="img" aria-label="과목 밸런스 레이더 차트">
                  {radar.gridPolygons.map((points, idx) => (
                    <polygon key={`grid-${idx}`} points={points} className="analyticsRadarGrid" />
                  ))}
                  {radar.axisEnds.map((p, idx) => (
                    <line key={`axis-${idx}`} x1={radar.cx} y1={radar.cy} x2={p.x} y2={p.y} className="analyticsRadarAxis" />
                  ))}
                  <polygon points={radar.polygonPoints} className="analyticsRadarValue" />
                  {radar.valuePoints.map((p, idx) => (
                    <circle key={`point-${idx}`} cx={p.x} cy={p.y} r="3.2" className="analyticsRadarPoint" />
                  ))}
                  {radar.labels.map((label, idx) => (
                    <g key={`label-${idx}`}>
                      <text x={label.x} y={label.y} textAnchor="middle" className="analyticsRadarLabel">
                        {label.text}
                      </text>
                      <text x={label.x} y={label.y + 12} textAnchor="middle" className="analyticsRadarScore">
                        {label.score}%
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>

            <h3 className="analyticsSectionTitle">과목별 상세 분석</h3>
            <div className="analyticsBarList">
              {displayedAnalyticsSubjectScores.map((metric) => (
                <div key={metric.subjectId} className="analyticsBarRow">
                  <div className="analyticsBarLabel">
                    <span>{metric.label}</span>
                    <strong>{metric.estimatedScore}점</strong>
                  </div>
                  <div className="analyticsBarTrack">
                    <div
                      className={`analyticsBarFill ${metric.estimatedScore < 40 ? 'danger' : metric.estimatedScore === 40 ? 'warning' : ''}`}
                      style={{ width: `${metric.estimatedScore}%` }}
                    />
                  </div>
                  <p className="analyticsBarMeta">
                    맞힌 문제 {Math.max(metric.attemptCount - metric.wrongCount, 0)} / {metric.attemptCount}
                    {' · '}
                    오답 {metric.wrongCount}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {screen === 'mypage' && (
        <section className="card mypageCard">
          <div className="mypageHeaderRow">
            <span className="mypageCoin">QDF 3</span>
          </div>
          {myPageView === 'main' ? (
            <>
              <button type="button" className="mypageUserRow">
                <span className="mypageAvatar" aria-hidden="true" />
                <span className="mypageUserInfo">
                  <strong>QDF 사용자</strong>
                  <small>문제집 {bundles.length}권 · 오답 {wrongAnswers.length}건 · 책갈피 {bookmarks.length}건</small>
                </span>
                <span className="mypageMenuArrow">›</span>
              </button>
              <button type="button" className="mypagePromoCard">
                친구 초대하고 리워드 받기 ›
              </button>
              <div className="mypageListGroup">
                <button type="button" className="mypageListRow" onClick={() => setMyPageView('terms')}>
                  <span>이용약관</span>
                  <span className="mypageMenuArrow">›</span>
                </button>
                <button type="button" className="mypageListRow" onClick={() => setMyPageView('privacy')}>
                  <span>개인정보처리방침</span>
                  <span className="mypageMenuArrow">›</span>
                </button>
                <button type="button" className="mypageListRow" onClick={() => setMyPageView('cache')}>
                  <span>캐시 및 데이터 관리</span>
                  <span className="mypageMenuArrow">›</span>
                </button>
                <button type="button" className="mypageListRow" onClick={() => setMyPageView('oss')}>
                  <span>오픈소스 및 고지</span>
                  <span className="mypageMenuArrow">›</span>
                </button>
                <div className="mypageListRow static">
                  <span>앱 버전</span>
                  <span className="mypageListHint">{APP_VERSION}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="mypageDetail">
              <button type="button" className="ghostButton mypageBackButton" onClick={() => setMyPageView('main')}>
                ← 목록으로
              </button>
              {myPageView === 'terms' && (
                <div className="settingsBody">
                  <h3>이용약관</h3>
                  <p>QDF는 사용자가 업로드한 PDF를 기반으로 학습 문제를 생성하는 개인 학습용 앱입니다.</p>
                  <ul>
                    <li>사용자는 저작권법을 준수하며 합법적인 파일만 업로드해야 합니다.</li>
                    <li>앱은 학습 보조 목적이며 시험 결과를 보장하지 않습니다.</li>
                    <li>서비스 개선을 위해 약관은 업데이트될 수 있습니다.</li>
                  </ul>
                </div>
              )}
              {myPageView === 'privacy' && (
                <div className="settingsBody">
                  <h3>개인정보처리방침</h3>
                  <ul>
                    <li>수집 항목: 업로드한 문제 데이터, 오답 기록, 앱 설정 값</li>
                    <li>저장 위치: 사용자 브라우저 로컬 저장소(서버 전송 없음)</li>
                    <li>보관 기간: 사용자가 삭제하기 전까지</li>
                    <li>문의: support@qdf.app</li>
                  </ul>
                </div>
              )}
              {myPageView === 'cache' && (
                <div className="settingsBody">
                  <h3>캐시 및 데이터 관리</h3>
                  <p>로컬에 저장된 문제집, 오답노트, 캐시를 모두 삭제합니다.</p>
                  <button type="button" className="dangerButton" onClick={() => void clearAppCache()}>
                    캐시 삭제
                  </button>
                </div>
              )}
              {myPageView === 'oss' && (
                <div className="settingsBody">
                  <h3>오픈소스 및 고지</h3>
                  <p>본 앱은 React, Vite, pdf.js 등 오픈소스 소프트웨어를 사용합니다. 라이선스는 각 프로젝트 정책을 따릅니다.</p>
                </div>
              )}
            </div>
          )}
          {settingsNotice && <p className="settingsNotice">{settingsNotice}</p>}
        </section>
      )}

      {screen !== 'quiz' && (
        <nav className="bottomNav" aria-label="하단 메뉴">
          <button type="button" className={`bottomNavItem ${screen === 'home' ? 'active' : ''}`} onClick={() => {
            setScreen('home')
            setMyPageView('main')
          }}>
            <span className="bottomNavIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M3 10.5L12 3l9 7.5" />
                <path d="M6 9.5V20h12V9.5" />
              </svg>
            </span>
            홈
          </button>
          <button type="button" className={`bottomNavItem ${screen === 'library' ? 'active' : ''}`} onClick={() => {
            setScreen('library')
            setMyPageView('main')
          }}>
            <span className="bottomNavIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M4 5.5h7a2 2 0 0 1 2 2V19H6a2 2 0 0 0-2 2z" />
                <path d="M20 5.5h-7a2 2 0 0 0-2 2V19h7a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            내 책장
          </button>
          <button type="button" className={`bottomNavItem ${screen === 'review' ? 'active' : ''}`} onClick={() => {
            setScreen('review')
            setMyPageView('main')
          }}>
            <span className="bottomNavIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                <path d="M20 4v7h-7" />
              </svg>
            </span>
            복습
          </button>
          <button type="button" className={`bottomNavItem ${screen === 'analytics' ? 'active' : ''}`} onClick={() => {
            setScreen('analytics')
            setMyPageView('main')
          }}>
            <span className="bottomNavIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M4 19V5" />
                <path d="M10 19v-8" />
                <path d="M16 19v-5" />
                <path d="M22 19V9" />
              </svg>
            </span>
            통계
          </button>
          <button type="button" className={`bottomNavItem ${screen === 'mypage' ? 'active' : ''}`} onClick={() => {
            setScreen('mypage')
            setMyPageView('main')
          }}>
            <span className="bottomNavIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20a8 8 0 0 1 16 0" />
              </svg>
            </span>
            마이페이지
          </button>
        </nav>
      )}

    </main>
  )
}

export default App

import { useEffect, useMemo, useState } from 'react'
import {
  extractTextFromPdf,
  parseQuestionsFromPdfText,
  PdfParseError,
  type PdfErrorCode,
} from './features/pdf/parser'
import {
  collectWrongAnswers,
  createSession,
} from './features/quiz/engine'
import type { QuestionBundle, SessionConfig, SessionState } from './types'
import {
  appendWrongAnswers,
  deleteQuestionBundle,
  loadQuestionBundles,
  loadWrongAnswers,
  reconcileWrongAnswers,
  removeWrongAnswersByBundleId,
  upsertQuestionBundle,
} from './utils/storage'

type StudyMode = 'normal' | 'wrongOnly'
type ScreenStep = 'library' | 'setup' | 'quiz' | 'settings'
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0'

function App() {
  const [bundles, setBundles] = useState<QuestionBundle[]>(loadQuestionBundles())
  const [selectedBundleId, setSelectedBundleId] = useState<string>('')
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessionBundleId, setSessionBundleId] = useState<string>('')
  const [sessionQuestions, setSessionQuestions] = useState<QuestionBundle['questions']>([])
  const [draftAnswers, setDraftAnswers] = useState<Record<string, number>>({})
  const [wrongAnswers, setWrongAnswers] = useState(loadWrongAnswers())
  const [studyMode, setStudyMode] = useState<StudyMode | null>(null)
  const [chunkSize, setChunkSize] = useState<SessionConfig['chunkSize'] | null>(null)
  const [order, setOrder] = useState<SessionConfig['order'] | null>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const [selectedFileSize, setSelectedFileSize] = useState('')
  const [isParsing, setIsParsing] = useState(false)
  const [isAnswerChecked, setIsAnswerChecked] = useState(false)
  const [isCurrentAnswerCorrect, setIsCurrentAnswerCorrect] = useState<boolean | null>(null)
  const [screen, setScreen] = useState<ScreenStep>('library')
  const [settingsNotice, setSettingsNotice] = useState('')

  const selectedBundle = useMemo(
    () => bundles.find((bundle) => bundle.id === selectedBundleId) ?? bundles[0] ?? null,
    [bundles, selectedBundleId],
  )
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
  const canStartQuiz =
    Boolean(selectedBundle) &&
    questions.length > 0 &&
    Boolean(studyMode) &&
    Boolean(chunkSize) &&
    Boolean(order) &&
    (studyMode === 'normal' || wrongQuestionCount > 0)
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
  const finalizedStats = useMemo(() => {
    if (!session) return { correct: 0, wrong: 0 }
    let correct = 0
    let wrong = 0
    for (const [questionId, selected] of Object.entries(session.answers)) {
      const question = questionById.get(questionId)
      if (!question || question.answer === undefined) continue
      if (question.answer === selected) correct += 1
      else wrong += 1
    }
    return { correct, wrong }
  }, [session, questionById])
  const previewStats = {
    correct: finalizedStats.correct + (isAnswerChecked && isCurrentAnswerCorrect === true ? 1 : 0),
    wrong: finalizedStats.wrong + (isAnswerChecked && isCurrentAnswerCorrect === false ? 1 : 0),
  }
  const setupStage =
    studyMode === null ? 'study' : chunkSize === null ? 'count' : order === null ? 'order' : 'ready'
  const setupStepIndex = setupStage === 'study' ? 1 : setupStage === 'count' ? 2 : setupStage === 'order' ? 3 : 4
  const setupSummary = [
    studyMode === 'wrongOnly' ? '오답풀기' : studyMode === 'normal' ? '문제 풀기' : '',
    chunkSize ? `${chunkSize}문제` : '',
    order === 'random' ? '랜덤' : order === 'sequential' ? '순차' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const isTouchDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return true
    return navigator.maxTouchPoints > 0
  }, [])

  useEffect(() => {
    if (!hasBundles && screen !== 'library') setScreen('library')
  }, [hasBundles, screen])

  const uploadPdf = async (file: File): Promise<void> => {
    try {
      setIsParsing(true)
      const text = await extractTextFromPdf(file)
      const parsed = parseQuestionsFromPdfText(text, file.name)
      if (!parsed.length) throw new Error('문제 파싱 실패')
      const bundleId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const bundledQuestions = parsed.map((question) => ({
        ...question,
        id: `${bundleId}-${question.number}`,
      }))
      const bundle: QuestionBundle = {
        id: bundleId,
        title: file.name,
        createdAt: new Date().toISOString(),
        questions: bundledQuestions,
      }
      setBundles(upsertQuestionBundle(bundle))
      setSelectedBundleId(bundle.id)
      setStudyMode(null)
      setChunkSize(null)
      setOrder(null)
      // no-op: keep header minimal without status text
      setScreen('library')
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
      void safeMessageMap[code]
    } finally {
      setIsParsing(false)
    }
  }

  const startQuiz = (): void => {
    if (!selectedBundle) {
      return
    }
    if (!questions.length) return

    if (!studyMode || !chunkSize || !order) {
      return
    }

    const sourceQuestions =
      studyMode === 'wrongOnly'
        ? questions.filter((question) => wrongQuestionIds.has(question.id))
        : questions

    if (!sourceQuestions.length) {
      return
    }

    const config: SessionConfig = { order, chunkSize }
    const prepared = createSession(sourceQuestions, config)
    setSession(prepared)
    setSessionBundleId(selectedBundle.id)
    setSessionQuestions(sourceQuestions)
    setDraftAnswers({})
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
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
    if (!session || !currentQuestion || !isAnswerChecked) return
    const selected = draftAnswers[currentQuestion.id]
    if (selected === undefined) return

    const updatedSession: SessionState = {
      ...session,
      answers: { ...session.answers, [currentQuestion.id]: selected },
    }

    const nextIndex = updatedSession.currentIndex + 1
    if (nextIndex >= updatedSession.questionIds.length) {
      const wrongItems = collectWrongAnswers(updatedSession, sessionQuestions, sessionBundleId)
      appendWrongAnswers(wrongItems)
      const reconciled = reconcileWrongAnswers(sessionBundleId, updatedSession.questionIds, wrongItems)
      setWrongAnswers(reconciled)
      setSession(null)
      setDraftAnswers({})
      setIsAnswerChecked(false)
      setIsCurrentAnswerCorrect(null)
      setSessionQuestions([])
      setScreen('setup')
      return
    }

    setSession({ ...updatedSession, currentIndex: nextIndex })
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
  }

  const openArchive = (): void => {
    setScreen('settings')
  }

  const clearAppCache = async (): Promise<void> => {
    const ok = window.confirm('앱 캐시와 저장된 학습 데이터를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')
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
    setSession(null)
    setSessionBundleId('')
    setSessionQuestions([])
    setDraftAnswers({})
    setStudyMode(null)
    setChunkSize(null)
    setOrder(null)
    setIsAnswerChecked(false)
    setIsCurrentAnswerCorrect(null)
    setScreen('library')
    setSettingsNotice('캐시 및 로컬 데이터가 모두 삭제되었습니다.')
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
    setBundles(nextBundles)
    setWrongAnswers(nextWrongAnswers)
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

  const resetSetupFlow = (): void => {
    setStudyMode(null)
    setChunkSize(null)
    setOrder(null)
  }

  const moveSetupStep = (target: number): void => {
    if (target <= 1) {
      setStudyMode(null)
      setChunkSize(null)
      setOrder(null)
      return
    }
    if (target === 2) {
      if (!studyMode) return
      setChunkSize(null)
      setOrder(null)
      return
    }
    if (target === 3) {
      if (!studyMode || !chunkSize) return
      setOrder(null)
    }
  }

  return (
    <main className="app">
      <header className="pageHeader">
        <div className="headerRow">
          <div className="stepTabs">
            <button
              type="button"
              className={`stepTab ${screen === 'library' ? 'active' : ''}`}
              onClick={() => setScreen('library')}
            >
              보관함
            </button>
            <button
              type="button"
              className={`stepTab ${screen === 'setup' ? 'active' : ''}`}
              onClick={() => hasBundles && setScreen('setup')}
              disabled={!hasBundles}
            >
              출제설정
            </button>
            <button
              type="button"
              className={`stepTab ${screen === 'quiz' ? 'active' : ''}`}
              onClick={() => session && setScreen('quiz')}
              disabled={!session}
            >
              문제풀이
            </button>
          </div>
          <div className="topUtilityBar">
            <button type="button" className="utilityIconButton" onClick={openArchive} aria-label="설정">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z" />
                <path d="M19.4 12a7.6 7.6 0 0 0-.1-1.1l2-1.6-1.9-3.3-2.4 1a8.3 8.3 0 0 0-1.9-1.1l-.4-2.6h-3.8l-.4 2.6c-.7.2-1.3.5-1.9 1.1l-2.4-1-1.9 3.3 2 1.6a7.6 7.6 0 0 0 0 2.2l-2 1.6 1.9 3.3 2.4-1c.6.5 1.2.9 1.9 1.1l.4 2.6h3.8l.4-2.6c.7-.2 1.3-.6 1.9-1.1l2.4 1 1.9-3.3-2-1.6c.1-.4.1-.8.1-1.1z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {screen === 'library' && (
      <section className="card">
        <h2>문제집 보관함</h2>
        <p className="cardDescription">업로드한 PDF 문제집을 선택하고 학습을 시작하세요.</p>
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
            <p className="dropzoneTitle">
              {selectedFileName ? '파일 선택 완료' : '클릭하여 PDF 파일 선택'}
            </p>
            <p className="dropzoneHint">
              {selectedFileName ||
                (isTouchDevice
                  ? '탭하여 PDF 파일을 선택하세요 (최대 20MB)'
                  : '파일을 여기에 끌어다 놓거나 선택하세요 (최대 20MB)')}
            </p>
            {selectedFileSize && <p className="dropzoneMeta">파일 크기: {selectedFileSize}</p>}
            {selectedFileName && (
              <button
                type="button"
                className="clearFileButton"
                onClick={(event) => {
                  event.preventDefault()
                  setSelectedFileName('')
                  setSelectedFileSize('')
                }}
              >
                파일 선택 해제
              </button>
            )}
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

        {hasBundles ? (
          <>
            <div className="libraryShelf">
              {bundles.map((bundle) => (
                <div key={bundle.id} className="libraryBookItem">
                  <button
                    type="button"
                    className={`libraryBook ${selectedBundle?.id === bundle.id ? 'active' : ''}`}
                    onClick={() => setSelectedBundleId(bundle.id)}
                  >
                    <p className="libraryBookTitle">{bundle.title}</p>
                    <p className="libraryBookMeta">{bundle.questions.length}문제</p>
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
            <div className="chipRow">
              <span className="chip">문제집 {bundles.length}개</span>
              <span className="chip">선택 문제 {questions.length}개</span>
              <span className="chip">오답 {wrongQuestionCount}개</span>
            </div>

            <div className="libraryActions">
              <p className="libraryActionHint">문제집을 고른 뒤 다음 단계로 이동하세요.</p>
              <button
                type="button"
                className="nextButton"
                onClick={() => setScreen('setup')}
                disabled={!selectedBundle}
              >
                다음
              </button>
            </div>
          </>
        ) : (
          <p className="emptyNotice">아직 업로드된 문제집이 없습니다. PDF를 먼저 올려주세요.</p>
        )}
      </section>
      )}

      {hasBundles && screen === 'setup' && (
        <section className="card setupCard">
          <h2>출제 설정</h2>
          <div className="setupStepper" aria-label="출제 설정 단계">
            {['학습 타입', '문제 수', '출제 순서', '확인'].map((label, idx) => {
              const step = idx + 1
              const state =
                step < setupStepIndex ? 'done' : step === setupStepIndex ? 'active' : 'todo'
              return (
                <button
                  type="button"
                  key={label}
                  className={`stepItem ${state}`}
                  disabled={state === 'todo'}
                  onClick={() => moveSetupStep(step)}
                >
                  <span className="stepDot">{state === 'done' ? '✓' : step}</span>
                  <span className="stepLabel">{label}</span>
                </button>
              )
            })}
          </div>
          <div className="options">
            {setupStage === 'study' && (
              <fieldset className="optionGroup optionGridTwo">
                <legend className="fieldTitle">학습 타입</legend>
                <label className="optionCard optionCardLibrary">
                  <input type="radio" name="studyMode" onChange={() => setStudyMode('normal')} />
                  <span className="optionTextGroup">
                    <span className="optionTitle">문제 풀기</span>
                    <span className="optionMeta">기본 모드로 전체 문제를 풉니다.</span>
                  </span>
                </label>
                <label className="optionCard optionCardLibrary">
                  <input
                    type="radio"
                    name="studyMode"
                    disabled={wrongQuestionCount === 0}
                    onChange={() => {
                      if (wrongQuestionCount === 0) return
                      setStudyMode('wrongOnly')
                    }}
                  />
                  <span className="optionTextGroup">
                    <span className="optionTitle">오답풀기</span>
                    <span className="optionMeta">
                      {wrongQuestionCount === 0
                        ? '아직 오답이 없어 선택할 수 없습니다.'
                        : `누적 오답 ${wrongQuestionCount}문제만 다시 풉니다.`}
                    </span>
                  </span>
                </label>
              </fieldset>
            )}

            {setupStage === 'count' && (
              <fieldset className="optionGroup optionGridTwo">
                <legend className="fieldTitle">문제 수</legend>
                <label className="optionCard optionCardLibrary">
                  <input type="radio" name="chunkSize" onChange={() => setChunkSize(1)} />
                  <span className="optionTextGroup">
                    <span className="optionTitle">1문제</span>
                    <span className="optionMeta">짧게 빠르게 풉니다.</span>
                  </span>
                </label>
                <label className="optionCard optionCardLibrary">
                  <input type="radio" name="chunkSize" onChange={() => setChunkSize(5)} />
                  <span className="optionTextGroup">
                    <span className="optionTitle">5문제</span>
                    <span className="optionMeta">집중 모드로 풉니다.</span>
                  </span>
                </label>
              </fieldset>
            )}

            {setupStage === 'order' && (
              <fieldset className="optionGroup optionGridTwo">
                <legend className="fieldTitle">출제 순서</legend>
                <label className="optionCard optionCardLibrary">
                  <input type="radio" name="order" onChange={() => setOrder('sequential')} />
                  <span className="optionTextGroup">
                    <span className="optionTitle">순차</span>
                    <span className="optionMeta">문제 번호대로 진행합니다.</span>
                  </span>
                </label>
                <label className="optionCard optionCardLibrary">
                  <input type="radio" name="order" onChange={() => setOrder('random')} />
                  <span className="optionTextGroup">
                    <span className="optionTitle">랜덤</span>
                    <span className="optionMeta">섞어서 실전처럼 풉니다.</span>
                  </span>
                </label>
              </fieldset>
            )}

            {setupSummary && (
              <div className="summaryPanel">
                <div className="summaryRow">
                  <span>학습 타입</span>
                  <strong>{studyMode === 'wrongOnly' ? '오답풀기' : '문제 풀기'}</strong>
                  <button
                    type="button"
                    className="summaryEditButton"
                    onClick={() => {
                      setStudyMode(null)
                      setChunkSize(null)
                      setOrder(null)
                    }}
                  >
                    수정
                  </button>
                </div>
                {chunkSize && (
                  <div className="summaryRow">
                    <span>문제 수</span>
                    <strong>{chunkSize}문제</strong>
                    <button
                      type="button"
                      className="summaryEditButton"
                      onClick={() => {
                        setChunkSize(null)
                        setOrder(null)
                      }}
                    >
                      수정
                    </button>
                  </div>
                )}
                {order && (
                  <div className="summaryRow">
                    <span>출제 순서</span>
                    <strong>{order === 'random' ? '랜덤' : '순차'}</strong>
                    <button type="button" className="summaryEditButton" onClick={() => setOrder(null)}>
                      수정
                    </button>
                  </div>
                )}
              </div>
            )}

            {setupStage === 'ready' && (
              <button className="startButton" onClick={startQuiz} disabled={!canStartQuiz}>
                시작하기
              </button>
            )}

            {setupStage !== 'study' && (
              <button type="button" className="ghostButton" onClick={resetSetupFlow}>
                다시 선택
              </button>
            )}
          </div>
        </section>
      )}

      {hasBundles && session && screen === 'quiz' && (
        <section className="card">
          <h2>문제 풀이</h2>
          <div className="quizProgressHeader">
            <div className="progressMeta">
              <span>
                진행도 {currentStep} / {totalQuestionsInSession}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div className="quizStatChips" aria-label="현재 정오답 현황">
              <span className="quizStatChip correct">정답 {previewStats.correct}</span>
              <span className="quizStatChip wrong">오답 {previewStats.wrong}</span>
            </div>
          </div>
          <div className="quizProgressTrack">
            <div className="quizProgressFill" style={{ width: `${progressPercent}%` }} />
          </div>
          {currentQuestion && (
            <article key={currentQuestion.id} className="question">
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
              {isAnswerChecked && (
                <>
                  {isCurrentAnswerCorrect === null ? (
                    <p className="resultBadge unknown">i 정답 정보가 없는 문제입니다.</p>
                  ) : (
                    <p className={`resultBadge ${isCurrentAnswerCorrect ? 'correct' : 'wrong'}`}>
                      {isCurrentAnswerCorrect
                        ? 'V 정답입니다. 다음 문제를 누르면 진행합니다.'
                        : 'X 오답입니다. 정답을 확인하고 다음 문제를 눌러 진행하세요.'}
                    </p>
                  )}
                </>
              )}
            </article>
          )}
          <div className="quizActionBar">
            {isAnswerChecked ? (
              <button onClick={moveToNextQuestion}>다음 문제</button>
            ) : (
              <button onClick={checkCurrentAnswer}>정답 확인</button>
            )}
          </div>
        </section>
      )}

      {screen === 'settings' && (
        <section className="card settingsCard">
          <h2>설정</h2>
          <p className="cardDescription">앱 운영 정보와 데이터 관리 기능을 확인할 수 있습니다.</p>

          <div className="settingsList">
            <details className="settingsItem" open>
              <summary>이용약관</summary>
              <div className="settingsBody">
                <p>QDF는 사용자가 업로드한 PDF를 기반으로 학습 문제를 생성하는 개인 학습용 앱입니다.</p>
                <ul>
                  <li>사용자는 저작권법을 준수하며 합법적인 파일만 업로드해야 합니다.</li>
                  <li>앱은 학습 보조 목적이며 시험 결과를 보장하지 않습니다.</li>
                  <li>서비스 개선을 위해 약관은 업데이트될 수 있습니다.</li>
                </ul>
              </div>
            </details>

            <details className="settingsItem" open>
              <summary>개인정보처리방침</summary>
              <div className="settingsBody">
                <ul>
                  <li>수집 항목: 업로드한 문제 데이터, 오답 기록, 앱 설정 값</li>
                  <li>저장 위치: 사용자 브라우저 로컬 저장소(서버 전송 없음)</li>
                  <li>보관 기간: 사용자가 삭제하기 전까지</li>
                  <li>문의: support@qdf.app</li>
                </ul>
              </div>
            </details>

            <div className="settingsItem static">
              <p className="settingsTitle">캐시 및 데이터 관리</p>
              <p className="settingsHint">로컬에 저장된 문제집, 오답노트, 캐시를 모두 삭제합니다.</p>
              <button type="button" className="dangerButton" onClick={() => void clearAppCache()}>
                캐시 삭제
              </button>
            </div>

            <div className="settingsItem static">
              <p className="settingsTitle">앱 버전</p>
              <p className="settingsVersion">QDF v{APP_VERSION}</p>
              <p className="settingsHint">최종 업데이트: 2026-04-27</p>
            </div>

            <div className="settingsItem static">
              <p className="settingsTitle">오픈소스 및 고지</p>
              <p className="settingsHint">
                본 앱은 React, Vite, pdf.js 등 오픈소스 소프트웨어를 사용합니다. 라이선스는 각 프로젝트 정책을
                따릅니다.
              </p>
            </div>
          </div>

          {settingsNotice && <p className="settingsNotice">{settingsNotice}</p>}
        </section>
      )}
    </main>
  )
}

export default App

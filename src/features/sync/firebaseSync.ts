import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore'
import { firebaseServices } from '../../config/firebase'
import type {
  BookmarkItem,
  LocalAppData,
  QuestionBundle,
  QuizAttemptItem,
  SyncSnapshot,
  WrongAnswerItem,
} from '../../types'

const SYNC_SCHEMA_VERSION = 1
const DEVICE_ID_KEY = 'pdfQuiz.sync.deviceId.v1'
const SYNC_USAGE_KEY = 'pdfQuiz.sync.usage.v1'
const DAILY_READ_LIMIT = 120
const DAILY_WRITE_LIMIT = 120

type SyncUsage = {
  date: string
  reads: number
  writes: number
}

export interface SyncQuotaStatus {
  date: string
  reads: number
  writes: number
  readLimit: number
  writeLimit: number
  readRemaining: number
  writeRemaining: number
  blocked: boolean
}

const asTime = (value: string | undefined): number => {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

const getOrCreateDeviceId = (): string => {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const created = `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  window.localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

const todayKey = (): string => new Date().toISOString().slice(0, 10)

const loadSyncUsage = (): SyncUsage => {
  try {
    const raw = window.localStorage.getItem(SYNC_USAGE_KEY)
    if (!raw) return { date: todayKey(), reads: 0, writes: 0 }
    const parsed = JSON.parse(raw) as Partial<SyncUsage>
    const date = typeof parsed.date === 'string' ? parsed.date : todayKey()
    if (date !== todayKey()) return { date: todayKey(), reads: 0, writes: 0 }
    return {
      date,
      reads: Number(parsed.reads ?? 0),
      writes: Number(parsed.writes ?? 0),
    }
  } catch {
    return { date: todayKey(), reads: 0, writes: 0 }
  }
}

const saveSyncUsage = (usage: SyncUsage): void => {
  window.localStorage.setItem(SYNC_USAGE_KEY, JSON.stringify(usage))
}

const consumeQuota = (type: 'read' | 'write'): void => {
  const usage = loadSyncUsage()
  if (type === 'read' && usage.reads >= DAILY_READ_LIMIT) {
    throw new Error('SYNC-QUOTA-READ: 오늘 읽기 한도를 초과했습니다.')
  }
  if (type === 'write' && usage.writes >= DAILY_WRITE_LIMIT) {
    throw new Error('SYNC-QUOTA-WRITE: 오늘 쓰기 한도를 초과했습니다.')
  }
  const next: SyncUsage =
    type === 'read'
      ? { ...usage, reads: usage.reads + 1 }
      : { ...usage, writes: usage.writes + 1 }
  saveSyncUsage(next)
}

export const getSyncQuotaStatus = (): SyncQuotaStatus => {
  const usage = loadSyncUsage()
  const readRemaining = Math.max(0, DAILY_READ_LIMIT - usage.reads)
  const writeRemaining = Math.max(0, DAILY_WRITE_LIMIT - usage.writes)
  return {
    date: usage.date,
    reads: usage.reads,
    writes: usage.writes,
    readLimit: DAILY_READ_LIMIT,
    writeLimit: DAILY_WRITE_LIMIT,
    readRemaining,
    writeRemaining,
    blocked: readRemaining === 0 || writeRemaining === 0,
  }
}

const mergeBundles = (local: QuestionBundle[], remote: QuestionBundle[]): QuestionBundle[] => {
  const byId = new Map<string, QuestionBundle>()
  for (const item of [...local, ...remote]) {
    const prev = byId.get(item.id)
    if (!prev || asTime(item.createdAt) >= asTime(prev.createdAt)) {
      byId.set(item.id, item)
    }
  }
  return [...byId.values()].sort((a, b) => asTime(b.createdAt) - asTime(a.createdAt))
}

const mergeWrongAnswers = (local: WrongAnswerItem[], remote: WrongAnswerItem[]): WrongAnswerItem[] => {
  const byKey = new Map<string, WrongAnswerItem>()
  for (const item of [...local, ...remote]) {
    const key = `${item.bundleId}:${item.questionId}`
    const prev = byKey.get(key)
    if (!prev || asTime(item.answeredAt) >= asTime(prev.answeredAt)) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()]
}

const mergeBookmarks = (local: BookmarkItem[], remote: BookmarkItem[]): BookmarkItem[] => {
  const byKey = new Map<string, BookmarkItem>()
  for (const item of [...local, ...remote]) {
    const key = `${item.bundleId}:${item.questionId}`
    const prev = byKey.get(key)
    if (!prev || asTime(item.bookmarkedAt) >= asTime(prev.bookmarkedAt)) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()]
}

const mergeQuizAttempts = (local: QuizAttemptItem[], remote: QuizAttemptItem[]): QuizAttemptItem[] => {
  const byKey = new Map<string, QuizAttemptItem>()
  for (const item of [...local, ...remote]) {
    const key = `${item.bundleId}:${item.questionId}:${item.answeredAt}:${item.selected}`
    if (!byKey.has(key)) byKey.set(key, item)
  }
  return [...byKey.values()].sort((a, b) => asTime(a.answeredAt) - asTime(b.answeredAt))
}

const asLocalData = (raw: Partial<LocalAppData> | null | undefined): LocalAppData => ({
  bundles: Array.isArray(raw?.bundles) ? raw.bundles : [],
  wrongAnswers: Array.isArray(raw?.wrongAnswers) ? raw.wrongAnswers : [],
  bookmarks: Array.isArray(raw?.bookmarks) ? raw.bookmarks : [],
  quizAttempts: Array.isArray(raw?.quizAttempts) ? raw.quizAttempts : [],
})

export const createSyncSnapshot = (data: LocalAppData): SyncSnapshot => ({
  ...data,
  schemaVersion: SYNC_SCHEMA_VERSION,
  deviceId: getOrCreateDeviceId(),
  updatedAt: new Date().toISOString(),
})

export const mergeLocalAndRemoteData = (
  localData: LocalAppData,
  remoteSnapshot: SyncSnapshot,
): LocalAppData => ({
  bundles: mergeBundles(localData.bundles, remoteSnapshot.bundles),
  wrongAnswers: mergeWrongAnswers(localData.wrongAnswers, remoteSnapshot.wrongAnswers),
  bookmarks: mergeBookmarks(localData.bookmarks, remoteSnapshot.bookmarks),
  quizAttempts: mergeQuizAttempts(localData.quizAttempts, remoteSnapshot.quizAttempts),
})

export const pullCloudSnapshot = async (uid: string): Promise<SyncSnapshot | null> => {
  if (!firebaseServices.db) return null
  consumeQuota('read')
  const ref = doc(firebaseServices.db, 'users', uid, 'sync', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  const raw = snap.data() as Partial<SyncSnapshot>
  return {
    ...asLocalData(raw),
    schemaVersion: Number(raw.schemaVersion ?? SYNC_SCHEMA_VERSION),
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : getOrCreateDeviceId(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  }
}

export const pushCloudSnapshot = async (uid: string, data: LocalAppData): Promise<SyncSnapshot> => {
  if (!firebaseServices.db) {
    throw new Error('Firebase DB가 설정되지 않았습니다.')
  }
  consumeQuota('write')
  const snapshot = createSyncSnapshot(data)
  const ref = doc(firebaseServices.db, 'users', uid, 'sync', 'main')
  await setDoc(ref, snapshot, { merge: true })
  return snapshot
}

export const clearCloudSnapshot = async (uid: string): Promise<void> => {
  if (!firebaseServices.db) {
    throw new Error('Firebase DB가 설정되지 않았습니다.')
  }
  consumeQuota('write')
  const ref = doc(firebaseServices.db, 'users', uid, 'sync', 'main')
  await deleteDoc(ref)
}

export const exportSnapshotToJson = (data: LocalAppData): string =>
  JSON.stringify(createSyncSnapshot(data), null, 2)

export const importSnapshotFromJson = (text: string): SyncSnapshot => {
  const parsed = JSON.parse(text) as Partial<SyncSnapshot>
  const local = asLocalData(parsed)
  return {
    ...local,
    schemaVersion: Number(parsed.schemaVersion ?? SYNC_SCHEMA_VERSION),
    deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : getOrCreateDeviceId(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  }
}

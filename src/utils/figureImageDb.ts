/**
 * 문항 참고 이미지(base64 Data URL) 저장소.
 * localStorage는 수 MB급 문자열 저장에 불리해 저장 실패 후 이미지가 비는 증상이 자주 발생하므로
 * 브라우저 IndexedDB 사용.
 */

import { clearFigureCache, loadFigureCache } from './storage'

const DB_NAME = 'pdfQuiz.figureImages.v1'
const STORE = 'figures'

const dbFromRequest = <T extends IDBOpenDBRequest>(request: T): Promise<T['result']> =>
  new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 요청 실패'))
    request.onsuccess = () => resolve(request.result)
  })

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('이 브라우저에서는 IndexedDB를 사용할 수 없습니다.')
  }
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE)
    }
  }
  return dbFromRequest(request) as Promise<IDBDatabase>
}

export async function figureDbPutBatch(entries: Record<string, string>): Promise<void> {
  const keys = Object.keys(entries)
  if (!keys.length) return

  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 쓰기 실패'))
    }
    tx.onabort = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 쓰기 중단'))
    }
    const store = tx.objectStore(STORE)
    for (const key of keys) {
      store.put(entries[key], key)
    }
  })
}

/** 기존 localStorage 캐시를 한 번 IndexedDB로 옮기고 LS는 비운다 */
export async function migrateLegacyFigureCacheToIndexedDb(): Promise<void> {
  const legacy = loadFigureCache()
  if (!Object.keys(legacy).length) return
  await figureDbPutBatch(legacy)
  clearFigureCache()
}

export async function figureDbGetAll(): Promise<Record<string, string>> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const request = store.openCursor()
    const out: Record<string, string> = {}

    request.onsuccess = (): void => {
      const cursor = request.result as IDBCursorWithValue | null
      if (!cursor) {
        db.close()
        resolve(out)
        return
      }
      const key = typeof cursor.key === 'string' ? cursor.key : String(cursor.key)
      out[key] = String(cursor.value)
      cursor.continue()
    }
    request.onerror = (): void => {
      db.close()
      reject(request.error ?? new Error('IndexedDB 읽기 실패'))
    }
  })
}

export async function figureDbDeleteByBundlePrefix(bundleId: string): Promise<void> {
  const prefix = `${bundleId}-`
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 삭제 실패'))
    }
    tx.onabort = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 삭제 중단'))
    }
    const store = tx.objectStore(STORE)
    const cursorReq = store.openCursor()
    cursorReq.onsuccess = (): void => {
      const cursor = cursorReq.result as IDBCursorWithValue | null
      if (!cursor) return
      const key = typeof cursor.key === 'string' ? cursor.key : String(cursor.key)
      if (key.startsWith(prefix)) {
        cursor.delete()
      }
      cursor.continue()
    }
    cursorReq.onerror = (): void => reject(cursorReq.error ?? new Error('IndexedDB 삭제 조회 실패'))
  })
}

/** 캐시 비우기(앱 전체 초기화) */
export async function figureDbClearAll(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 전체 삭제 실패'))
    }
    tx.onabort = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB 삭제 트랜잭션 중단'))
    }
    tx.objectStore(STORE).clear()
  })
}

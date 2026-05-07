/**
 * 업로드한 PDF 원본(바이너리)을 보관했다가, 업로드 시점 래스터가 실패해도
 * 문제 풀이 화면에서 필요한 페이지만 다시 렌더해 도표 문항을 복구한다.
 */

const DB_NAME = 'pdfQuiz.pdfBlobs.v1'
const STORE = 'blobs'

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

export async function pdfBlobDbPut(bundleId: string, data: Uint8Array): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB PDF 쓰기 실패'))
    }
    tx.onabort = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB PDF 쓰기 중단'))
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    tx.objectStore(STORE).put(buffer, bundleId)
  })
}

export async function pdfBlobDbGet(bundleId: string): Promise<Uint8Array | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(bundleId)
    req.onsuccess = (): void => {
      db.close()
      const value = req.result
      if (value instanceof ArrayBuffer) {
        resolve(new Uint8Array(value))
      } else {
        resolve(null)
      }
    }
    req.onerror = (): void => {
      db.close()
      reject(req.error ?? new Error('IndexedDB PDF 읽기 실패'))
    }
  })
}

export async function pdfBlobDbDelete(bundleId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB PDF 삭제 실패'))
    }
    tx.objectStore(STORE).delete(bundleId)
  })
}

export async function pdfBlobDbClearAll(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = (): void => {
      db.close()
      resolve()
    }
    tx.onerror = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB PDF 전체 삭제 실패'))
    }
    tx.onabort = (): void => {
      db.close()
      reject(tx.error ?? new Error('IndexedDB PDF 삭제 트랜잭션 중단'))
    }
    tx.objectStore(STORE).clear()
  })
}

import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
}

const isConfigured = Object.values(firebaseConfig).every((value) => value)

let authInstance: ReturnType<typeof getAuth> | null = null
let firestoreInstance: ReturnType<typeof getFirestore> | null = null

if (isConfigured) {
  const app = initializeApp(firebaseConfig)
  authInstance = getAuth(app)
  firestoreInstance = getFirestore(app)
}

export const isFirebaseEnabled = isConfigured

export const firebaseServices = {
  auth: authInstance,
  db: firestoreInstance,
}

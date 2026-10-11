// Fill these in after creating the Firebase project (see README "Hosted mode").
// None of this is secret: Firebase web config is meant to be public, and the OpenRouter key
// lives only in the Cloud Function's secret store.
export const FIREBASE_CONFIG = {
  apiKey: 'YOUR-FIREBASE-WEB-API-KEY',
  authDomain: 'YOUR-FIREBASE-PROJECT-ID.firebaseapp.com',
  projectId: 'YOUR-FIREBASE-PROJECT-ID',
  appId: 'YOUR-FIREBASE-APP-ID',
};

// The deployed function's URL (printed by `firebase deploy`), without a trailing slash.
export const API_BASE = 'https://us-central1-YOUR-FIREBASE-PROJECT-ID.cloudfunctions.net/api';

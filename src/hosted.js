// Hosted build: sign in with Google, check the allowlist via the proxy, then start the app with the
// proxy as its backend. The OpenRouter key never reaches the browser.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { backend, start } from './app.js';
import { FIREBASE_CONFIG, API_BASE } from './hosted-config.js';

const auth = getAuth(initializeApp(FIREBASE_CONFIG));
const gate = document.getElementById('gate');
const main = document.querySelector('main');
let started = false;

function showGate(title, text, { signIn = false, signOutBtn = false } = {}) {
  main.hidden = true;
  gate.hidden = false;
  gate.querySelector('h2').textContent = title;
  gate.querySelector('p').textContent = text;
  gate.querySelector('.sign-in').hidden = !signIn;
  gate.querySelector('.sign-out').hidden = !signOutBtn;
}

function showAccount(me) {
  const el = document.getElementById('account');
  el.hidden = false;
  el.innerHTML = '<span class="who"></span><span class="spend"></span><button type="button" class="btn text small">Sign out</button>';
  el.querySelector('.who').textContent = me.email;
  el.querySelector('.spend').textContent = `· $${me.spent.toFixed(2)} of $${me.limit.toFixed(2)} this month`;
  el.querySelector('button').addEventListener('click', () => signOut(auth).then(() => location.reload()));
}

gate.querySelector('.sign-in').addEventListener('click', () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    gate.querySelector('p').textContent = `Sign-in failed: ${err.message}`;
  }),
);
gate.querySelector('.sign-out').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showGate('Sign in to My Council', 'This is a private test. Sign in with the Google account you were invited with.', { signIn: true });
    return;
  }
  showGate('Checking your access…', '');
  let res;
  try {
    res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  } catch {
    showGate('Can’t reach the server', 'Check your connection and reload.', { signOutBtn: true });
    return;
  }
  const me = await res.json().catch(() => ({}));
  if (!res.ok) {
    showGate('Not approved yet', me?.error?.message ?? `Access check failed (HTTP ${res.status}).`, { signOutBtn: true });
    return;
  }
  gate.hidden = true;
  main.hidden = false;
  showAccount(me);
  if (started) return;
  started = true;
  backend.hosted = true;
  backend.endpoint = `${API_BASE}/chat`;
  backend.getToken = () => auth.currentUser.getIdToken(); // refreshed by Firebase when it nears expiry
  start();
});

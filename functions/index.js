// The hosted build's only server code: one Cloud Function that holds the OpenRouter key.
//
//   GET  /me    → who you are, whether you're approved, and this month's spend
//   POST /chat  → forwards a chat completion to OpenRouter and streams it back
//
// A caller must send a Firebase ID token, and their email must have a document in the
// `allowedUsers` collection (document ID = lowercase email). Spend is logged per user per month in
// `usage/{uid}/months/{yyyy-mm}`, which is what a paid tier would bill from later.

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { CATALOG, CHAIRS } from './catalog.js'; // copied from src/ on deploy (see firebase.json)

const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
const DEFAULT_MONTHLY_LIMIT_USD = 5;
const ALLOWED_MODELS = new Set([...CATALOG, ...CHAIRS].map((m) => m.id));
const EFFORTS = new Set(['low', 'medium', 'high']);

initializeApp();
const db = getFirestore();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function authorize(req) {
  const token = /^Bearer (.+)$/.exec(req.get('Authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, 'Sign in first.');
  let user;
  try {
    user = await getAuth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, 'Your sign-in expired. Reload the page.');
  }
  const email = user.email?.toLowerCase();
  if (!email || !user.email_verified) throw new HttpError(403, 'Your account has no verified email.');
  const allowed = await db.doc(`allowedUsers/${email}`).get();
  if (!allowed.exists || allowed.get('disabled')) throw new HttpError(403, `${email} isn't approved for testing yet.`);
  const month = new Date().toISOString().slice(0, 7);
  const usageRef = db.doc(`usage/${user.uid}/months/${month}`);
  const spent = (await usageRef.get()).get('cost') ?? 0;
  const limit = allowed.get('monthlyLimitUsd') ?? DEFAULT_MONTHLY_LIMIT_USD;
  return { uid: user.uid, email, usageRef, spent, limit };
}

/** Only the fields the app sends, and only the curated models, so the key can't be used for anything else. */
function upstreamBody(body, uid) {
  if (!ALLOWED_MODELS.has(body?.model)) throw new HttpError(400, `Model not available: ${body?.model}`);
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'No messages.');
  const out = { model: body.model, messages: body.messages, stream: true, usage: { include: true }, user: uid };
  if (typeof body.session_id === 'string') out.session_id = `${uid}:${body.session_id}`.slice(0, 256);
  if (body.cache_control) out.cache_control = { type: 'ephemeral' };
  if (EFFORTS.has(body.reasoning?.effort)) out.reasoning = { effort: body.reasoning.effort };
  return out;
}

export const api = onRequest(
  { secrets: [OPENROUTER_API_KEY], cors: true, timeoutSeconds: 540, memory: '256MiB', maxInstances: 20 },
  async (req, res) => {
    const path = req.path.replace(/^\/api/, '') || '/';
    try {
      const who = await authorize(req);

      if (path === '/me' && req.method === 'GET') {
        res.json({ email: who.email, approved: true, spent: who.spent, limit: who.limit });
        return;
      }
      if (path !== '/chat' || req.method !== 'POST') throw new HttpError(404, 'Not found.');
      if (who.spent >= who.limit) {
        throw new HttpError(402, `You've used your $${who.limit.toFixed(2)} testing budget for this month.`);
      }

      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort(); // the browser pressed Stop or went away
      });
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY.value()}`,
          'Content-Type': 'application/json',
          'X-Title': 'My Council',
        },
        body: JSON.stringify(upstreamBody(req.body, who.uid)),
      });
      if (!upstream.ok) {
        const detail = await upstream.json().catch(() => ({}));
        res.status(upstream.status).json({ error: { message: detail?.error?.message ?? `OpenRouter HTTP ${upstream.status}` } });
        return;
      }

      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      const decoder = new TextDecoder();
      let tail = '';
      let cost = 0;
      for await (const chunk of upstream.body) {
        res.write(chunk);
        // Watch the stream for the final usage chunk, which carries the cost.
        tail += decoder.decode(chunk, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
          try {
            cost = JSON.parse(line.slice(5)).usage?.cost ?? cost;
          } catch {}
        }
      }
      res.end();
      if (cost > 0) {
        await who.usageRef.set(
          { cost: FieldValue.increment(cost), calls: FieldValue.increment(1), email: who.email, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(err);
      if (res.headersSent) res.end();
      else res.status(status).json({ error: { message: status === 500 ? 'Server error.' : err.message } });
    }
  },
);

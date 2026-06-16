import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

export function signToken(requestId, decision, secret) {
  if (!secret) throw new TypeError('signToken: secret is required');
  const payload = b64url(JSON.stringify({ requestId, decision }));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = b64url(createHmac('sha256', secret).update(payload).digest());
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(fromB64url(payload).toString('utf8'));
    if (typeof obj.requestId !== 'string' || typeof obj.decision !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

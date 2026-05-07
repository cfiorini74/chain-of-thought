export const SESSION_COOKIE_NAME = 'demo_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value)
  );
  return bufferToHex(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function createSessionToken(
  secret: string
): Promise<{ token: string; maxAgeSeconds: number }> {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(String(expiresAt), secret);
  return {
    token: `${expiresAt}.${sig}`,
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;
  const [expiresAtStr, sig] = token.split('.');
  if (!expiresAtStr || !sig) return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await hmacHex(expiresAtStr, secret);
  return constantTimeEqual(expected, sig);
}

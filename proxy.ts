import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';

export async function proxy(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'auth not configured' },
      { status: 500 }
    );
  }
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const ok = await verifySessionToken(token, secret);
  if (!ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/agents/:path*',
};

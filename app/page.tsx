import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { LoginForm } from './login-form';
import ResearchApp from '@/components/ResearchApp';

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const secret = process.env.AUTH_SECRET ?? '';
  const isAuthed = secret ? await verifySessionToken(token, secret) : false;

  if (!isAuthed) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
        <main className="flex w-full max-w-md flex-col items-center gap-8 px-8 py-16">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Chain of Thought
          </h1>
          <LoginForm />
        </main>
      </div>
    );
  }

  return <ResearchApp />;
}

'use client';

import { useState, type FormEvent } from 'react';

interface LandingProps {
  onSubmit: (query: string) => void;
}

export default function Landing({ onSubmit }: LandingProps) {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    onSubmit(trimmed);
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <main className="flex w-full max-w-xl flex-col items-center gap-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Research Tree
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Ask a question. We&apos;ll search the web; you&apos;ll branch and
          summarize.
        </p>
        <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="Is MSFT a good investment in today's day and age?"
            disabled={submitting}
            autoFocus
            className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={submitting || query.trim().length === 0}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {submitting ? 'building…' : 'Research'}
          </button>
        </form>
      </main>
    </div>
  );
}

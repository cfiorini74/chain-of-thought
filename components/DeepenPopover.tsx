'use client';

import { useEffect, useRef, useState } from 'react';

interface DeepenPopoverProps {
  initialSuggestions: string[];
  disabled?: boolean;
  onConfirm: (finalSuggestions: string[]) => void;
  onCancel: () => void;
}

export default function DeepenPopover({
  initialSuggestions,
  disabled,
  onConfirm,
  onCancel,
}: DeepenPopoverProps) {
  const [rows, setRows] = useState<string[]>(() =>
    initialSuggestions.length > 0 ? initialSuggestions : ['']
  );
  const lastInputRef = useRef<HTMLInputElement | null>(null);
  const justAddedRef = useRef(false);

  useEffect(() => {
    if (justAddedRef.current) {
      lastInputRef.current?.focus();
      justAddedRef.current = false;
    }
  }, [rows]);

  function updateRow(i: number, value: string) {
    setRows((cur) => cur.map((v, idx) => (idx === i ? value : v)));
  }
  function deleteRow(i: number) {
    setRows((cur) => cur.filter((_, idx) => idx !== i));
  }
  function addRow() {
    justAddedRef.current = true;
    setRows((cur) => [...cur, '']);
  }

  const filledCount = rows.filter((r) => r.trim().length > 0).length;
  const canConfirm = filledCount > 0 && !disabled;

  return (
    <div className="rounded-md border border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        New sub-questions
      </div>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              ref={i === rows.length - 1 ? lastInputRef : undefined}
              type="text"
              value={row}
              onChange={(e) => updateRow(i, e.target.value)}
              disabled={disabled}
              placeholder="Sub-question…"
              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={() => deleteRow(i)}
              disabled={disabled || rows.length === 1}
              aria-label="Remove"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          + Add another
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(rows)}
            disabled={!canConfirm}
            className="rounded bg-zinc-900 px-3 py-1 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Confirm ({filledCount})
          </button>
        </div>
      </div>
    </div>
  );
}

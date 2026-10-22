'use client';

// Route-level error UI: shown when the page itself fails to render. Friendly
// copy only — the error message / stack never reach the user. In production
// Next.js replaces server error messages with a digest, which we show as a
// reference the user can quote (it matches the server `request_error` log).

import Link from 'next/link';
import { useEffect } from 'react';

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-3xl text-ink">Something went wrong</h1>
      <p className="mt-3 max-w-md text-body">
        Swizzo hit a snag loading this page. Your cart and bookings on Swiggy are safe — please try again.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="rounded-full bg-coral px-5 py-2 text-sm font-medium text-on-primary hover:bg-coral-active"
        >
          Try again
        </button>
        <Link href="/" className="rounded-full border border-hairline px-5 py-2 text-sm font-medium text-ink">
          Go home
        </Link>
      </div>
      {error.digest ? <p className="mt-6 text-xs text-muted">Reference: {error.digest}</p> : null}
    </main>
  );
}

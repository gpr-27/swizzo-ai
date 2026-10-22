'use client';

// Last-resort error UI when the root layout itself fails. It replaces the
// layout, so it brings its own <html>/<body> and inline styles (globals.css and
// fonts may not have loaded). No error details are shown.

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#faf9f5',
          color: '#1f1e1d',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          textAlign: 'center',
          padding: 24,
        }}
      >
        <title>Something went wrong · Swizzo</title>
        <div>
          <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 400, fontSize: 30, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: 12, maxWidth: 420, lineHeight: 1.5 }}>
            Swizzo couldn&apos;t load. Your cart and bookings on Swiggy are safe — please try again.
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              marginTop: 20,
              border: 0,
              borderRadius: 999,
              padding: '10px 22px',
              background: '#cc785c',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? <p style={{ marginTop: 20, fontSize: 12, opacity: 0.6 }}>Reference: {error.digest}</p> : null}
        </div>
      </body>
    </html>
  );
}

// 404 page for unknown URLs.

import Link from 'next/link';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 font-display text-3xl text-ink">This page doesn&apos;t exist</h1>
      <p className="mt-3 max-w-md text-body">The link may be old or mistyped. Your concierge is one tap away.</p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-coral px-5 py-2 text-sm font-medium text-on-primary hover:bg-coral-active"
      >
        Back to Swizzo
      </Link>
    </main>
  );
}

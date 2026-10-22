'use client';

// Full-screen photo viewer for Swiggy's own images (Dineout masthead photos and
// menu pages, Food dish photos). Arrow keys / swipe / buttons to move, Esc or
// the backdrop to close, focus kept inside while open. Images are shown as
// Swiggy served them — nothing is added.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';

export interface LightboxImage {
  src: string;
  alt: string;
  caption?: string;
}

export interface LightboxProps {
  images: LightboxImage[];
  startIndex?: number;
  title?: string;
  onClose: () => void;
}

/** Ask Swiggy's CDN for a larger rendition of an already-resized image. */
export function largerSwiggyImage(src: string, width = 1400): string {
  return src.replace(/\/image\/upload\/([^/]*\b)w_\d+([^/]*)\//, (_m, a: string, b: string) => `/image/upload/${a}w_${width}${b}/`);
}

export function Lightbox({ images, startIndex = 0, title, onClose }: LightboxProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, images.length - 1)));
  const panelRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  useDialogA11y(true, panelRef, onClose);

  const count = images.length;
  const go = (d: number) => setIndex((i) => (count ? (i + d + count) % count : 0));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIndex((i) => (count ? (i + 1) % count : 0));
      if (e.key === 'ArrowLeft') setIndex((i) => (count ? (i - 1 + count) % count : 0));
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [count]);

  if (typeof document === 'undefined' || !count) return null;
  const img = images[index];

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} photos` : 'Photos'}
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 text-white"
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < 40) return;
        go(end < start ? 1 : -1);
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          {title && <p className="truncate text-sm font-semibold">{title}</p>}
          <p className="text-[11px] text-white/70">
            {index + 1} / {count}
            {img.caption ? ` · ${img.caption}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photos"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          ✕
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2" onClick={onClose}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img decoding="async"
          key={img.src}
          src={largerSwiggyImage(img.src)}
          alt={img.alt}
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full rounded-lg object-contain animate-rise"
          onClick={(e) => e.stopPropagation()}
          onError={(e) => {
            // The larger rendition can 404 for some assets — fall back to the original.
            const el = e.currentTarget;
            if (el.src !== img.src) el.src = img.src;
          }}
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                go(-1);
              }}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-lg hover:bg-white/25 sm:left-4"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                go(1);
              }}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-lg hover:bg-white/25 sm:right-4"
            >
              ›
            </button>
          </>
        )}
      </div>

      {count > 1 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-4">
          {images.map((im, i) => (
            <button
              key={`${im.src}-${i}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Photo ${i + 1}`}
              aria-current={i === index}
              className={`h-12 w-16 shrink-0 overflow-hidden rounded-md border-2 ${i === index ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img decoding="async" src={im.src} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

export default Lightbox;

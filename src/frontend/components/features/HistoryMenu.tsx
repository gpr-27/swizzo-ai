'use client';

// A dropdown of locally-saved conversations. "New chat" starts a fresh thread
// (the current one stays saved); each row reopens a past chat (restoring its
// service + cards); the × deletes it. Anchored to a clock button in the top bar.

import { useEffect, useRef, useState } from 'react';
import type { ChatSessionMeta } from '@/shared/types';
import { SERVICE_META } from '@/shared/types';

export interface HistoryMenuProps {
  history: ChatSessionMeta[];
  activeId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

// Stale sessions may carry a service that no longer exists (e.g. a removed
// "dineout"/"concierge"). Look the label up defensively so the dropdown never
// throws on `SERVICE_META[undefined].label`.
function serviceLabel(service: string): string {
  const meta = (SERVICE_META as Record<string, { label: string } | undefined>)[
    service
  ];
  if (meta) return meta.label;
  return service ? service.charAt(0).toUpperCase() + service.slice(1) : 'Chat';
}

function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}

export function HistoryMenu({
  history,
  activeId,
  onOpen,
  onNew,
  onDelete,
}: HistoryMenuProps) {
  const [open, setOpen] = useState(false);
  // Two-tap delete: the first tap arms the row's ×, the second deletes.
  const [armed, setArmed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setArmed(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setArmed(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setArmed(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    // Move focus into the panel so keyboard users land on "New chat".
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`group flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
          open
            ? 'border-coral/70 bg-surface-card text-ink shadow-xs'
            : 'border-hairline bg-surface-card/40 text-body hover:border-coral/40 hover:bg-surface-card/80 hover:text-ink'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 text-muted transition-colors group-hover:text-coral"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {/* Named "Chats" for assistive tech at every width (visible from sm). */}
        <span className="sr-only sm:not-sr-only lg:sr-only 2xl:not-sr-only">Chats</span>
        {history.length > 0 && (
          <span className="rounded-full bg-surface-card px-1.5 py-px text-[10px] text-muted">
            {history.length}
          </span>
        )}
      </button>

      {open && (
        // Phones: a full-width sheet under the header (an anchored right-0 panel
        // would hang off the left edge). sm+: anchored dropdown.
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Chat history"
          className="fixed inset-x-3 top-[4.25rem] z-40 overflow-hidden rounded-xl border border-hairline bg-canvas shadow-card animate-rise sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-80"
        >
          <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
            <span className="font-display text-base text-ink">History</span>
            <button
              type="button"
              onClick={() => {
                onNew();
                close(true);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-coral px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-coral-active"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New chat
            </button>
          </div>

          {history.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-soft">
              No saved chats yet. Your conversations appear here.
            </p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {history.map((h) => {
                const active = h.id === activeId;
                return (
                  <li key={h.id}>
                    <div
                      className={`group flex items-center gap-2 px-2 ${
                        active ? 'bg-surface-card/60' : 'hover:bg-surface-card/40'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onOpen(h.id);
                          close(true);
                        }}
                        className="min-w-0 flex-1 rounded-md px-2 py-2 text-left"
                      >
                        <span className="block truncate text-sm text-ink">
                          {h.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-soft">
                          {serviceLabel(h.service)} · {ago(h.updatedAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (armed === h.id) {
                            onDelete(h.id);
                            setArmed(null);
                          } else {
                            setArmed(h.id);
                          }
                        }}
                        aria-label={
                          armed === h.id
                            ? `Confirm delete “${h.title}”`
                            : `Delete chat “${h.title}”`
                        }
                        title={armed === h.id ? 'Tap again to delete' : 'Delete chat'}
                        // Visible on touch (no hover) and on keyboard focus;
                        // hover-revealed on pointer devices from sm up.
                        className={`inline-flex h-8 shrink-0 items-center justify-center rounded-full px-2 text-muted-soft transition-opacity hover:text-error focus-visible:opacity-100 ${
                          armed === h.id
                            ? 'bg-error/10 text-error opacity-100'
                            : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
                        }`}
                      >
                        {armed === h.id && (
                          <span className="mr-1 text-[11px] font-medium">Delete?</span>
                        )}
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default HistoryMenu;

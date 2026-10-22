'use client';

import { useEffect, useRef, useState } from 'react';

export interface SwiggyUser {
  name?: string;
  userId?: string | null;
  addressCount?: number;
  expiresAt?: number | null;
}

export interface AccountMenuProps {
  authenticated: boolean;
  user?: SwiggyUser | null;
  loading?: boolean;
  onLogin: () => void;
  onLogout: () => Promise<void>;
}

export function AccountMenu({
  authenticated,
  user,
  loading = false,
  onLogin,
  onLogout,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  // Clock snapshot taken when the menu opens (render must stay pure).
  const [openedAt, setOpenedAt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or escape key
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus(); // return focus to the trigger
      }
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Compute user initials for avatar
  const getInitials = (name?: string) => {
    if (!name) return 'SW';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // Compute human-readable expiry
  const formatExpiry = (expiresAt?: number | null) => {
    if (!expiresAt) return null;
    const diffMs = expiresAt - openedAt;
    if (diffMs <= 0) return 'Expired';
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `Active (${days}d ${hours}h left)`;
    return `Active (${hours}h left)`;
  };

  const handleLogoutClick = async () => {
    try {
      setLoggingOut(true);
      await onLogout();
      setOpen(false);
    } finally {
      setLoggingOut(false);
    }
  };

  // While the session check runs, hold the signed-in pill's footprint so the
  // header doesn't reflow (CLS) when the avatar arrives.
  if (!authenticated && loading) {
    return (
      <span
        role="status"
        className="inline-flex h-8 w-16 items-center justify-center rounded-full border border-hairline bg-surface-card/40"
      >
        <span className="skeleton h-6 w-6 rounded-full" aria-hidden="true" />
        <span className="sr-only">Checking your Swiggy login…</span>
      </span>
    );
  }

  // Logged out:
  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={onLogin}
        disabled={loading}
        className="group relative inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-coral/60 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral transition-all duration-150 hover:-translate-y-0.5 hover:border-coral hover:bg-coral hover:text-on-primary hover:shadow-sm active:translate-y-0 disabled:opacity-50"
        title="Log into your Swiggy account"
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-coral text-[10px] text-on-primary group-hover:bg-white group-hover:text-coral transition-colors">
          ⚡
        </span>
        <span>Login with Swiggy</span>
      </button>
    );
  }

  const initials = getInitials(user?.name);
  const displayName = user?.name ? user.name.split(' ')[0] : 'Account';
  const expiryText = formatExpiry(user?.expiresAt);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpenedAt(Date.now());
          setOpen((v) => !v);
        }}
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="true"
        // Starts with the visible initials/name (WCAG 2.5.3 label-in-name).
        aria-label={`${initials} ${displayName} — Swiggy account options`}
        className={`group flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-all duration-150 ${
          open
            ? 'border-coral bg-surface-card text-ink shadow-xs'
            : 'border-hairline bg-surface-card/50 text-body hover:border-coral/50 hover:bg-surface-card hover:text-ink'
        }`}
      >
        {/* User avatar with active status dot */}
        <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-coral/90 to-coral-active font-display text-[11px] font-bold text-on-primary shadow-2xs">
          {initials}
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-canvas bg-success" />
        </div>
        {/* keeps the visible text "MO Mock" (matching the aria-label), not "MOMock" */}
        {' '}

        <span className="hidden max-w-[110px] truncate font-medium sm:inline">
          {displayName}
        </span>

        <svg
          viewBox="0 0 20 20"
          className={`h-3.5 w-3.5 text-muted transition-transform duration-200 ${
            open ? 'rotate-180 text-coral' : 'group-hover:text-ink'
          }`}
          fill="none"
          stroke="currentColor"
        >
          <path d="M6 8l4 4 4-4" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Account Popover Menu */}
      {open && (
        <div
          role="group"
          aria-label="Swiggy account"
          className="absolute right-0 top-full z-50 mt-2 w-72 origin-top-right rounded-2xl border border-hairline bg-surface-card/95 p-3.5 text-xs shadow-card backdrop-blur-md transition-all animate-in fade-in zoom-in-95 duration-150"
        >
          {/* User profile card */}
          <div className="flex items-start gap-3 border-b border-hairline/70 pb-3">
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-coral to-coral-active font-display text-sm font-bold text-on-primary shadow-xs" aria-hidden="true">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-ink text-[13px]">
                  {user?.name || 'Swiggy Member'}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                {user?.addressCount ? `${user.addressCount} saved addresses` : 'Connected via Swiggy MCP'}
              </p>
              {expiryText && (
                <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success-ink">
                  <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                  {expiryText}
                </div>
              )}
            </div>
          </div>

          {/* Account Actions */}
          <div className="mt-2 space-y-1">
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                try {
                  await onLogout();
                } catch {
                  // ignore
                }
                window.location.href = '/api/auth/login?prompt=login';
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-body transition-colors hover:bg-cream-strong hover:text-ink"
            >
              <span className="text-sm" aria-hidden="true">🔄</span>
              <div className="flex flex-col">
                <span className="font-medium text-ink">Switch Swiggy Account</span>
                <span className="text-[10px] text-muted">Sign in with another mobile number</span>
              </div>
            </button>

            <button
              type="button"
              onClick={handleLogoutClick}
              disabled={loggingOut}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-error transition-colors hover:bg-error/10 disabled:opacity-50"
            >
              <span className="text-sm" aria-hidden="true">🚪</span>
              <div className="flex flex-col">
                <span className="font-medium">
                  {loggingOut ? 'Logging out…' : 'Log Out'}
                </span>
                <span className="text-[10px] text-error">Disconnect your Swiggy session</span>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountMenu;

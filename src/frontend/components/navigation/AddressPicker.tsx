'use client';

import { useEffect, useRef, useState } from 'react';
import type { Address } from '@/shared/types';

export interface AddressPickerProps {
  addresses: Address[];
  selectedAddressId: string;
  onSelectAddress: (id: string) => void;
  onAddNewAddress?: () => void;
  // called after Swiggy deleted an address (delete_address, user-confirmed)
  onAddressDeleted?: (id: string) => void;
}

export function AddressPicker({
  addresses,
  selectedAddressId,
  onSelectAddress,
  onAddNewAddress,
  onAddressDeleted,
}: AddressPickerProps) {
  const [open, setOpen] = useState(false);
  // delete flow: which row asks "Delete this address?", in-flight id, last message
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const deleteAddress = async (id: string) => {
    setDeletingId(id);
    setDeleteMsg(null);
    try {
      const res = await fetch(`/api/addresses/create?addressId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && data.ok) {
        onAddressDeleted?.(id);
        setDeleteMsg(data.message || 'Address deleted.');
      } else {
        setDeleteMsg(
          res.status === 401 ? 'Your Swiggy session expired — please log in again.' : data.message || 'Swiggy could not delete this address.',
        );
      }
    } catch {
      setDeleteMsg('Could not reach the server.');
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  };
  const ref = useRef<HTMLDivElement>(null);

  const selected = addresses.find((a) => a.id === selectedAddressId) || addresses[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`group flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-all ${
          open
            ? 'border-coral/70 bg-surface-card text-ink shadow-xs'
            : 'border-hairline bg-surface-card/40 text-body hover:border-coral/40 hover:bg-surface-card/80 hover:text-ink'
        }`}
      >
        <span className="shrink-0 text-coral" aria-hidden="true">📍</span>
        <span className="min-w-0 max-w-[130px] truncate font-medium sm:max-w-[190px] md:max-w-[240px]">
          <span className="sr-only">Delivery address: </span>
          {selected
            ? `${selected.addressTag ? `${selected.addressTag} · ` : ''}${selected.addressLine}`
            : 'Select delivery address'}
        </span>
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200 ${
            open ? 'rotate-180 text-coral' : 'group-hover:text-ink'
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-40 w-72 max-w-[90vw] overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-card animate-rise sm:w-80">
          <div className="border-b border-hairline px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-display text-sm font-medium text-ink">Delivery Location</span>
              <span className="text-[11px] text-muted-soft">{addresses.length} saved</span>
            </div>
            <p className="mt-0.5 text-xs text-muted">Items & restaurants update for your chosen area</p>
          </div>

          {addresses.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-soft">
              No saved addresses yet. Add one to start shopping.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto p-1.5">
              {addresses.map((addr) => {
                const active = addr.id === selectedAddressId;
                return (
                  <div key={addr.id} className="group/row relative">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectAddress(addr.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition-all ${
                      active
                        ? 'bg-coral/5 text-ink'
                        : 'text-body hover:bg-surface-card/60 hover:text-ink'
                    }`}
                  >
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                      active ? 'bg-coral text-on-primary' : 'bg-surface-card text-muted'
                    }`}>
                      📍
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {addr.addressTag && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            active ? 'bg-coral/15 text-coral-active' : 'bg-surface-card text-muted'
                          }`}>
                            {addr.addressTag}
                          </span>
                        )}
                        {addr.addressCategory && (
                          <span className="text-[11px] text-muted-soft">
                            · {addr.addressCategory}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-body">
                        {addr.addressLine}
                      </p>
                      {/* Swiggy sends the contact number already masked ("****6256") */}
                      {addr.phoneNumber && (
                        <p className="mt-0.5 text-[11px] tabular-nums text-muted-soft">📞 {addr.phoneNumber}</p>
                      )}
                    </div>
                    {active && (
                      <span className="shrink-0 text-sm font-bold text-coral">✓</span>
                    )}
                  </button>
                  {onAddressDeleted && confirmId !== addr.id && (
                    <button
                      type="button"
                      onClick={() => setConfirmId(addr.id)}
                      disabled={deletingId !== null}
                      aria-label={`Delete address ${addr.addressTag || addr.addressLine}`}
                      className="absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-[10px] font-semibold text-muted-soft opacity-0 transition-opacity hover:text-red-600 focus:opacity-100 group-hover/row:opacity-100 disabled:opacity-40"
                    >
                      {deletingId === addr.id ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                  {confirmId === addr.id && (
                    <div className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-[11px] text-body">
                      <span>Delete this address from your Swiggy account?</span>
                      <span className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => deleteAddress(addr.id)}
                          className="rounded-full bg-red-600 px-2 py-0.5 font-semibold text-white hover:bg-red-700"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-full border border-hairline px-2 py-0.5 font-semibold text-body hover:text-ink"
                        >
                          Keep
                        </button>
                      </span>
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          )}

          {deleteMsg && (
            <p role="status" className="border-t border-hairline px-4 py-2 text-[11px] text-muted">
              {deleteMsg}
            </p>
          )}

          {onAddNewAddress && (
            <div className="border-t border-hairline p-2 bg-surface-card/30">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAddNewAddress();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-coral/40 py-2 text-xs font-semibold text-coral hover:border-coral hover:bg-coral/5 transition-all"
              >
                <span>+</span>
                <span>Add New Address</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AddressPicker;

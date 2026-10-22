'use client';

// Create Address Modal for adding a delivery location directly from Swizzo UI.
// Calls /api/addresses/create which forwards to Swiggy's create_address tool.
// Per the tool contract the user gives the FULL address, their name + phone,
// the address type and (optionally) a label / receiver; we parse addressLine,
// city, PIN and locality out of the full address ourselves and only show the
// parsed city / PIN as editable fields so a mis-parse can be corrected.

import { useMemo, useRef, useState } from 'react';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import type { Address } from '@/shared/types';

export interface CreateAddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddressCreated: (address: Address) => void;
}

type Category = 'HOME' | 'WORK' | 'OFFICE' | 'FRIENDS_AND_FAMILY' | 'OTHER';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'HOME', label: '🏠 Home' },
  { id: 'WORK', label: '💼 Work' },
  { id: 'OFFICE', label: '🏢 Office' },
  { id: 'FRIENDS_AND_FAMILY', label: '👪 Family' },
  { id: 'OTHER', label: '📍 Other' },
];

/** Best-effort split of a free-text Indian address into create_address parts. */
function parseAddress(full: string): {
  addressLine: string;
  locality: string;
  city: string;
  postalCode: string;
} {
  const pin = full.match(/\b(\d{6})\b/)?.[1] ?? '';
  const parts = full
    .replace(/\b\d{6}\b/, '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    // drop a trailing state / country segment
    .filter((p, i, arr) => !(i === arr.length - 1 && /^(india|karnataka|maharashtra|tamil nadu|telangana|delhi|kerala|west bengal|gujarat|haryana|uttar pradesh)$/i.test(p)));
  const city = parts.length > 1 ? parts[parts.length - 1] : '';
  const locality = parts.length > 2 ? parts[parts.length - 2] : '';
  const lineParts = parts.slice(0, Math.max(1, parts.length - (locality ? 2 : city ? 1 : 0)));
  return { addressLine: lineParts.join(', '), locality, city, postalCode: pin };
}

const INPUT =
  'w-full rounded-xl border border-hairline bg-surface-card/30 px-3.5 py-2 text-xs text-ink placeholder:text-muted-soft focus:border-coral focus:outline-hidden';

export function CreateAddressModal({
  isOpen,
  onClose,
  onAddressCreated,
}: CreateAddressModalProps) {
  const [category, setCategory] = useState<Category>('HOME');
  const [fullAddress, setFullAddress] = useState('');
  const [flatNo, setFlatNo] = useState('');
  const [addressTag, setAddressTag] = useState('');
  const [userName, setUserName] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [forSomeoneElse, setForSomeoneElse] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [cityEdit, setCityEdit] = useState<string | null>(null);
  const [pinEdit, setPinEdit] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseAddress(fullAddress), [fullAddress]);
  const city = cityEdit ?? parsed.city;
  const postalCode = pinEdit ?? parsed.postalCode;
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(isOpen, dialogRef, submitting ? undefined : onClose);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!fullAddress.trim()) return setError('Please enter your complete address');
    if (!userName.trim() || !/^\d{10}$/.test(userPhone.trim())) {
      return setError('Enter your name and 10-digit phone number');
    }
    if (!city.trim() || !/^\d{6}$/.test(postalCode.trim())) {
      return setError('Check the city and 6-digit PIN code');
    }
    if (forSomeoneElse && (!receiverName.trim() || !/^\d{10}$/.test(receiverPhone.trim()))) {
      return setError("Enter the receiver's name and 10-digit phone number");
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/addresses/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullAddress: [flatNo.trim(), fullAddress.trim()].filter(Boolean).join(', '),
          addressLine: parsed.addressLine || fullAddress.trim(),
          addressLine2: flatNo.trim(),
          locality: parsed.locality || undefined,
          city: city.trim(),
          postalCode: postalCode.trim(),
          addressCategory: category,
          addressTag: addressTag.trim() || undefined,
          userName: userName.trim(),
          userPhone: userPhone.trim(),
          receiverName: forSomeoneElse ? receiverName.trim() : undefined,
          receiverPhone: forSomeoneElse ? receiverPhone.trim() : undefined,
        }),
      });
      const data: { ok?: boolean; address?: Address; message?: string } = await res
        .json()
        .catch(() => ({}));
      if (res.ok && data.ok && data.address) {
        onAddressCreated(data.address);
        onClose();
      } else if (res.status === 401) {
        setError('Your Swiggy session expired — please log in again.');
      } else {
        setError(data.message || 'Swiggy could not save this address.');
      }
    } catch {
      setError('Network error while saving address. Check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-address-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close modal"
        tabIndex={-1}
        onClick={submitting ? undefined : onClose}
        className="absolute inset-0 bg-ink/60 backdrop-blur-sm transition-opacity"
      />

      <div className="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-3xl border border-hairline bg-canvas shadow-2xl animate-rise">
        <div className="border-b border-hairline bg-surface-card/60 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-coral/10 text-coral text-sm">
              📍
            </span>
            <div>
              <h3 id="create-address-title" className="font-display text-base font-bold text-ink">Add Delivery Address</h3>
              <p className="text-[11px] text-muted">Saved to your Swiggy account (Food & Instamart)</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full p-1.5 text-muted hover:bg-surface-card hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div role="alert" className="rounded-xl bg-rose-500/10 p-3 text-xs text-rose-700 font-medium">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
              Address type
            </label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                    category === c.id
                      ? 'border-coral bg-coral/10 text-coral shadow-xs'
                      : 'border-hairline bg-surface-card/40 text-muted hover:text-ink'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-body mb-1">
              Complete address <span className="text-coral">*</span>
            </label>
            <textarea
              rows={2}
              required
              value={fullAddress}
              onChange={(e) => setFullAddress(e.target.value)}
              placeholder="e.g., 12, 4th Cross, 1st Block, Koramangala, Bengaluru 560034"
              className={`${INPUT} py-2.5`}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <label className="block text-xs font-medium text-body mb-1">Flat / floor</label>
              <input type="text" value={flatNo} onChange={(e) => setFlatNo(e.target.value)} placeholder="Apt 402" className={INPUT} />
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-body mb-1">City *</label>
              <input type="text" value={city} onChange={(e) => setCityEdit(e.target.value)} placeholder="Bengaluru" className={INPUT} />
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-body mb-1">PIN *</label>
              <input type="text" inputMode="numeric" maxLength={6} value={postalCode} onChange={(e) => setPinEdit(e.target.value.replace(/\D/g, ''))} placeholder="560034" className={INPUT} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-body mb-1">Your name *</label>
              <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Name" className={INPUT} />
            </div>
            <div>
              <label className="block text-xs font-medium text-body mb-1">Your phone *</label>
              <input type="tel" inputMode="numeric" maxLength={10} value={userPhone} onChange={(e) => setUserPhone(e.target.value.replace(/\D/g, ''))} placeholder="10-digit mobile" className={INPUT} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-body mb-1">Label (optional)</label>
            <input type="text" value={addressTag} onChange={(e) => setAddressTag(e.target.value)} placeholder="e.g., Mom's place" className={INPUT} />
          </div>

          <label className="flex items-center gap-2 text-xs text-body">
            <input type="checkbox" checked={forSomeoneElse} onChange={(e) => setForSomeoneElse(e.target.checked)} />
            Delivering to someone else
          </label>
          {forSomeoneElse && (
            <div className="grid grid-cols-2 gap-3">
              <input type="text" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} placeholder="Receiver name" className={INPUT} />
              <input type="tel" inputMode="numeric" maxLength={10} value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value.replace(/\D/g, ''))} placeholder="Receiver phone" className={INPUT} />
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-coral py-3 text-xs font-semibold text-on-primary shadow-xs hover:bg-coral-active transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Saving to Swiggy...</span>
                </>
              ) : (
                <span>Save Address & Set as Delivery Location</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CreateAddressModal;

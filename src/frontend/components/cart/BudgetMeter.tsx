'use client';

// A compact budget gauge that lives INSIDE the dark navy cart footer: a labelled
// row, a rounded progress track, and a teal "left" / amber "over budget" readout.
// When the spend runs over and a trim handler is supplied, a quiet "Trim to fit"
// button lets the concierge prune the cart back under the cap.

export interface BudgetMeterProps {
  budget: number;
  spent: number;
  onTrim?: () => void;
  // "Trim to fit" fires a real agent turn — gate it while one is already
  // streaming so it can't silently no-op.
  disabled?: boolean;
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function BudgetMeter({ budget, spent, onTrim, disabled }: BudgetMeterProps) {
  if (budget <= 0) return null;

  const over = spent > budget;
  const pct = Math.min(100, (spent / budget) * 100);

  return (
    <div className="text-on-dark">
      <div className="flex items-center justify-between text-sm">
        <span className="text-on-dark-soft">Budget</span>
        <span className="text-on-dark">{inr(budget)}</span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-on-dark-soft/15">
        <div
          className={`h-full rounded-full transition-[width] ${
            over ? 'bg-accent-amber' : 'bg-coral'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        {over ? (
          <span className="text-xs text-accent-amber">
            {inr(spent - budget)} over budget
          </span>
        ) : (
          <span className="text-xs text-accent-teal">
            {inr(budget - spent)} left
          </span>
        )}

        {over && onTrim && (
          <button
            type="button"
            onClick={onTrim}
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-on-dark-soft/25 px-2.5 py-1 text-xs font-medium text-on-dark transition-colors hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M20 4 8.12 15.88" />
              <path d="M14.47 14.48 20 20" />
              <path d="M8.12 8.12 12 12" />
            </svg>
            Trim to fit
          </button>
        )}
      </div>
    </div>
  );
}

export default BudgetMeter;

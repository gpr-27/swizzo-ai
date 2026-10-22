'use client';

// A compact daily-macros meter. Two tiny labelled bars — calories and protein —
// each a rounded track with a coral fill clamped to 100%. It consumes the
// per-order macros the hook aggregates from the agent's `MACRO:` markers
// (foodMacros). Swiggy returns no nutrition data, so these are the AI's
// ESTIMATES and are labelled as such. When goals are set but no macro data has landed yet it shows a
// gentle CTA instead of silently rendering 0/goal, so it never looks broken.
//
// `tone` lets it live on the dark navy cart footer (default) OR on a cream
// surface (the NutritionPanel) without restyling at the call site.

export interface MacroMeterProps {
  kcalGoal: number;
  proteinGoal: number;
  kcal: number;
  protein: number;
  tone?: 'dark' | 'light';
  // when true (cart has items) but no macros are known yet, show the CTA copy
  hasItems?: boolean;
}

function pct(value: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(100, (value / goal) * 100);
}

export function MacroMeter({
  kcalGoal,
  proteinGoal,
  kcal,
  protein,
  tone = 'dark',
  hasItems,
}: MacroMeterProps) {
  if (kcalGoal <= 0 && proteinGoal <= 0) return null;

  const light = tone === 'light';
  const labelCls = light ? 'text-muted' : 'text-on-dark-soft';
  const valueCls = light ? 'text-ink' : 'text-on-dark';
  const trackCls = light ? 'bg-surface-card' : 'bg-on-dark-soft/15';
  const noData = kcal <= 0 && protein <= 0;

  // No macros captured yet — nudge instead of showing a deadpan 0/goal.
  if (noData) {
    return (
      <div
        className={`rounded-md border border-dashed px-3 py-2.5 text-[11px] leading-snug ${
          light
            ? 'border-hairline text-muted'
            : 'border-on-dark-soft/25 text-on-dark-soft'
        }`}
      >
        <span className={`font-medium ${light ? 'text-ink' : 'text-on-dark'}`}>
          No nutrition read yet
        </span>
        <br />
        {hasItems
          ? 'Run a “Nutrition breakdown” for an AI estimate of calories & protein vs your goals.'
          : 'Add a few dishes, then I’ll track them against your daily goals.'}
      </div>
    );
  }

  return (
    <div className="space-y-2" title="AI estimates from dish names — Swiggy doesn't publish nutrition">
      {kcalGoal > 0 && (
        <div>
          <div className="flex items-baseline justify-between text-[11px] leading-none">
            <span className={labelCls}>Calories (est.)</span>
            <span className={valueCls}>
              ~{Math.round(kcal)} / {kcalGoal} kcal
            </span>
          </div>
          <div className={`mt-1 h-1 overflow-hidden rounded-full ${trackCls}`}>
            <div
              className="h-full rounded-full bg-coral transition-[width]"
              style={{ width: `${pct(kcal, kcalGoal)}%` }}
            />
          </div>
        </div>
      )}

      {proteinGoal > 0 && (
        <div>
          <div className="flex items-baseline justify-between text-[11px] leading-none">
            <span className={labelCls}>Protein (est.)</span>
            <span className={valueCls}>
              ~{Math.round(protein)} / {proteinGoal} g
            </span>
          </div>
          <div className={`mt-1 h-1 overflow-hidden rounded-full ${trackCls}`}>
            <div
              className="h-full rounded-full bg-coral transition-[width]"
              style={{ width: `${pct(protein, proteinGoal)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default MacroMeter;

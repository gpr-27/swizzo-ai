// After chat / an AI pick fills a picker: bring the chosen date chip into view
// inside its horizontal strip, then land the page on the picker's main button
// (Confirm / Review) so the user sees the result without hunting for it.
export function revealPick(root: HTMLElement | null): void {
  if (!root) return;
  // wait for the selection to render
  window.setTimeout(() => {
    root.querySelectorAll<HTMLElement>('[data-picked="true"]').forEach((chip) => {
      const strip = chip.parentElement;
      if (strip && strip.scrollWidth > strip.clientWidth) {
        strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
      }
    });
    const cta = root.querySelector<HTMLElement>('[data-picker-cta]');
    (cta ?? root).scrollIntoView({ behavior: 'smooth', block: cta ? 'end' : 'center' });
  }, 80);
}

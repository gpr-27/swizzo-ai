// Mobile = UPI intent apps, desktop = scan-QR (platform.md §6: detect, never ask).
// A UPI app link (intentApp) can only open on a phone; on a laptop it does nothing.
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(pointer: coarse)').matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}

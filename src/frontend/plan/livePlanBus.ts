// Tiny client bus between the chat's compact ItineraryCard and the page's
// live plan panel (right tray / mobile drawer), so the card needs no props
// threaded through ChatThread → MessageBubble.

type Cmd = 'open' | 'run';
const listeners = new Set<(cmd: Cmd) => void>();

export function onLivePlan(fn: (cmd: Cmd) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Focus the live plan panel (opens the drawer on mobile). */
export function openLivePlan(): void {
  listeners.forEach((fn) => fn('open'));
}

/** Start the autonomous run (and focus the panel). */
export function runLivePlan(): void {
  listeners.forEach((fn) => fn('run'));
}

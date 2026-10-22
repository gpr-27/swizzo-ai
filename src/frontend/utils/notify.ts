// In-app toasts + (opt-in) browser notifications for live status changes
// (an active Food / Instamart order or a booking changing status while a card
// polls). A tiny event bus: notify() → <Toaster/> renders it; when the user
// granted Notification permission and the tab is hidden, a system
// notification is shown too.

export interface ToastInput {
  title: string;
  body?: string;
  tone?: 'info' | 'success' | 'warn' | 'error';
  /** also raise a browser Notification when permitted (default true) */
  system?: boolean;
  /** de-dupe key: the same key within 10 s is dropped */
  key?: string;
}

export interface Toast extends ToastInput {
  id: number;
}

type Listener = (t: Toast) => void;
const listeners = new Set<Listener>();
const recent = new Map<string, number>();
let seq = 0;

export function onToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notify(input: ToastInput): void {
  const now = Date.now();
  if (input.key) {
    const last = recent.get(input.key);
    if (last && now - last < 10_000) return;
    recent.set(input.key, now);
  }
  const toast: Toast = { ...input, id: ++seq };
  for (const fn of listeners) fn(toast);
  if (input.system !== false) systemNotify(input.title, input.body);
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Ask once (from a user gesture). Resolves to the resulting permission. */
export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function systemNotify(title: string, body?: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  // The in-app toast already covers a visible tab.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    new Notification(title, { body, icon: '/favicon.ico', tag: `swizzo-${title}` });
  } catch {
    // some mobile browsers only allow notifications from a service worker
  }
}

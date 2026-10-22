// Wire shapes for GET/PUT/DELETE /api/me/state — the server copy of what the
// browser keeps in localStorage (bookings, chat sessions, preferences, Plan
// runs). Every record carries `updatedAt` (epoch ms); on conflict the newer
// one wins, ties go to the server. See docs/DATABASE.md.

export type SyncBookingKind = "dineout" | "scenes";

export interface SyncBooking {
  kind: SyncBookingKind;
  orderId: string;
  title: string;
  details?: string;
  restaurantId?: string;
  eventId?: string;
  /** Reservation / show start, epoch ms. */
  startsAt?: number;
  party?: number;
  amount?: number;
  lat?: number;
  lng?: number;
  /** Last live status seen (get_booking_status / get_event_booking_status). */
  status?: string;
  statusAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SyncSession {
  id: string;
  title: string;
  service: string;
  updatedAt: number;
  /** The client's ChatMessage[] JSON, verbatim (bounded server-side). */
  messages: unknown[];
  /** Tombstone: deleted on some device. `messages` is empty. */
  deleted?: boolean;
}

export interface SyncPreferencesData {
  preferences: string;
  allergies: string;
  budget: number;
  kcalGoal: number;
  proteinGoal: number;
}

export interface SyncPreferences {
  data: SyncPreferencesData;
  updatedAt: number;
}

export interface SyncPlanRun {
  sessionId: string;
  run: unknown;
  updatedAt: number;
}

export interface MeStateResponse {
  /** false → no database on this server; the client stays localStorage-only. */
  enabled: boolean;
  authenticated?: boolean;
  /** Opaque per-account tag (hash), so a browser can tell accounts apart. */
  account?: string;
  /** Server clock (epoch ms) — pass back as `?since=` for an incremental pull. */
  serverTime?: number;
  bookings?: SyncBooking[];
  sessions?: SyncSession[];
  preferences?: SyncPreferences | null;
  planRuns?: SyncPlanRun[];
}

export interface MeStatePut {
  bookings?: SyncBooking[];
  sessions?: SyncSession[];
  preferences?: SyncPreferences;
  planRuns?: SyncPlanRun[];
}

/** Bounds shared by the client (what it sends) and the server (what it keeps). */
export const SYNC_LIMITS = {
  bookings: 100,
  sessions: 60,
  /** Sessions per PUT — keeps each request well under Vercel's 4.5 MB body cap. */
  sessionsPerPut: 8,
  messagesPerSession: 300,
  /** Bytes of JSON per message; larger ones (e.g. inline photos) are stubbed. */
  messageBytes: 200_000,
  sessionBytes: 1_500_000,
  planRuns: 60,
  planRunBytes: 200_000,
  textField: 2_000,
} as const;

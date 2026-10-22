// Server-only configuration: Swiggy MCP endpoints, the per-user bearer token,
// default address and model settings. Never import this from a client component.
//
// The Swiggy token is resolved ONLY from the requesting user's encrypted session
// cookie (see ./session.ts). There is deliberately no shared fallback token —
// one user must never act on another user's Swiggy account.

import { getActiveSession } from "./session";

export class AuthError extends Error {
  constructor(message = "Swiggy session expired — please log in again.") {
    super(message);
    this.name = "AuthError";
  }
}

export function isAuthError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (record.name === "AuthError") return true;
    if (record.code === 401 || record.code === 419) return true;
    if (
      typeof record.message === "string" &&
      /invalid_token|jwt has expired|authentication required/i.test(record.message)
    ) {
      return true;
    }
  }
  return false;
}

// SWIGGY_MCP_BASE lets staging (https://mcp-staging.swiggy.com) be swapped in.
const SWIGGY_MCP_BASE = (process.env.SWIGGY_MCP_BASE?.trim() || "https://mcp.swiggy.com").replace(/\/+$/, "");
export const SWIGGY_IM_MCP_URL = `${SWIGGY_MCP_BASE}/im`;
export const SWIGGY_FOOD_MCP_URL = `${SWIGGY_MCP_BASE}/food`;
export const SWIGGY_DINEOUT_MCP_URL = `${SWIGGY_MCP_BASE}/dineout`;
export const SWIGGY_SCENES_MCP_URL = `${SWIGGY_MCP_BASE}/scenes`;
export const SWIGGY_SERVER_NAME = "swiggy-instamart";

/**
 * The current user's Swiggy access token, from their encrypted session cookie.
 * Proactively refreshed when ≤ 60 s remain. Null when logged out / expired.
 */
export async function getSwiggyToken(): Promise<string | null> {
  const session = await getActiveSession();
  return session?.accessToken ?? null;
}

/**
 * Force a refresh-token exchange (after a 401 / -32001). Returns the new access
 * token, or null when the grant is dead and the user must authorize again.
 */
export async function refreshSwiggyToken(): Promise<string | null> {
  const session = await getActiveSession({ forceRefresh: true });
  return session?.accessToken ?? null;
}

/** Authorization header for direct MCP HTTP calls. */
export async function swiggyAuthHeaders(): Promise<Record<string, string>> {
  const token = await getSwiggyToken();
  if (!token) {
    throw new AuthError();
  }
  return { Authorization: `Bearer ${token}` };
}

/** Real order placement / confirm_order is enabled only when SWIGGY_ENABLE_ORDERS=true. */
export function ordersEnabled(): boolean {
  return process.env.SWIGGY_ENABLE_ORDERS?.trim() === "true";
}

// AgentRouter (AXON) configuration for DeepSeek and compatible models
export const AXON_API_KEY =
  process.env.AXON_API_KEY?.trim() ||
  process.env.AGENTROUTER_API_KEY?.trim() ||
  "";

export const AXON_BASE_URL = (
  process.env.AXON_BASE_URL?.trim() || "https://agentrouter.org"
).replace(/\/+$/, "");

export const AXON_BACKUP_BASE_URL = "https://ps.air-outer.com";

export const AXON_MODEL =
  process.env.AXON_MODEL?.trim() || "deepseek-v4-flash";

export const AXON_AVAILABLE_MODELS: string[] = (
  process.env.AXON_AVAILABLE_MODELS ||
  "deepseek-v4-flash,gpt-5.6-sol,gpt-6-astra,claude-opus-5,claude-opus-4-8"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Gemini backend configuration for multimodal image reading / vision turns
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";

// Optional default address (env only) for single-user local setups. Empty when
// unset — callers must use the address the user actually selected.
export const DEFAULT_ADDRESS_ID = process.env.SWIGGY_DEFAULT_ADDRESS_ID?.trim() || "";

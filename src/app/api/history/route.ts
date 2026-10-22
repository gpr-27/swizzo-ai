// GET /api/history?addressId= — the History page ("Orders") in one request.
// Read-only. Food (get_food_orders, up to 15 across all addresses) and
// Instamart (get_orders, last 15 days; default DASH + "INSTAMART" order types,
// merged) load in parallel and fail independently: each section is either
// { ok, orders } or { ok:false, error, needsLogin? } with Swiggy's own message.
// Both sections 401 → HTTP 401 { needsLogin }. Dineout / Scenes have no list
// tool, so the page reads the bookings this app saved and asks /api/bookings.

import { MCP_SERVERS } from "@/backend/agent/services";
import { isAuthError } from "@/backend/config/env";
import { callToolData, isRecord } from "@/backend/mcp/client";
import { getFoodOrders } from "@/backend/mcp/food-mcp";
import { getAddresses } from "@/backend/mcp/swiggy-mcp";
import {
  dedupeOrders,
  mapFoodHistory,
  mapInstamartHistory,
  type HistoryResponse,
  type HistorySection,
} from "@/backend/history/history-map";
import { route } from "@/backend/http/route";
import { AddressOnlyQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOGIN_MSG = "Your Swiggy session expired — please log in again.";

function failed(err: unknown, what: string): HistorySection {
  if (isAuthError(err)) return { ok: false, needsLogin: true, error: LOGIN_MSG };
  console.error(`[api/history] ${what} failed:`, err);
  return {
    ok: false,
    error: err instanceof Error && err.message ? err.message : `Couldn't load your ${what} orders.`,
  };
}

async function foodSection(addressIdIn: string): Promise<HistorySection> {
  try {
    // get_food_orders needs an addressId only to resolve coordinates — it does
    // not filter the history. Fall back to the first saved address.
    const addressId = addressIdIn || (await getAddresses())[0]?.id || "";
    if (!addressId) {
      return { ok: false, error: "Add a delivery address on Swiggy to load your Food orders." };
    }
    const orders = await getFoodOrders(addressId, { orderCount: 15 });
    return { ok: true, orders: mapFoodHistory(orders) };
  } catch (err) {
    return failed(err, "Food");
  }
}

async function instamartList(orderType?: string): Promise<unknown[]> {
  const args: Record<string, unknown> = { count: 20 };
  if (orderType) args.orderType = orderType;
  const data = await callToolData(MCP_SERVERS.instamart.url, "get_orders", args);
  return isRecord(data) && Array.isArray(data.orders) ? data.orders : [];
}

async function instamartSection(): Promise<HistorySection> {
  const [dash, im] = await Promise.allSettled([instamartList(), instamartList("INSTAMART")]);
  if (dash.status === "rejected") {
    // The default list failed; the secondary type alone is still worth showing.
    if (im.status === "fulfilled" && !isAuthError(dash.reason)) {
      return { ok: true, orders: mapInstamartHistory(im.value) };
    }
    return failed(dash.reason, "Instamart");
  }
  const lists = [dash.value, ...(im.status === "fulfilled" ? [im.value] : [])];
  return {
    ok: true,
    orders: mapInstamartHistory(dedupeOrders(lists)),
    note: "Swiggy only shares the last 15 days of Instamart orders.",
  };
}

export const GET = route({ name: "api/history", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = (new URL(request.url).searchParams.get("addressId") || "").trim().slice(0, 128);
  const [food, instamart] = await Promise.all([foodSection(addressId), instamartSection()]);
  const body: HistoryResponse = { food, instamart, fetchedAt: Date.now() };
  const bothLogin = !food.ok && food.needsLogin && !instamart.ok && instamart.needsLogin;
  if (bothLogin) {
    return Response.json({ ...body, needsLogin: true, message: LOGIN_MSG }, { status: 401 });
  }
  return Response.json(body);
});

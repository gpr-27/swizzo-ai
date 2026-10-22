// POST /api/report-error { service, tool, errorMessage, flowDescription?, toolContext?, userNotes?, reportId? }
// → report_error on that service's Swiggy MCP server (it exists on all four).
// Only on an explicit "Report a problem" tap by the user. Swiggy logs the
// report server-side and returns { reportLink (mailto:), supportEmail, summary }
// so the user can also send it by email. Never auto-retried (client.ts).

import { MCP_SERVERS } from "@/backend/agent/services";
import { isAuthError } from "@/backend/config/env";
import { callToolData, isRecord, str } from "@/backend/mcp/client";
import { DOMAIN_SERVICES, type DomainService } from "@/shared/types";
import { route } from "@/backend/http/route";
import { ReportErrorBody } from "@/backend/http/schemas";
import { isSensitiveKey, redactText } from "@/backend/security/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything forwarded to Swiggy is redacted first: no tokens, phone numbers or e-mails
// (users paste them into notes / they appear in error text).
const clip = (v: unknown, max: number) => (typeof v === "string" ? redactText(v.trim()).slice(0, max) : "");

export const POST = route({ name: "api/report-error", rateLimit: "mutate", body: ReportErrorBody }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const service = body.service as DomainService;
  if (!DOMAIN_SERVICES.includes(service)) {
    return Response.json({ ok: false, message: "Unknown service." }, { status: 400 });
  }
  const tool = clip(body.tool, 64);
  const errorMessage = clip(body.errorMessage, 500);
  if (!tool || !errorMessage) {
    return Response.json({ ok: false, message: "tool and errorMessage are required." }, { status: 400 });
  }

  // toolContext: string → string only (ids from the failed request), plus the
  // reportId Swiggy attached to the error, when there was one.
  const toolContext: Record<string, string> = {};
  if (isRecord(body.toolContext)) {
    for (const [k, v] of Object.entries(body.toolContext).slice(0, 20)) {
      if (isSensitiveKey(k)) continue; // names, phones, addresses, coordinates, tokens
      if (typeof v === "string" && v) toolContext[k.slice(0, 40)] = redactText(v).slice(0, 120);
      else if (typeof v === "number" && Number.isFinite(v)) toolContext[k.slice(0, 40)] = String(v);
    }
  }
  const reportId = clip(body.reportId, 80);
  if (reportId) toolContext.reportId = reportId;

  const domain = service === "instamart" ? "im" : service;
  const args: Record<string, unknown> = { tool, errorMessage, domain };
  const flow = clip(body.flowDescription, 300);
  const notes = clip(body.userNotes, 500);
  if (flow) args.flowDescription = flow;
  if (notes) args.userNotes = notes;
  if (Object.keys(toolContext).length) args.toolContext = toolContext;

  try {
    const data = await callToolData(MCP_SERVERS[service].url, "report_error", args);
    const d = isRecord(data) ? data : {};
    const reportLink = str(d.reportLink);
    return Response.json({
      ok: true,
      // Only a mailto: link is ever rendered as a link.
      reportLink: reportLink.startsWith("mailto:") ? reportLink : undefined,
      supportEmail: str(d.supportEmail) || undefined,
      summary: str(d.summary) || str(d.text) || "Report sent to the Swiggy MCP team.",
    });
  } catch (err) {
    if (isAuthError(err)) {
      return Response.json({ ok: false, auth: true, message: "Your Swiggy session expired — please log in again." }, { status: 401 });
    }
    console.error("[api/report-error] failed:", err);
    return Response.json(
      { ok: false, message: err instanceof Error && err.message ? err.message : "Couldn't send the report." },
      { status: 502 },
    );
  }
});

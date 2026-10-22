// Stand-in for @modelcontextprotocol/sdk's Client — the MCP boundary. The app's
// own client.ts (session cache, envelope checks, retries, payload coercion)
// runs for real; only the wire is replaced by RECORDED live tool results.
// Mutating tools are refused outright, so a route test can never "place" or
// "book" anything even by accident.
import { MUTATING_TOOLS } from "@/backend/agent/services";

type ToolResult = { content?: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Responder = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

const MUTATING = new Set(Object.values(MUTATING_TOOLS).flat());

export const mcp = {
  calls: [] as { server: string; name: string; args: Record<string, unknown>; token?: string }[],
  tools: new Map<string, Responder>(),
  reset() {
    this.calls.length = 0;
    this.tools.clear();
  },
  /** respond to `name` with a recorded result (or a function of the args) */
  on(name: string, result: ToolResult | Responder) {
    this.tools.set(name, typeof result === "function" ? result : () => result);
  },
};

export class Client {
  private server = "";
  private token?: string;
  async connect(transport: { _url?: URL; _requestInit?: { headers?: Record<string, string> } }) {
    this.server = transport?._url?.href ?? "";
    this.token = transport?._requestInit?.headers?.Authorization?.replace(/^Bearer /, "");
  }
  async close() {}
  async listTools() {
    return { tools: [...mcp.tools.keys()].map((name) => ({ name, inputSchema: { type: "object" } })) };
  }
  async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
    const args = req.arguments ?? {};
    mcp.calls.push({ server: this.server, name: req.name, args, token: this.token });
    if (MUTATING.has(req.name)) throw new Error(`[tests] mutating Swiggy tool called: ${req.name}`);
    const r = mcp.tools.get(req.name);
    if (!r) throw new Error(`[tests] no recorded payload for tool ${req.name}`);
    return r(args);
  }
}

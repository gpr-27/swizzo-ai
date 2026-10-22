// Standalone smoke test: does the bearer token authenticate against the live
// Swiggy Instamart MCP server over streamable HTTP? Run: node scripts/test-mcp.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";

const token = readFileSync(new URL("../../.token", import.meta.url), "utf8").trim();
console.log("token bytes:", token.length, "starts:", token.slice(0, 8));

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.swiggy.com/im"),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
);

try {
  await client.connect(transport);
  console.log("connected ✓");
  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));
  const addr = await client.callTool({ name: "get_addresses", arguments: {} });
  const text = addr.content?.find((c) => c.type === "text")?.text ?? "";
  console.log("get_addresses ✓ ->", text.slice(0, 200));
} catch (e) {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

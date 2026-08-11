import { test, expect } from "@playwright/test";
import { API , sweepConnections} from "../helpers";

// #623: my own debris from failed runs, swept on the way IN (the cap makes leftovers block the suite).
test.beforeAll(async () => { await sweepConnections(["https://mcp592."]); });

// #592 / ADR-204 (OQ3): MCP access is a per-connection switch, and it lives IN the connection's row —
// not on a screen of its own. The row is where an admin already decides what a connection may do
// (enabled, ordering, deletion), so a second surface would be a second place to look.
//
// The switch is honest about what it can enforce: the MCP entry recognises a member's connection from
// the `wc<conn8>_` prefix on their sub, so a connection that does not namespace cannot be told apart
// there. Such a row shows the switch as unavailable with the reason beside it, rather than accepting a
// setting the server could never act on.
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };

test("#592: a connection row carries its MCP switch", async ({ page }) => {
  // A connection created through the admin surface always namespaces (#570), so its switch binds.
  const created = await fetch(`${API}/admin/connections`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      issuer: "https://mcp592.example.test", clientId: "mcp592", redirectUri: "https://mcp592.example.test/cb",
      label: "MCP 592 probe", enabled: false,
    }),
  });
  const createdBody = await created.text();
  expect(created.status, createdBody).toBe(201);
  const { id } = JSON.parse(createdBody) as { id: string };
  try {
    await page.goto("/admin/auth");
    const row = page.getByTestId(`admin-connection-${id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const mcp = page.getByTestId(`admin-connection-mcp-${id}`);
    await expect(mcp, "the switch is in the row, beside the connection's other decisions").toBeVisible();
    await expect(mcp, "default on: the control describes what was already true").toBeChecked();
    await expect(page.getByTestId(`admin-connection-mcp-note-${id}`), "this connection namespaces, so it binds").toHaveCount(0);

    // Switching it off persists — the server is the wall, this is just where you tell it.
    await mcp.click();
    await expect(async () => {
      const r = await fetch(`${API}/admin/connections`, { headers: H });
      const list = (await r.json()) as { id: string; mcpEnabled: boolean }[];
      expect(list.find((c) => c.id === id)?.mcpEnabled).toBe(false);
    }).toPass({ timeout: 8000 });
  } finally {
    await fetch(`${API}/admin/connections/${id}`, { method: "DELETE", headers: H });
  }
});

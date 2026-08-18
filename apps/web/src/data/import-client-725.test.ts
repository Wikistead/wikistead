// #725 / ADR-236 §3: the import call answers two ways, and the caller must be able to tell them apart.
//
// The shipped client returned `{ status, report }` and parsed the body as a report whenever `res.ok`
// was true. `res.ok` is true for a 202, so the queued acknowledgement (`{ importId, status,
// nodesTotal }`) was handed back AS a report — and the only caller then interpolated
// `report.pagesCreated`, which is undefined on that body. The large archives the 202 path exists for
// were exactly the ones that got a nonsense answer.
//
// These pin the discrimination itself: a 202 is a job, a 200 is a report, and neither is an error.
import { describe, it, expect, vi, afterEach } from "vitest";
import { importSpaceArchive, IMPORT_MAX_ARCHIVE_BYTES } from "./exportApi";

const file = { name: "vault.zip", size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } as unknown as File;

const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })));

afterEach(() => vi.unstubAllGlobals());

describe("#725: the import client tells a queued job from a finished report", () => {
  it("a 202 is a QUEUED job, carrying the id the screen puts in the URL", async () => {
    respond(202, { importId: "imp_1", status: "queued", nodesTotal: 900 });
    const res = await importSpaceArchive("tok", "sp1", file);
    expect(res.kind).toBe("queued");
    expect(res).toMatchObject({ importId: "imp_1", nodesTotal: 900 });
  });

  it("a 200 is the report itself", async () => {
    respond(200, { pagesCreated: 3, degraded: [], attachmentsSkipped: [] });
    const res = await importSpaceArchive("tok", "sp1", file);
    expect(res.kind).toBe("report");
    if (res.kind === "report") expect(res.report.pagesCreated).toBe(3);
  });

  it("a queued acknowledgement is never returned as a report", async () => {
    // The defect, stated as its own pin: if the 202 branch is removed, this body arrives as a report
    // whose pagesCreated is undefined, and the screen announces an import that has not run yet.
    respond(202, { importId: "imp_2", status: "queued", nodesTotal: 900 });
    const res = await importSpaceArchive("tok", "sp1", file);
    expect(res.kind).not.toBe("report");
  });

  it("each refusal keeps its status, so the screen can say which one it was", async () => {
    for (const status of [400, 403, 413]) {
      respond(status, { error: "no" });
      const res = await importSpaceArchive("tok", "sp1", file);
      expect(res).toEqual({ kind: "error", status });
    }
  });

  // #725①: 409 is not "an error" — it is a POINTER. #712put the running import's id in
  // that body, and ADR-236 §5 named "show me the one that is running" as the only useful thing the
  // screen can offer. Collapsing it into `{ kind: "error", status: 409 }` throws the id away at the
  // client, one layer below the screen, where nobody looking at the screen would find it.
  it("a 409 hands back the import that is already running", async () => {
    respond(409, { error: "already running", running: { id: "imp_9", status: "running", nodesDone: 12, nodesTotal: 900 } });
    const res = await importSpaceArchive("tok", "sp1", file);
    expect(res.kind).toBe("busy");
    if (res.kind === "busy") expect(res.running).toMatchObject({ id: "imp_9", nodesDone: 12 });
  });

  it("…and stays a refusal when that row settled before it could be read", async () => {
    // `running: null` is the honest case, not an error case: the import finished between the index
    // refusing this upload and the server reading the row back. There is nothing to walk onto.
    respond(409, { error: "already running", running: null });
    expect(await importSpaceArchive("tok", "sp1", file)).toEqual({ kind: "busy", running: null });
  });

  it("…and survives a 409 with no body at all", async () => {
    // An older server, a proxy that ate the body, a truncated response. Losing the refusal because
    // the JSON did not parse would let the screen report success-shaped nothing.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 409, ok: false, json: async () => { throw new SyntaxError("not json"); },
    })));
    expect(await importSpaceArchive("tok", "sp1", file)).toEqual({ kind: "busy", running: null });
  });

  it("a network failure is an error, not a silent success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await importSpaceArchive("tok", "sp1", file)).toEqual({ kind: "error", status: 0 });
  });

  it("the client-side size ceiling is derived from the server's body limit, not guessed", () => {
    // 280 MiB of JSON, and base64 costs a third. A ceiling larger than that would let the browser
    // spend minutes encoding an archive the server will refuse on arrival.
    expect(IMPORT_MAX_ARCHIVE_BYTES).toBeLessThan(280 * 1024 * 1024);
    expect(IMPORT_MAX_ARCHIVE_BYTES).toBeGreaterThan(200 * 1024 * 1024);
  });
});

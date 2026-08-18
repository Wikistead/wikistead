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
    for (const status of [400, 403, 409, 413]) {
      respond(status, { error: "no" });
      const res = await importSpaceArchive("tok", "sp1", file);
      expect(res).toEqual({ kind: "error", status });
    }
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

import type { EphemeralSession } from "./collab";
import { seedEphemeralBodyOnce, ephemeralBody } from "./ephemeral-island";
import { coOccupantClientIDs, type AwarenessLike } from "./macro-presence";

// #502 / ADR-184 slice 2b-2b-ii: the co-edit lifecycle CONTROLLER for ONE open text-body island — the
// orchestration brain, decoupled from the DOM. It watches co-occupancy of the island's anchor (the roster
// slice 2b-1 reads off page awareness) and drives the ephemeral-session lifecycle:
//
//   occupancy 1 → 2+ : spin up the ephemeral room (connect), seed the shared body ONCE after the room's
//                      initial sync (single-writer election — slice 2a's precondition, via onSynced), then
//                      emit `onBind(session)` so the host re-mounts the island editor onto the shared body.
//   occupancy 2+ → <2 (or dispose): flush the shared body back and emit `onUnbind(flushed)` so the host
//                      re-mounts a local editor + writes the flushed text to the canonical Y.Text, then
//                      tears the ephemeral session down.
//
// This composes the shipped, reviewed primitives (coOccupantClientIDs / seedEphemeralBodyOnce / ephemeralBody
// / EphemeralSession.onSynced). It is PURE of the DOM: `onBind`/`onUnbind` are the seam where the host does
// the actual editor re-mount (the device-visual #92-class part — a 2-client review gate). Keeping the
// DECISION logic here, unit-testable with fakes, is deliberate: the transition timing (lazy spin-up so a
// lone editor pays zero cost — ADR §3; seed AFTER sync; flush on every occupancy decrement — ADR §1) is
// exactly what has repeatedly gone wrong in this subsystem, so it is pinned in isolation.
//
// v1 note: the seed roster is sampled AT SYNC time (inside onSynced), not at spin-up — sound because each
// peer re-evaluates "am I the min?" after its OWN sync, so the true global-min clientID always seeds (and
// slice 2a's seeded-guard + empty-body-only insert are the final backstop against a near-simultaneous
// double-seed). The host owns focus/caret preservation across the bind/unbind re-mount (device-visual,
// verified on device, not here).
//
// Flush scope (v1): flush fires on the 2→<2 BOUNDARY (tearDown) and on dispose — NOT on every occupant
// decrement while still co-occupied (3→2), and there is no periodic checkpoint. That is ADR-184 open
// point 2b ("flush ownership + checkpoint cadence … deferred unless Review wants the belt-and-braces"),
// so the crash-loss window here is wider than ADR §1's ideal; tracked, wired if Review asks.

export interface CoEditDeps {
  readonly awareness: AwarenessLike;
  readonly anchor: string; // the island's macroEdit anchor (String(from)) — the co-occupancy key
  readonly fenceText: () => string; // the current island body, to seed the shared doc from
  readonly connect: () => EphemeralSession; // spin up connectEphemeral(anchor) — the ephemeral room
  readonly onBind: (session: EphemeralSession) => void; // host: re-mount the editor onto the shared body
  readonly onUnbind: (flushed: string) => void; // host: re-mount local + flush `flushed` to the canon
}

const NOOP = () => {};

export class IslandCoEditController {
  private session: EphemeralSession | null = null;
  private bound = false; // onBind has fired for the CURRENT session (guards the flush below)
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: CoEditDeps) {
    const onChange = () => this.reconcile();
    deps.awareness.on("change", onChange);
    this.unsubscribe = () => deps.awareness.off("change", onChange);
    this.reconcile(); // an island opened INTO an already-co-occupied anchor binds immediately
  }

  private coOccupied(): boolean {
    return coOccupantClientIDs(this.deps.awareness, this.deps.anchor).length >= 2;
  }

  private reconcile(): void {
    if (this.disposed) return;
    if (this.coOccupied() && !this.session) this.spinUp();
    else if (!this.coOccupied() && this.session) this.tearDown();
  }

  private spinUp(): void {
    const session = this.deps.connect();
    this.session = session;
    session.onSynced(() => {
      if (this.disposed || this.session !== session) return; // torn down while syncing → drop it
      // Seed AFTER sync (single-writer election + seeded-guard, slice 2a), then bind the editor to the body.
      const body = ephemeralBody(session.doc);
      seedEphemeralBodyOnce(
        session.doc,
        this.deps.awareness.clientID,
        coOccupantClientIDs(this.deps.awareness, this.deps.anchor),
        this.deps.fenceText(),
      );
      const bindNow = () => {
        if (this.disposed || this.session !== session) return;
        this.bound = true;
        this.deps.onBind(session);
      };
      if (body.length > 0) { bindNow(); return } // seeded (by us, or already replicated) → bind straight away
      // #502 review follow-up (a): only ONE co-occupant seeds (the lowest clientID). Everyone else can reach
      // their own `synced` BEFORE that seed replicates, and binding then hands the editor an EMPTY shared
      // body — the island shows nothing, and because blur is the commit trigger, any blur / Escape / a peer
      // leaving in that window writes the emptiness over the canonical text. The user only SAW empty; they
      // never emptied anything. So wait for the body's first content instead: the LOCAL surface keeps
      // showing the real text until then, and the swap happens with something in hand.
      const onBodyChange = () => {
        if (body.length === 0) return;
        this.clearPending();
        bindNow();
      };
      body.observe(onBodyChange);
      this.clearPending = () => { body.unobserve(onBodyChange); this.clearPending = NOOP };
    });
  }

  // Drops a pending "waiting for the seed" observer, if any. Reassigned while one is armed (above) and
  // called from tearDown/dispose so a session that dies mid-wait leaves nothing observing its doc.
  private clearPending: () => void = NOOP;

  private tearDown(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.clearPending(); // #502: stop waiting for a seed that will never arrive on a dead session
    // Flush the merged co-edit back to the canon ONLY if we actually bound. A session torn down BEFORE its
    // initial sync (a co-occupant left during the sync RTT — real providers sync asynchronously) was never
    // seeded and never bound: its body is EMPTY, so flushing "" would make the host wipe the canonical fence
    // body (bind/unbind imbalance → data loss). Just dispose it. (design-review must-fix.)
    if (this.bound) {
      const flushed = ephemeralBody(session.doc).toString(); // the merged co-edit → back to the canon
      // #502 review: EVERY co-occupant used to flush when occupancy dropped, so a client leaving and the
      // client staying wrote the SAME text concurrently. Neither could see the other's in-flight write, and
      // Yjs merged two inserts into a doubled edit (measured: "QRS" landed as "QRSQRS" when a peer closed
      // their tab). Elect ONE writer the same way seeding does — the lowest clientID still present — so the
      // merged body reaches the canon exactly once. A lone occupant is trivially the minimum, so the
      // last-one-out still flushes; that is the case this flush exists for.
      const present = coOccupantClientIDs(this.deps.awareness, this.deps.anchor);
      const elected = present.length === 0 || Math.min(...present) === this.deps.awareness.clientID;
      if (elected) this.deps.onUnbind(flushed);
    }
    this.bound = false;
    session.destroy();
  }

  // The island closed. Flush + tear down any live session and stop watching.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.tearDown();
  }
}

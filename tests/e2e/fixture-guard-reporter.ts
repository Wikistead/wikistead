import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { coreFixtureIntegrity } from "./fixtures";

// #890: name the spec that broke the shared fixture, instead of the run.
//
// The teardown check (#279) runs once, at the end. Its comment says the culprit is "caught red-handed",
// and that was never what it does: a run of 368 specs reports that SOMETHING deleted the fixture, and
// #279 was in fact closed with "which spec deleted it is unidentified". Worse, every spec after the
// deletion fails for want of permission, so the report is a wall of reds whose first cause is buried —
// and a run that is interrupted (or read while still going) never reaches the teardown at all.
//
// This asks the same question after every test. The check is one HTTP read per core tuple against the
// local e2e OpenFGA, so it costs milliseconds next to a browser test.
//
// ⚠️ ATTRIBUTION IS TO WITHIN ONE TEST. Reporter hooks are not awaited, so the read is queued behind
// the previous one and may land after the next test has started. With `workers: 1` and a read that
// returns in single-digit milliseconds it names the right test in practice — but if the report blames
// a test that plainly touches nothing, suspect the one before it rather than rewriting that spec.
export default class FixtureGuardReporter implements Reporter {
  private chain: Promise<void> = Promise.resolve();
  private firstBreak: { title: string; missing: string[] } | null = null;
  private saidUnreadable = false;

  onTestEnd(test: TestCase, _result: TestResult): void {
    this.chain = this.chain.then(async () => {
      if (this.firstBreak) return; // everything after the first break is a consequence, not a cause
      const { missing, unreadable } = await coreFixtureIntegrity().catch(() => ({ missing: [], unreadable: [] }));
      // ⚠️ #890 (measured 2026-08-23): a store that cannot answer is not a spec that deleted something.
      // This check reported all twelve anchors as deleted while OpenFGA sat at its 3 s deadline — and
      // named whichever test finished first, which touched none of them. Naming an innocent spec with
      // confidence is worse than the wall of reds this reporter replaced, so an unreadable store stops
      // the accusation and says where to look instead. Said once: it will be true for every later test.
      if (unreadable.length > 0) {
        if (!this.saidUnreadable) {
          this.saidUnreadable = true;
          console.error(
            `\n#890 FIXTURE CHECK COULD NOT RUN, from: ${test.location.file.split("/").pop()} › ${test.title}\n` +
              unreadable.map((u) => `  unreadable: ${u}`).join("\n") +
              "\n  This says nothing about any spec. Check the store's own health first.\n",
          );
        }
        return; // and do NOT blame anybody
      }
      if (missing.length > 0) {
        this.firstBreak = { title: `${test.location.file.split("/").pop()} › ${test.title}`, missing };
        console.error(
          `\n#890 SHARED FIXTURE BROKEN, first seen after: ${this.firstBreak.title}\n` +
            this.firstBreak.missing.map((m) => `  deleted: ${m}`).join("\n") +
            "\n  Every later failure in this run is a consequence of this one.\n",
        );
      }
    });
  }

  async onEnd(): Promise<void> {
    await this.chain;
  }
}

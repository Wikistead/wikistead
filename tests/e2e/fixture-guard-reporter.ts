import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { missingCoreFixtureTuples } from "./fixtures";

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

  onTestEnd(test: TestCase, _result: TestResult): void {
    this.chain = this.chain.then(async () => {
      if (this.firstBreak) return; // everything after the first break is a consequence, not a cause
      const missing = await missingCoreFixtureTuples().catch(() => [] as string[]);
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

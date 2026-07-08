import { assertDemoFixtureIntact } from "./fixtures";

// #279: after the suite, assert the shared demo fixture's core tuple survived. If a spec deleted
// `space:demo_space#space@page:demo`, this throws and FAILS the run — catching the culprit's run rather
// than letting it silently break the NEXT one (globalSetup's seedFgaFixtures then self-heals). A run whose
// specs all used scratch resources + afterAll cleanup leaves the fixture intact and passes.
export default async function globalTeardown() {
  await assertDemoFixtureIntact();
}

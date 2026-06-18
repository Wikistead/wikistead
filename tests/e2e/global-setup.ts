import { seedFixtures } from "./fixtures";

// Runs once before the suite. Seeds the security fixtures (locked space + stale
// Meili doc) used by tree.spec / search.spec. Hits the e2e middleware directly
// (not the app), so it doesn't depend on webServer start order.
export default async function globalSetup() {
  await seedFixtures();
}

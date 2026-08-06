import { requireAuthzScope } from '@wikistead/authz'
import { startServer } from './server.js'

// CE / self-host entrypoint. Builds and starts the server with NO Enterprise features (the
// getEeFeatures() seam inside buildApp is null unless an EE composition root registered a mount).
// The EE / Cloud build starts via packages/ee-server/src/main.ts, which registers the EE mount
// before calling the same startServer() (#178 / ADR-084 — EE physical separation).
// #637 / ADR-216 §2: this process serves requests, so every authorization call in it must happen inside
// a scope, and one that does not is a crash rather than a quiet widening. Declared HERE and not in
// `buildApp()`: the test harness and the collab process build an app too, and neither serves the request
// path this rule is about — declaring it there would make them throw for a rule that does not apply.
requireAuthzScope()

await startServer()

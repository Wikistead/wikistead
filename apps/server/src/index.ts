import { startServer } from './server.js'

// CE / self-host entrypoint. Builds and starts the server with NO Enterprise features (the
// getEeFeatures() seam inside buildApp is null unless an EE composition root registered a mount).
// The EE / Cloud build starts via packages/ee-server/src/main.ts, which registers the EE mount
// before calling the same startServer() (#178 / ADR-084 — EE physical separation).
await startServer()

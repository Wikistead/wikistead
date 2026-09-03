// The environment a deployment can set — walked from the code, described here (#734 / ADR-237 §2.2).
//
// The measurement that produced this file: the code reads about ninety distinct variables and
// `.env.example` declared forty. Rate limits, lockout windows, token TTLs, the platform OIDC block,
// the import threshold, the downgrade grace period — roughly fifty knobs existed only in source, so
// an operator had no way to learn that they existed at all.
//
// The shape is the one `docs/generated/` already uses: the CODE is the truth, this file is the prose,
// and the generator refuses to run when they disagree. Both directions:
//
//   * a variable the code reads with no row here            → red (a new knob ships documented)
//   * a row here for a variable the code no longer reads     → red (the reference cannot rot)
//   * a key in `.env.example` with no row here               → red (the sample file is documentation too)
//
// ── What the walk can and cannot see ────────────────────────────────────────────────────────────
//
// It finds `process.env.NAME`, `process.env['NAME']`, and `env.NAME` where a function was handed the
// environment (the shape `openfga-guard.ts` uses). It CANNOT see a read through a computed key:
// `secret-crypto.ts` does `process.env[KEY_ENV]` where `KEY_ENV` is a constant, and no regular
// expression is going to follow that. Those rows carry `indirect`, and the check demands the name
// still appear as a quoted string somewhere in the scanned tree — so a row cannot outlive the code
// that reads it, even when the read is invisible to the walk.
//
// Comments are stripped before scanning. Without that, a sentence in `custom-domains.ts` explaining
// why `Number(process.env.X ?? default)` is not a parser registered a variable named `X`.
//
// ── The edition boundary (#734) ───────────────────────────────────────────────────────────
//
// This walk deliberately does NOT enter the EE server package: that directory does not exist in the
// CE build, and a CE-side generator that reached into it would make the public repository's CI red
// on day one. The EE variables are emitted by a generator inside the EE package, spawned if present —
// the same shape as the Cloud plan matrix.
//
// Where that package LIVES is not spelled here. It is mid-move (#178 / ADR-084), and five hand-typed
// copies of the old path is exactly what `scripts/ee-source-root.mjs` was made to end.

import { EE_SERVER_SRC_CANDIDATES } from './ee-source-root.mjs'

/** Roots to walk, and what to skip inside them. */
export const ENV_SCAN = {
  // `infra` is here because that is where the seed and the OpenFGA bootstrap live, and they read
  // configuration a developer has to set. Leaving it out was measured: three OIDC keys in
  // `.env.example` looked like dead configuration precisely because their only reader was there.
  roots: ['apps', 'packages', 'infra'],
  skipDirs: ['node_modules', 'dist', '.turbo', '__tests__'],
  // EE facts belong to the EE generator (see the note above). Both homes of that package, taken from
  // the resolver rather than typed again — after the move, a stale copy here would silently pull EE
  // variables into the CE reference instead of failing.
  skipPaths: EE_SERVER_SRC_CANDIDATES.map((c) => c.replace(/\/src$/, '')),
  // Test files set variables to exercise behaviour; they are not deployment configuration.
  skipFile: (name) => /\.test\.[cm]?tsx?$/.test(name),
  fileExts: ['.ts', '.tsx', '.mts', '.mjs'],
  // `import.meta.env.DEV` and friends are Vite's own build-time properties, not the process
  // environment. VITE_* variables ARE configuration (a developer sets them), so they stay.
  ignoreNames: ['DEV', 'PROD', 'MODE', 'SSR', 'BASE_URL'],
}

/**
 * Every variable, with the group it is shown under, its default when unset, and one sentence.
 *
 * `internal: <reason>` marks a variable an operator must never set — it is emitted in its own section
 * saying so, rather than being left out (a knob that is invisible is a knob somebody sets anyway).
 * `indirect: true` marks a read the walk cannot see (see the note above). `where` names the files the
 * name has to keep appearing in when the reader lives outside the scanned tree entirely (compose, the
 * proxy configuration, a third-party SDK) — so even those rows cannot outlive their reader.
 * `unread: <reason>` marks a key that lives in `.env.example` but that no code reads.
 */
export const ENV_DOCS = {
  // ── Runtime ───────────────────────────────────────────────────────────────────────────────────
  NODE_ENV: {
    group: 'Runtime',
    default: 'development',
    what: 'Set to `production` in any real deployment. It is not cosmetic: below production the API accepts the literal bearer `dev-token`, and the session cookie is not marked `secure`.',
  },
  SERVER_PORT: { group: 'Runtime', default: '4000', what: 'Port the API server listens on.' },
  COLLAB_PORT: { group: 'Runtime', default: '4100', what: 'Port the collaboration (WebSocket) server listens on.' },
  PORT: { group: 'Runtime', default: '4100', what: 'Port for the operator console process (`operator/main.ts`), which is deployed separately from the API.' },
  WEB_PORT: { group: 'Runtime', default: '5173', what: 'Port the web dev server listens on. Build output is static, so this affects development only.' },
  // ── Observability (#987 / ADR-270) ────────────────────────────────────────────────────────────
  METRICS_TOKEN: {
    group: 'Observability',
    default: '(unset — metrics off)',
    what: 'Bearer token a Prometheus scrape presents to `GET /metrics`. Unset, the route does not exist and its listener is not started; the server says so at boot. Set it to any long random string and give the same value to your scrape config (`bearer_token`).',
  },
  METRICS_PORT: {
    group: 'Observability',
    default: '9464',
    what: 'Port the metrics listener binds. It is a separate listener from the API (`SERVER_PORT`) so the ingress never publishes it; scrape it from inside the cluster or network.',
  },
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    group: 'Observability',
    default: 'unset (tracing is off)',
    what: 'OTLP/HTTP collector the API server exports OpenTelemetry traces to (Jaeger, Tempo, a vendor\'s OTLP ingest). Unset, no SDK is loaded and no span is recorded; the boot log says so. Spans carry route templates, never tenant, user or page identifiers.',
  },
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: {
    group: 'Observability',
    default: 'unset (OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces)',
    what: 'The traces URL verbatim, when the collector does not follow the OTLP path convention. Per the OpenTelemetry exporter specification it takes precedence over the general endpoint; it does not turn tracing on by itself.',
  },
  OTEL_SERVICE_NAME: {
    group: 'Observability',
    default: 'unset (the product name, lower-cased, plus `-server`)',
    what: 'The `service.name` resource attribute on exported traces. Set it when several deployments share one collector; unset, the server names itself after the product.',
  },
  WKS_BRAND_NAME: { group: 'Runtime', default: 'Wikistead', what: 'Product name shown in the interface and in outgoing mail, for a rebranded deployment.' },
  WKS_PUBLIC_BASE_URL: {
    group: 'Runtime',
    default: 'unset (mail that needs a link is dropped)',
    // #828 / ADR-254 Decision 1: this row used to describe the APPLICATION's own origin, and the one
    // thing that reads the variable prefixes a workspace slug onto it. An operator who set what this
    // row described sent every mention and digest to `<slug>.app.example.com` — outside the wildcard,
    // outside the certificate, resolving to nothing. The composition is spelled out now, because the
    // ambiguity was never in the code (`.env.example` has always said the zone) but in this sentence.
    // #1056 / ADR-254 addendum: password reset and invite links used to be built from the REQUEST's
    // Host header instead, which worked by accident and was also how a spoofed Host could move a
    // reset link's destination. They now read this same variable, so "unset" now also means those
    // two links are dropped, not only mentions and digests.
    what: 'The parent zone whose subdomains are workspaces — background mail, password resets and invitations have no trustworthy Host header to compose a link from. The workspace slug is prefixed onto it: `https://wikistead.com` produces `https://<slug>.wikistead.com`, so set the zone, not the application\'s own host. A workspace with a verified custom domain uses that instead. Unset means any message that needs a link — a mention, a digest, a password reset, an invitation — is dropped with a logged reason rather than improvising one from the request; on a single host, set it to the zone ABOVE your site host so the composed address is the site host itself.',
  },
  WKS_TENANT_URL_TEMPLATE: {
    group: 'Runtime',
    default: 'unset (self-serve workspace creation is closed)',
    // Read through a constant (`process.env[TENANT_URL_TEMPLATE_ENV]`) so the two callers and the
    // boot line cannot drift on the spelling — invisible to the walk, visible as a string literal.
    indirect: true,
    what: 'The shape of a workspace address, with `{slug}` standing for the workspace name — for example `https://{slug}.example.com`. The placeholder must be the host\'s entire first label, because that label is what tenant resolution reads. Unset closes self-serve creation of new workspaces and nothing else: signing in, existing workspaces, and custom domains are unaffected. Serving one workspace on one host needs no template — name that workspace after the host\'s first label instead.',
  },
  PUBLIC_SHELL_INDEX: {
    group: 'Runtime',
    default: 'unset (the public HTML shell is off)',
    what: "Path to the built web `index.html` the server injects public page metadata into. Unset means crawlers and link previews get the SPA's empty shell, so any deployment that publishes pages wants it set.",
  },
  SITE_HOST: {
    group: 'Runtime',
    default: 'dev.localhost',
    indirect: true,
    where: ['docker-compose.yml', 'deploy/caddy/Caddyfile'],
    what: 'The one public host the self-host compose profile answers on. Read by compose and by the Caddy configuration rather than by the application, which learns its host from each request.',
  },

  // ── Database ──────────────────────────────────────────────────────────────────────────────────
  DATABASE_URL: {
    group: 'Database',
    default: 'unset (required)',
    what: 'Postgres connection string for the restricted runtime role (no superuser, no BYPASSRLS). This is the credential the API and the collaboration server run every request under.',
  },
  DATABASE_ADMIN_URL: {
    group: 'Database',
    default: 'falls back to DATABASE_URL',
    what: 'Superuser connection string, used by the migration runner and by the cross-tenant storage sweep. Keep it out of processes that do not need it — row-level security is what confines the runtime role to one workspace.',
  },
  MIGRATIONS_DIR: {
    group: 'Database',
    default: 'the SQL shipped beside the app (`/app/migrations` in the image), else the checkout',
    what: 'Where the migration runner reads its SQL. Set it only when the schema lives somewhere the runner would not look — a chart mounting the files, or a run against a copy. The published image carries the migrations, so a normal deployment leaves this unset.',
  },

  // ── Cache and queues ──────────────────────────────────────────────────────────────────────────
  VALKEY_URL: {
    group: 'Cache and queues',
    default: 'redis://localhost:6379',
    what: 'Valkey/Redis connection string. Collaboration uses it to fan out between server instances, and rate limits count in it, so all instances must share one.',
  },

  // ── Authorization ─────────────────────────────────────────────────────────────────────────────
  OPENFGA_API_URL: { group: 'Authorization', default: 'http://localhost:8080', what: 'OpenFGA endpoint. Every permission decision in the product is asked here.' },
  OPENFGA_STORE_ID: {
    group: 'Authorization',
    default: 'unset (found by name, or created on first boot)',
    what: 'OpenFGA store holding this deployment\'s tuples. Unset, the server finds a store named `wikistead` or creates one on the first boot that has never had one — a chart or compose file need not carry this. Set it to bind explicitly instead: no listing happens, and a wrong or missing id refuses the boot rather than authorizing against nothing.',
  },
  OPENFGA_MODEL_ID: {
    group: 'Authorization',
    default: 'unset (reconciled to the image\'s model.fga on every boot)',
    what: 'Pins the STORE, not a frozen model — the model is always brought up to the DSL the running image carries, so a deployment cannot silently keep speaking a shape that image no longer does. Setting this records what you expected and the boot reports it if a later image adopts something else; it does not stop that adoption.',
  },
  OPENFGA_DATASTORE_ENGINE: {
    group: 'Authorization',
    default: 'memory',
    what: 'What the OpenFGA service stores tuples in, declared to the API so it can refuse to start on `memory` under production — in-memory tuples vanish on restart, and every permission in the deployment with them.',
  },
  WIKISTEAD_SKIP_FGA_MODEL_GUARD: {
    group: 'Authorization',
    internal: 'Test harnesses set this to bring a server up against a store whose model is deliberately mismatched. A deployment that sets it turns off the check that its authorization model is the one it thinks it is.',
  },
  WIKISTEAD_SKIP_MIGRATION_GUARD: {
    group: 'Database',
    internal: 'Starts the server even when migrations the image ships are missing from the database. Set it only to get a process up for diagnosis: every request that touches the missing schema fails with 42703.',
  },

  // ── Search ────────────────────────────────────────────────────────────────────────────────────
  MEILI_HOST: { group: 'Search', default: 'http://localhost:7700', what: 'Meilisearch endpoint.' },
  MEILI_MASTER_KEY: {
    group: 'Search',
    default: 'unset',
    what: 'Meilisearch master key. Production refuses to start on the value published in the public repository\'s fixtures, so generate one.',
  },
  SEARCH_CURSOR_SECRET: {
    group: 'Search',
    default: 'falls back to GUEST_TOKEN_SECRET',
    what: 'Signs search pagination cursors so a cursor cannot be edited into a query the caller was not authorized for.',
  },

  // ── Object storage ────────────────────────────────────────────────────────────────────────────
  S3_ENDPOINT: { group: 'Object storage', default: 'the AWS default for the region', what: 'S3-compatible endpoint the server itself talks to (MinIO, SeaweedFS, R2, S3).' },
  S3_PUBLIC_ENDPOINT: {
    group: 'Object storage',
    default: 'same as S3_ENDPOINT',
    what: 'The address the BROWSER reaches the store at, when it differs from the one the server uses. A presigned URL\'s signature covers the Host header, so a URL signed for an internal name is refused the moment a browser opens it under a public one.',
  },
  S3_REGION: { group: 'Object storage', default: 'us-east-1', what: 'Region used when signing. S3-compatible gateways usually ignore it but still expect it to match the signature.' },
  S3_BUCKET: { group: 'Object storage', default: 'unset (required)', what: 'Bucket that holds attachments, icons and import archives.' },
  S3_ACCESS_KEY: { group: 'Object storage', default: 'unset (required)', what: 'Access key id for the bucket.' },
  S3_SECRET_KEY: { group: 'Object storage', default: 'unset (required)', what: 'Secret key for the bucket.' },
  S3_FORCE_PATH_STYLE: {
    group: 'Object storage',
    default: 'false',
    what: 'Set to `true` for gateways that serve `host/bucket/key` rather than `bucket.host/key` — MinIO and SeaweedFS both want it.',
  },
  AWS_REQUEST_CHECKSUM_CALCULATION: {
    group: 'Object storage',
    default: 'the SDK default (`WHEN_SUPPORTED`)',
    indirect: true,
    where: ['.env.example', 'deploy/k8s/overlays/prod/kustomization.yaml', 'charts/wikistead/templates/config.yaml'],
    what: 'Read by the AWS SDK, not by this product. Set it to `WHEN_REQUIRED` so a browser presigned PUT (which sends no checksum header) is accepted by S3-compatible gateways.',
  },
  AWS_RESPONSE_CHECKSUM_VALIDATION: {
    group: 'Object storage',
    default: 'the SDK default',
    indirect: true,
    where: ['.env.example', 'deploy/k8s/overlays/prod/kustomization.yaml', 'charts/wikistead/templates/config.yaml'],
    what: 'The reading half of the setting above; `WHEN_REQUIRED` for the same gateways.',
  },

  // ── Email ─────────────────────────────────────────────────────────────────────────────────────
  SMTP_HOST: { group: 'Email', default: 'unset (email is off)', what: 'SMTP host. With it unset the product never sends mail — invitations are copy-a-link instead, which is a workable self-host mode rather than a broken one.' },
  SMTP_PORT: { group: 'Email', default: '587', what: 'SMTP port.' },
  SMTP_SECURE: { group: 'Email', default: 'false', what: 'Set to `true` for implicit TLS (port 465). STARTTLS on 587 is the `false` case.' },
  SMTP_USER: { group: 'Email', default: 'unset (no authentication)', what: 'SMTP username.' },
  SMTP_PASS: { group: 'Email', default: 'unset (no authentication)', what: 'SMTP password.' },
  EMAIL_FROM: { group: 'Email', default: '`<product name> <noreply@wikistead.local>`', what: 'From address on outgoing mail. Set it to a domain you actually control, or your mail will be filed as spam.' },
  EMAIL_OUTBOX_POLL_MS: { group: 'Email', default: '5000', what: 'How often the mail drain looks for queued messages.' },
  EMAIL_FOLD_WINDOW_S: { group: 'Email', default: '30', what: 'Hold window for immediate notifications: mentions arriving inside it fold into one message instead of a burst.' },
  EMAIL_DIGEST_HOUR: { group: 'Email', default: '8', what: 'Hour of day the daily digest is sent, in EMAIL_DIGEST_TZ.' },
  EMAIL_DIGEST_TZ: { group: 'Email', default: 'UTC', what: 'Time zone the digest hour is interpreted in.' },
  UNSUB_TOKEN_TTL_S: { group: 'Email', default: '2592000 (30 days)', what: 'How long an unsubscribe link in a notification email keeps working.' },

  // ── Sign-in ───────────────────────────────────────────────────────────────────────────────────
  OIDC_SECRET_ENC_KEY: {
    group: 'Sign-in',
    default: 'unset (required)',
    indirect: true,
    what: 'Base64 AES-256 key that encrypts tenant OIDC client secrets at rest. The server refuses to start without it rather than storing those secrets in plaintext, and refuses to start on the key published in the public repository\'s fixtures.',
  },
  OIDC_ISSUER: { group: 'Sign-in', default: 'unset', what: 'Issuer the collaboration server validates member tokens against. Per-workspace OIDC is configured in the product; this is the deployment-wide one collab checks.' },
  OIDC_CLIENT_ID: {
    group: 'Sign-in',
    default: 'unset',
    what: "Client id the development seed writes into the dev workspace's OIDC connection. Production workspaces register their own in the admin console, so this is a seeding convenience rather than a deployment setting.",
  },
  OIDC_CLIENT_SECRET: {
    group: 'Sign-in',
    default: 'unset (a public client)',
    what: 'Client secret for the seeded development connection. It is encrypted with OIDC_SECRET_ENC_KEY before it reaches the database, exactly as a secret entered in the console would be.',
  },
  OIDC_REDIRECT_URI: {
    group: 'Sign-in',
    default: 'unset',
    what: 'Redirect URI for the seeded development connection. It has to match what the identity provider has registered, including port.',
  },
  OIDC_JWKS_URI: { group: 'Sign-in', default: 'unset', what: 'JWKS endpoint matching OIDC_ISSUER.' },
  OIDC_ALLOW_PRIVATE_ISSUER: {
    group: 'Sign-in',
    default: 'off',
    what: 'Set to `1` to let a workspace register an OIDC issuer on a private network address. Off by default because it is the request a server-side request forgery needs.',
  },
  LOGIN_METHODS: {
    group: 'Sign-in',
    default: 'unset (every method permitted)',
    what: 'Comma-separated ceiling of sign-in methods this deployment allows (`tenant-oidc`, `platform-oidc`, `saml`). Workspaces choose within it; a value naming no valid method fails at boot rather than 404-ing every login.',
  },
  PLATFORM_OIDC_ISSUER: { group: 'Sign-in', default: 'unset (platform sign-in is off)', what: 'Issuer for the deployment-wide identity provider, used when a workspace has not registered its own.' },
  PLATFORM_OIDC_CLIENT_ID: { group: 'Sign-in', default: 'unset', what: 'Client id at the platform issuer.' },
  PLATFORM_OIDC_CLIENT_SECRET: { group: 'Sign-in', default: 'unset (public client)', what: 'Client secret at the platform issuer, when it issues one.' },
  PLATFORM_OIDC_REDIRECT_URI: { group: 'Sign-in', default: 'unset', what: 'Redirect URI registered with the platform issuer. It must match exactly, including scheme and port.' },
  PLATFORM_OIDC_SCOPES: { group: 'Sign-in', default: 'openid email profile', what: 'Scopes requested from the platform issuer.' },
  PLATFORM_OIDC_GROUPS_CLAIM: { group: 'Sign-in', default: 'groups', what: 'Claim carrying group membership, for deployments whose provider names it something else.' },
  LOCAL_LOGIN_WINDOW_S: { group: 'Sign-in', default: '900', what: 'Window over which failed password attempts are counted.' },
  LOCAL_LOGIN_ID_MAX: { group: 'Sign-in', default: '5', what: 'Failed attempts per account inside the window before it is locked.' },
  LOCAL_LOGIN_IP_MAX: { group: 'Sign-in', default: '30', what: 'Failed attempts per source address inside the window, which is what bounds spraying across many accounts.' },
  LOCAL_LOGIN_LOCK_S: { group: 'Sign-in', default: '1800', what: 'How long a lockout lasts.' },
  LOCAL_RESET_ADDR_MAX: { group: 'Sign-in', default: '3', what: 'Password-reset requests accepted per address per window.' },

  // ── Second factors ────────────────────────────────────────────────────────────────────────────
  FACTOR_VERIFY_WINDOW_S: { group: 'Second factors', default: '900', what: 'Window over which failed second-factor attempts are counted.' },
  FACTOR_VERIFY_MAX: { group: 'Second factors', default: '5', what: 'Failed second-factor attempts inside the window before the door locks.' },
  FACTOR_VERIFY_LOCK_S: { group: 'Second factors', default: '1800', what: 'How long that lock lasts.' },
  MAX_FACTORS_PER_MEMBER: { group: 'Second factors', default: '10', what: 'How many factors one member may register. It bounds the enrolment surface rather than expressing a security policy.' },
  SECOND_FACTOR_RECOVERY: {
    group: 'Second factors',
    default: 'on',
    what: 'Set to `off` to stop issuing recovery codes. Off means a member who loses every factor needs an administrator, which is the trade a deployment makes deliberately.',
  },

  // ── Guests and sharing ────────────────────────────────────────────────────────────────────────
  GUEST_TOKEN_SECRET: {
    group: 'Guests and sharing',
    default: 'unset (required)',
    what: 'Signs the short-lived tokens anonymous share-link visitors carry. Production refuses to start on the value published in the public repository\'s fixtures.',
  },
  GUEST_TOKEN_TTL_SECONDS: {
    group: 'Guests and sharing',
    default: '300',
    what: 'How long a guest token lives. Keep it short: revoking a link disconnects the guests it can still reach at once, and this is how long access lasts for one it could not. The value is also clamped to the link\'s own remaining life, so a link expiring in a minute never mints an hour-long token.',
  },
  EXCHANGE_RL_IP_MAX: { group: 'Guests and sharing', default: '30', what: 'Share-link token exchanges accepted per source address per minute.' },
  EXCHANGE_RL_LINK_MAX: { group: 'Guests and sharing', default: '10', what: 'Token exchanges accepted per share link per minute, which bounds one leaked link rather than one visitor.' },
  REFRESH_RL_IP_MAX: { group: 'Guests and sharing', default: '120', what: 'Token renewals accepted per source address per minute. A renewal is cheaper than an exchange and a guest makes many over one visit, so this sits well above the exchange limit.' },
  REFRESH_RL_LINK_MAX: { group: 'Guests and sharing', default: '600', what: 'Token renewals accepted per share link per minute. Sized for the number of guests a link is meant to hold at once, not for how often one of them renews.' },
  REFRESH_RL_SESSION_MAX: { group: 'Guests and sharing', default: '20', what: 'Token renewals accepted per guest session per minute. This is the narrow one: a session renews when its token is near expiry, so a well-behaved guest never approaches it.' },
  SHARE_LINK_SWEEP_POLL_MS: { group: 'Guests and sharing', default: '60000', what: 'How often expired share links are swept out of the authorization store.' },

  // ── Billing ───────────────────────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: { group: 'Billing', default: 'unset (billing is off)', what: 'Stripe secret key. Unset means the product runs unbilled, which is the self-host case.' },
  STRIPE_WEBHOOK_SECRET: { group: 'Billing', default: 'unset', what: 'Signing secret for the Stripe webhook, without which subscription changes are ignored.' },
  STRIPE_PRICE_PRO: { group: 'Billing', default: 'unset', what: 'Stripe price id mapped to the pro plan.' },
  STRIPE_PRICE_TEAM: { group: 'Billing', default: 'unset', what: 'Stripe price id mapped to the team plan.' },
  PLAN_DOWNGRADE_GRACE_S: {
    group: 'Billing',
    default: '604800 (7 days)',
    what: 'How long a workspace keeps the features of its old plan after a downgrade, so a lapsed card does not take one away the same minute.',
  },

  // ── Background workers ────────────────────────────────────────────────────────────────────────
  SEARCH_OUTBOX_POLL_MS: { group: 'Background workers', default: '2000', what: 'How often the search index drain runs. It is the delay between an edit and the edit being findable.' },
  WEBHOOK_OUTBOX_POLL_MS: { group: 'Background workers', default: '5000', what: 'How often queued webhook deliveries are drained.' },
  TRASH_SWEEP_POLL_MS: { group: 'Background workers', default: '3600000 (1 hour)', what: 'How often trashed pages past their retention are purged.' },
  TUPLE_OUTBOX_POLL_MS: { group: 'Background workers', default: '30000', what: 'How often the permission store is asked again to drop the entries a removed member left behind. They are retried until they land; the drain reports how many are waiting and how long the oldest has waited.' },
  CUSTOM_DOMAIN_RECHECK_MS: {
    group: 'Background workers',
    default: '21600000 (6 hours)',
    what: 'How often verified custom domains are re-checked for ownership. Set to `0` to switch the sweep off while developing against a placeholder domain.',
  },
  ABUSE_FLAG_WINDOW_S: { group: 'Background workers', default: '600', what: 'Window over which repeated abuse reports from one source are folded into one flag.' },
  YDOC_STORE_BACKOFF_MS: { group: 'Background workers', default: '500', what: 'Base backoff for retrying a failed document persist in the collaboration server.' },

  // ── Import ────────────────────────────────────────────────────────────────────────────────────
  IMPORT_SYNC_MAX_NODES: {
    group: 'Import',
    default: '200',
    what: 'Archives with more pages than this become a background job answered with an import id, instead of being materialised inside the request.',
  },
  IMPORT_JOB_POLL_MS: { group: 'Import', default: '5000', what: 'How often the import worker looks for a queued archive.' },

  // ── AI and MCP ────────────────────────────────────────────────────────────────────────────────
  AI_RATE_LIMIT_PER_TENANT: { group: 'AI and MCP', default: '60', what: 'AI requests accepted per workspace per window.' },
  AI_RATE_LIMIT_WINDOW_S: { group: 'AI and MCP', default: '60', what: 'Length of that window.' },
  API_RATE_LIMIT_WINDOW_S: { group: 'AI and MCP', default: '60', what: 'Window the collaboration server counts abusive request bursts over.' },
  MCP_TOKEN_TTL_S: { group: 'AI and MCP', default: '3600', what: 'Lifetime of an access token issued to an AI assistant through the MCP OAuth flow.' },
  MCP_TOKEN_RL_MAX: { group: 'AI and MCP', default: '60', what: 'Token exchanges accepted per source address per window.' },
  MCP_DCR_RL_MAX: { group: 'AI and MCP', default: '20', what: 'Dynamic client registrations accepted per source address per window.' },

  // ── Diagrams ──────────────────────────────────────────────────────────────────────────────────
  PLANTUML_RENDER_URL: {
    group: 'Diagrams',
    default: 'unset (diagrams degrade to their source)',
    what: 'Kroki-compatible endpoint for rendering PlantUML. Setting it sends diagram SOURCE to that service, so a shared endpoint means user content leaves your deployment; self-host Kroki if that matters. The engine is GPL and is never bundled, which is why this is an endpoint rather than a feature flag.',
  },

  // ── Development and tooling ───────────────────────────────────────────────────────────────────
  SEED_TENANT_PLAN: {
    group: 'Development and tooling',
    default: 'unset (the schema default)',
    what: 'Plan the seed puts on the development workspace, for working on a screen that only appears above a certain tier.',
  },
  DEV_CUSTOM_DOMAIN: {
    group: 'Development and tooling',
    default: 'unset',
    what: 'Custom domain the seed mirrors onto the development workspace on every run, so it survives a `down -v`. Seeded as verified locally; production still requires the DNS challenge.',
  },
  DEV_ENROLL_POLICY: {
    group: 'Development and tooling',
    default: 'the schema default (invite_only)',
    what: 'Enrolment policy the seed sets on the development workspace: `open`, `domain`, `groups` or `invite_only`.',
  },
  DEV_ENROLL_DOMAIN: { group: 'Development and tooling', default: 'unset', what: 'Verified email domain for the seeded `domain` enrolment policy.' },
  DEV_ENROLL_ALLOWED_GROUPS: { group: 'Development and tooling', default: 'unset', what: 'Comma-separated groups for the seeded `groups` enrolment policy.' },
  API_PROXY_TARGET: { group: 'Development and tooling', default: 'http://localhost:4000', what: 'Where the web dev server proxies `/api`. Development only — a built deployment reaches the API through its own origin.' },
  COLLAB_PROXY_TARGET: { group: 'Development and tooling', default: 'http://localhost:4100', what: 'Where the web dev server proxies the collaboration socket.' },
  VITE_TENANT: { group: 'Development and tooling', default: 'unset', what: 'Workspace slug the dev web app pretends to be on, for working on a tenant other than the host name would resolve to.' },
  VITE_DEV_TOKEN: { group: 'Development and tooling', default: 'unset', what: 'Bearer the dev web app sends instead of signing in. It only works against a server that is not in production mode.' },
  VITE_DEV_TOKEN_DISABLE: { group: 'Development and tooling', default: 'unset', what: 'Set to turn the dev bearer off and exercise the real cookie session locally — the mode most sign-in bugs only appear in.' },
  WIKISTEAD_OPERATOR: { group: 'Development and tooling', default: 'the OS user name', what: 'Name recorded as the actor when an operator CLI writes to the audit ledger.' },
  WKS_STACK_OFFSET: {
    group: 'Development and tooling',
    default: '0',
    what: 'Shifts every port and container name of the test stacks, so parallel checkouts can run their suites without colliding.',
  },
  WIKISTEAD_TEST_STACK: {
    group: 'Development and tooling',
    internal: 'The test runner sets this to prove a suite is pointed at the isolated stack rather than a development database. Setting it by hand tells that guard a lie.',
  },
  POOL_END_QUIESCE_MS: {
    group: 'Development and tooling',
    internal: 'How long a shutdown waits for tenant connections that are on their way back before it forces the close. It exists so a machine slow enough to miss the default can be given room; a deployment has no shutdown path to tune, and setting it high enough to matter would trade a reported hang for a silent one.',
  },
}

// ── The walk and the comparison (pure, so both the generator and the suite use one implementation) ──
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DIRECT = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g
// `env.NAME` where a function was handed the environment (openfga-guard.ts). Restricted to
// SCREAMING_CASE so an ordinary object called `env` cannot smuggle a lower-case property in.
const HANDED = /(?<!process\.)\benv\.([A-Z_][A-Z0-9_]{2,})\b|(?<!process\.)\benv\[['"]([A-Z_][A-Z0-9_]{2,})['"]\]/g

/** Comments are prose about the environment, not reads of it (a comment invented a variable "X"). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every variable the CE tree reads, mapped to the files that read it. */
export function scanEnvUsage(root, scan = ENV_SCAN) {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = relative(root, abs)
      if (scan.skipPaths.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
      if (statSync(abs).isDirectory()) {
        if (scan.skipDirs.includes(entry)) continue
        walk(abs)
        continue
      }
      if (!scan.fileExts.some((e) => entry.endsWith(e))) continue
      if (scan.skipFile(entry)) continue
      const text = stripComments(readFileSync(abs, 'utf8'))
      for (const re of [DIRECT, HANDED]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text)) !== null) {
          const name = m[1] ?? m[2]
          if (scan.ignoreNames.includes(name)) continue
          const files = found.get(name) ?? new Set()
          files.add(rel)
          found.set(name, files)
        }
      }
    }
  }
  for (const r of scan.roots) walk(join(root, r))
  return found
}

/**
 * Where an `indirect` row's name still has to appear: as a quoted string in the scanned tree, or in
 * the files the row itself names (compose, the proxy configuration, the sample env). This is what
 * keeps a row whose read is invisible to the walk from outliving the thing that reads it.
 */
export function scanStringLiterals(root, names, scan = ENV_SCAN, extraFiles = []) {
  const seen = new Set()
  for (const file of extraFiles) {
    let text
    try { text = readFileSync(join(root, file), 'utf8') } catch { continue }
    for (const name of names) if (text.includes(name)) seen.add(name)
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = relative(root, abs)
      if (scan.skipPaths.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
      if (statSync(abs).isDirectory()) {
        if (scan.skipDirs.includes(entry)) continue
        walk(abs)
        continue
      }
      if (!scan.fileExts.some((e) => entry.endsWith(e))) continue
      const text = readFileSync(abs, 'utf8')
      for (const name of names) if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) seen.add(name)
    }
  }
  for (const r of scan.roots) walk(join(root, r))
  return seen
}

/** Keys declared in `.env.example` (the sample file is documentation too, so it is compared). */
export function scanEnvExample(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((n) => n != null),
  )
}

/**
 * Both directions, plus the sample file. Returns human-readable violations; empty means agreement.
 * Pure over its inputs so a test can drive it with synthetic sets.
 */
export function evaluateEnvCatalog({ used, literals, example, docs = ENV_DOCS }) {
  const violations = []
  for (const name of [...used].sort()) {
    if (!docs[name]) violations.push(`${name}: read by the code with no row in scripts/env-catalog.mjs — document it (or mark it internal, with the reason)`)
  }
  for (const [name, row] of Object.entries(docs)) {
    if (used.has(name)) continue
    if (row.indirect) {
      if (!literals.has(name)) {
        violations.push(
          `${name}: documented as an indirect read, but the name no longer appears in the code${row.where ? ` or in ${row.where.join(', ')}` : ''} — drop the row`,
        )
      }
      continue
    }
    if (row.unread) continue
    violations.push(`${name}: documented, but nothing reads it any more — drop the row (or mark it \`unread\` with the reason it stays in .env.example)`)
  }
  for (const name of [...example].sort()) {
    if (!docs[name]) violations.push(`${name}: declared in .env.example with no row in scripts/env-catalog.mjs — the sample file is documentation too`)
  }
  return violations
}

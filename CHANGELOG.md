# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/). This project will adopt
[Semantic Versioning](https://semver.org/) at its first tagged release.

Maintained **manually** until release tooling is introduced (see `the project design notes`
`TODO(release)` — semantic-release is intentionally deferred until the first release).

## [Unreleased]

### Added
- Community Edition (AGPL-3.0): a self-hostable, multi-tenant collaborative Markdown
  knowledge base. Core: account-free, real-time collaboration via anonymous share links.
- Backend: tenant isolation (Postgres RLS), authorization (OpenFGA ReBAC), spaces/pages
  with a nested tree, billing/entitlements, search (Meilisearch + two-stage FGA guard),
  S3-compatible object storage (SeaweedFS), CRDT collab persistence, revisions, public
  page rendering, API keys, and anonymous share links.
- Web editor: a single CodeMirror 6 live-preview surface with a vim keymap, macros
  (mermaid / callout / table / excalidraw), inline comments, and i18n (en / ja).

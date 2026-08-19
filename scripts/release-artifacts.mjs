// #792: what a release commit carries.
//
// The version is an INPUT to the generated documentation — `docs/generated/.source-version` is the
// marker the documentation site reads to catch a torn pull (#180 / ADR-225 §3), rendered from the
// field the release commit writes. A commit that moves the version without regenerating leaves the
// tree stale, `pnpm docs:check` fails on the release PR's own CI, and the PR can never merge: the
// version, the tag and the GitHub release all stop at a check about a file nobody touched.
//
// Its own module so the pin can read the same list the commit uses. `release-pr.mjs` derives a
// release the moment it is imported, so a test could not have asked it.
export const RELEASE_ARTIFACTS = ['CHANGELOG.md', 'package.json', 'docs/generated']

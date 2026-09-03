# Wikistead

A self-hostable, multi-tenant collaborative knowledge base. Anonymous real-time editing over a share
link, no account required.

```
helm install wikistead oci://ghcr.io/wikistead/charts/wikistead \
  --namespace wikistead --create-namespace \
  --set host=wiki.example.com
```

The chart templates the project's own Kubernetes deployment base, which remains the source of truth:
when the two disagree, the base is right and the chart has a bug.

## What you have to decide

| Value | Why it is yours to set |
|---|---|
| `host` | Where the application answers. |
| `workspaceHostTemplate` | The SHAPE of a workspace's address, e.g. `https://{slug}.example.com`. **Not derived from `host`** — a workspace lives one label shallower, and gluing a slug onto the application's own host produces addresses that do not resolve. Leave it empty on a single-host install: self-serve workspace creation closes, which is better than handing out an address that does not resolve. |
| `secrets.existingSecret` | The chart ships no credential. Point this at a secret you made — SOPS+age through ksops is what this project uses. `secrets.generate=true` is a first-install convenience; read the caveat below before relying on it. |
| `postgres.enabled` and friends | The five bundled middleware services are single replicas with no backup. A production install turns them off and points at managed ones. |

## Ingress: two objects, on purpose

The chart renders **two** Ingress resources. The api one carries `rewrite-target: /$1` so `/api/x`
reaches the server as `/x`, and an nginx rewrite annotation applies to a whole Ingress — merging them
would make that rewrite eat `/auth`, `/collab` and everything else. This was measured on a real
cluster, not reasoned about.

If your controller rejects `configuration-snippet` (many do, by policy), set
`ingress.securityHeaderSnippet=false` and set those headers in the controller's own configuration.

## Initialization

Two hooks run from the server image:

- **`migrate`** — the schema. The SQL ships inside the image.
The authorization store needs no hook: the server resolves — or, on a deployment that has never
had one, creates — its own OpenFGA store and model at startup, from the `model.fga` baked into the
image. The `fga-bootstrap` hook this chart used to carry is gone — the server does at boot what the
hook used to do separately, so the hook only duplicated it and could race it.

## Generated credentials, honestly

`secrets.generate=true` mints random credentials on first install and preserves them across upgrades
by reading back what the previous release wrote. Two consequences worth knowing before you choose it:

- **They are invisible to your backup and rotation story** unless you copy them somewhere yourself.
- **`helm template` and `--dry-run` show different values every time**, because reading the previous
  ones needs a cluster. That is expected; it also means you cannot review the real values offline.

An operator who already has a secret store should leave this off.

## Upgrades

Chart `version` and `appVersion` are both the product version, and images are pinned by tag or, better,
by digest — `image.digest` wins over `image.tag` when both are set. A tag is a name
somebody can move; a digest is the thing that ran.

## Where to report

Issues and pull requests belong on the product repository: <https://github.com/Wikistead/wikistead>.
The chart source lives there under `charts/wikistead`, and `wikistead/helm-charts` is a published copy
written only by release CI.

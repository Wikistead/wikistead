# Where this archive came from

`collection-export.zip` was produced by **Outline 1.9.2** (`outlinewiki/outline:latest`, resolved on
2026-08-22), run in a throwaway `docker compose` stack on a developer machine — a Postgres, a Redis,
a Mailpit and the image, on non-default ports, under their own compose project. Nothing from that
stack survives; the archive is the only artefact.

The content is five documents written for this fixture:

```
Handbook                      the parent, and the collection's name
  Onboarding                  an ordinary child
  運用手順 / 日次              Japanese, with a slash in the title
  Runbook                     ┐ two children with the same title, so the exporter's
  Runbook                     ┘ duplicate-name suffix appears
```

The parent's body carries four links on purpose: two internal (one to an ASCII title, one to the
Japanese one), one genuinely external, and one internal written as an absolute URL.

## What made it, exactly

Outline's own exporter: `ExportMarkdownZipTask.loadDataAndExport`, the class the product's export
button reaches. Team, user and documents were created through Outline's own `accountProvisioner` and
models rather than by writing rows, so the archive is what the product produces from its own data.

⚠️ **The export was NOT triggered through the web UI.** Email sign-in did not deliver a link in this
stack, so the task was invoked directly. The exporter is the product's; the button was not pressed.

## Licence

Outline is licensed **BSL 1.1**. This archive contains no Outline source: the prose is written here,
and what Outline contributed is the layout, the file names and the rewritten links — the observable
behaviour this adapter has to interoperate with. Nothing is linked, bundled or distributed with the
product (ADR-011 governs what enters a distributable, and no dependency was added).

⚠️ **Committing it was flagged for a ruling on #728 rather than assumed.** The precedent is the
Docmost fixture beside this one, whose product is AGPL; BSL constrains use of the software rather than
of an output, and the reasoning is recorded here so a reader can disagree with it cheaply — deleting
this directory costs one `docker compose up` to recreate.

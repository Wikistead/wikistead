# Docmost export archives, as the product produced them

Not hand-written. ADR-242 §"facts" says a slice confirms its facts against an archive the product
actually produced, so these were exported from a real Docmost and committed unchanged.

    product   docmost/docmost (Docker Hub `latest` on 2026-08-21) → 0.95.0 by its own package.json
    stack     docmost + postgres:16 + redis:7, empty database, single admin user
    content   written for this fixture, by hand, to reach the shapes the ADR reasons about:

              Handbook                    a parent page, links to every page below
              ├── Onboarding              carries the attachment
              ├── 運用手順 / 日次          a non-ASCII title, and a `/` the file name cannot hold
              ├── Runbook                 }
              └── Runbook                 } the same title twice — the `Title (1)` case
              Outside The Export          a second root, to make one export a partial one

    archives  page-subtree.zip        "export page" on Handbook, children included
              space.zip               "export space", no attachments
              space-with-attachment.zip  the same, after an image was attached to Onboarding
              space-two-attachments-same-name.zip  a second image, SAME file name, different
                                         bytes, attached to a different page

What they show that the source code did not (see #728 /): entry names are raw while links
and manifest keys are percent-encoded; links and manifest keys use DIFFERENT encoders, so the same
page is spelled two ways; `/` is deleted from a title rather than replaced; and an attachment's entry
name carries an empty path segment (`Handbook//files/<id>/<name>`).

Nothing here is Docmost's code. The bodies are the sentences above, the attachment is a 7-byte file,
and the structure is what the exporter wrote.

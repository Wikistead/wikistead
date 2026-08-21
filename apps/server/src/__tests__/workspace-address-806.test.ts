// #806 / ADR-249: the product must stop fabricating workspace addresses.
//
// The reported symptom was a single-host self-host answering signup with `https://<slug>.<host>` —
// a name nothing serves. The workspace really existed; the person who made it was sent nowhere. So
// the cases below come in two halves: the SHAPE a deployment may declare (a validator whose rules
// come from the resolver, not from taste), and the REFUSAL when it declares none — asserted by what
// did not happen, because "the workspace exists and the address does not" is the defect itself.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTenantUrlTemplate, TENANT_URL_TEMPLATE_ENV } from '../auth/tenant-url-template.js'
import { createLocalAdmin } from '../scripts/local-admin.js'
import type postgres from 'postgres'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('#806 the shape a deployment declares', () => {
  it('renders the two templates the documentation offers', () => {
    const shipped = readTenantUrlTemplate('https://{slug}.wikistead.com')
    expect(shipped.ok && shipped.render('acme')).toBe('https://acme.wikistead.com')
    const dev = readTenantUrlTemplate('http://{slug}.localhost:5173')
    expect(dev.ok && dev.render('acme'), 'the port and the scheme survive').toBe('http://acme.localhost:5173')
  })

  it('drops a trailing slash, because every caller appends a path', () => {
    const t = readTenantUrlTemplate('https://{slug}.example.com/')
    expect(t.ok && `${t.render('acme')}/invite?token=x`).toBe('https://acme.example.com/invite?token=x')
  })

  // The four shapes ADR-249 Decision 4 names. Each is something an operator could reasonably write,
  // and each resolves to the WRONG workspace or to none — `resolveTenantFromHost` reads
  // `hostname.split('.')[0]` and nothing else.
  it.each([
    ['https://ws-{slug}.example.com', 'placeholder-not-the-first-label', 'the first label is `ws-<slug>`, so every workspace 404s'],
    ['https://app.{slug}.com', 'placeholder-not-the-first-label', 'the first label is `app`, so nothing ever resolves'],
    ['https://example.com/{slug}', 'placeholder-outside-host', 'resolution is by host — everybody lands in one workspace'],
    ['https://{slug}.com', 'parent-zone-is-a-public-suffix', 'a workspace named `google` would address somebody else’s domain'],
  ])('refuses %s', (template, fault, why) => {
    const verdict = readTenantUrlTemplate(template)
    expect(verdict.ok, why).toBe(false)
    expect(!verdict.ok && verdict.fault).toBe(fault)
  })

  it.each([
    [undefined, 'unset'],
    ['   ', 'unset'],
    ['wiki.example.com', 'no-placeholder'],                      // the likeliest migration error: the old host-only value
    ['https://example.com', 'no-placeholder'],                  // one fixed host cannot address two workspaces
    ['{slug}.example.com', 'unparseable'],                      // the right idea with no scheme — and the scheme is half of what a template is for
    ['https://{slug}.{slug}.example.com', 'repeated-placeholder'],
    ['ftp://{slug}.example.com', 'scheme'],
    ['https://u:p@{slug}.example.com', 'not-an-origin'],
    ['https://{slug}.example.com/wiki', 'not-an-origin'],
    ['https://{slug}.example.com?a=1', 'not-an-origin'],
  ])('refuses %s', (template, fault) => {
    const verdict = readTenantUrlTemplate(template as string | undefined)
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.fault).toBe(fault)
  })

  it('every refusal names the variable, because the operator reads it in a log line', () => {
    for (const t of [undefined, 'wiki.example.com', 'https://{slug}.com', 'https://example.com/{slug}']) {
      const v = readTenantUrlTemplate(t)
      expect(!v.ok && v.why).toContain(TENANT_URL_TEMPLATE_ENV)
    }
  })
})

describe('#806 local-admin refuses before it writes anything', () => {
  // The order inside `createLocalAdmin` is load-bearing and documented as such: the tenant row is
  // written, password sign-in is switched ON, an invite is issued, two operator-ledger rows are
  // added — and the address used to be composed only after all of that, falling back to
  // `<slug>.localhost`. The operator got a link to their own machine and a tenant that had been
  // changed to produce it.
  //
  // So the assertion is not the message: it is that no WRITE ran. A `postgres.Sql` that answers
  // reads with nothing and throws on anything else proves where the refusal sits, which no
  // status-code or message check could.
  const readsOnly = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ? ')
    if (/\b(insert|update|delete)\b/i.test(text)) {
      throw new Error(`a write ran before the refusal: ${text.trim().slice(0, 60)}`)
    }
    return Promise.resolve([])
  }) as unknown as postgres.Sql

  const withoutTemplate = async <T>(body: () => Promise<T>): Promise<T> => {
    const saved = process.env[TENANT_URL_TEMPLATE_ENV]
    delete process.env[TENANT_URL_TEMPLATE_ENV]
    try { return await body() } finally { if (saved !== undefined) process.env[TENANT_URL_TEMPLATE_ENV] = saved }
  }

  it('with no template and no --origin, having written nothing', async () => {
    await withoutTemplate(async () => {
      await expect(createLocalAdmin(readsOnly, { slug: 'acme', email: 'a@example.com', create: true }))
        .rejects.toThrow(/no address to put in the invite link/)
    })
  })

  it('and the refusal tells the operator both ways out', async () => {
    await withoutTemplate(async () => {
      const err = await createLocalAdmin(readsOnly, { slug: 'acme', email: 'a@example.com', create: true })
        .catch((e: Error) => e)
      expect((err as Error).message).toContain('--origin')
      expect((err as Error).message).toContain(TENANT_URL_TEMPLATE_ENV)
    })
  })

  it('but a mistake the operator just made is reported first', async () => {
    // ⚠️ #616 measured this: resolving the address at the top of the function made a typo'd slug
    // answer "no template" instead of "no such tenant — pass --create". Both refuse before any
    // write, so the order between them only decides which problem the operator hears about, and it
    // should be theirs.
    await withoutTemplate(async () => {
      await expect(createLocalAdmin(readsOnly, { slug: 'typoed-slug', email: 'a@example.com' }))
        .rejects.toThrow(/--create/)
    })
  })

  it('and an --origin passed on the command line needs no template at all', async () => {
    // The single-host answer. It must not be collateral damage of closing the door.
    await withoutTemplate(async () => {
      const err = await createLocalAdmin(readsOnly, {
        slug: 'acme', email: 'a@example.com', create: true, origin: 'https://wiki.example.com',
      }).catch((e: Error) => e)
      expect((err as Error).message, 'the refusal must not be about the address').not.toMatch(/no address/)
      expect((err as Error).message, 'it got past the address and tried to write').toMatch(/a write ran/)
    })
  })
})

describe('#806 the retired name is gone', () => {
  // A discovery scan, not a list: the point of retiring a variable is that no copy of it survives
  // anywhere, including the places nobody imports (the environment catalogue, the generated page,
  // the e2e harness's env block).
  //
  // ⚠️ It reads `.env*` EXPLICITLY. A recursive walk skips ignored files, so a developer's own `.env`
  // — the file the server actually loads — never appears in one, and a scan written the obvious way
  // would call the tree clean while the old name sat in it.
  // `.astro` is a build cache, not a source of documentation; everything else here is output.
  const SKIP = new Set(['node_modules', '.git', '.astro', 'dist', 'build', '.turbo', 'coverage', 'test-results', 'playwright-report'])

  function walk(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full, out)
      else if (/\.(ts|tsx|mjs|js|json|md|ya?ml|example)$/.test(entry)) out.push(full)
    }
    return out
  }

  // ⚠️ The walk deliberately enters `docs-site/`, which is a SEPARATE repository living inside this
  // one. It is where the published documentation is served from, so a retired variable surviving
  // there is the same defect wearing a different hat — and this repo's own diff cannot see it.
  it('PUBLIC_TENANT_BASE_HOST survives only where this ADR is described', () => {
    const files = [...walk(REPO, []), ...readdirSync(REPO).filter((f) => f.startsWith('.env')).map((f) => join(REPO, f))]
    // A broken walk finding nothing reads exactly like a clean tree, so the count is the guard.
    expect(files.length, 'the walk scanned nothing — it is measuring nothing').toBeGreaterThan(500)
    console.error(`#806 retirement scan: ${files.length} file(s) scanned for PUBLIC_TENANT_BASE_HOST`)

    const survivors = files.filter((f) => {
      if (f.includes(`${join('docs', 'adr')}`)) return false           // the decision records say what was retired
      if (f.endsWith('workspace-address-806.test.ts')) return false    // this file names it to forbid it
      return readFileSync(f, 'utf8').includes('PUBLIC_TENANT_BASE_HOST')
    })
    expect(survivors.map((f) => f.slice(REPO.length + 1))).toEqual([])
  })
})

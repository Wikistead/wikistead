// Integration test — real SMTP via Mailpit (docker compose), no mocks. Verifies
// the SmtpEmailDriver actually delivers (read back through Mailpit's HTTP API) and
// that the no-SMTP path degrades to a no-op.
import { describe, it, expect, afterEach } from 'vitest'
import { resolveEmailDriver, SmtpEmailDriver, NoopEmailDriver } from '../email/index.js'

// #268: read Mailpit's HTTP API from env (the isolated server-test stack uses a distinct host
// port); defaults to the dev port so a plain `docker compose up` checkout still works.
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025/api/v1'

describe('resolveEmailDriver', () => {
  const saved = process.env.SMTP_HOST
  afterEach(() => { if (saved === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = saved })

  it('returns the SMTP driver when SMTP_HOST is set, the no-op driver otherwise', () => {
    process.env.SMTP_HOST = 'localhost'
    expect(resolveEmailDriver()).toBeInstanceOf(SmtpEmailDriver)
    delete process.env.SMTP_HOST
    expect(resolveEmailDriver()).toBeInstanceOf(NoopEmailDriver)
  })
})

describe('SmtpEmailDriver (real SMTP via Mailpit)', () => {
  it('delivers an email that Mailpit captures', async () => {
    await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' }) // clear
    // #268: send to the SMTP port from env (server-test Mailpit is on a distinct port) so the send
    // target matches MAILPIT_API_URL; defaults to the dev port for a plain checkout.
    const driver = new SmtpEmailDriver({ host: process.env.SMTP_HOST ?? 'localhost', port: Number(process.env.SMTP_PORT ?? 1025), secure: false, from: 'wikistead <test@wikistead.local>' })
    const to = `p13-${Date.now()}@example.test`
    await driver.send({ to, subject: 'P1.3 email check', html: '<p>hello</p>', text: 'hello' })

    // Mailpit processes synchronously; a brief poll covers any lag.
    let msg: { To: { Address: string }[]; Subject: string } | undefined
    for (let i = 0; i < 10 && !msg; i++) {
      const r = await fetch(`${MAILPIT_API}/messages`)
      const body = (await r.json()) as { messages: { To: { Address: string }[]; Subject: string }[] }
      msg = body.messages.find((m) => m.To.some((t) => t.Address === to))
      if (!msg) await new Promise((res) => setTimeout(res, 100))
    }
    expect(msg, 'email delivered to Mailpit').toBeTruthy()
    expect(msg!.Subject).toBe('P1.3 email check')
  })
})

describe('NoopEmailDriver (degrade)', () => {
  it('send is a no-op and never throws', async () => {
    await expect(new NoopEmailDriver().send({ to: 'x@y.test', subject: 's', html: '', text: '' })).resolves.toBeUndefined()
  })
})

// #578 (review rejection 2026-08-05): "FGA API Validation Error: post write : Error cannot delete a tuple
// which does not exist: user: 'user:89e7…', relation: 'viewer', object: 'space:demo_space'" was shown to
// an ADMIN as the reason their role change failed. Fastify forwards a thrown error's message, and the
// FGA SDK's errors carry statusCode 400, so anything the store refuses became a 400 with its internals.
//
// Pinned at the boundary every tuple write goes through, rather than per route: a route that starts
// writing tuples tomorrow is covered by using the helpers.
import { describe, it, expect } from 'vitest'
import { writeTuples, deleteTuples } from '@wikistead/authz'

/** A stand-in for the SDK's validation refusal: the shape (statusCode 400 + its own text). */
const refusing = (message: string) => ({
  write: async () => {
    throw Object.assign(new Error(message), { statusCode: 400, apiErrorCode: 'write_failed_due_to_invalid_input' })
  },
}) as never

const FGA_TEXT = "FGA API Validation Error: post write : Error cannot delete a tuple which does not exist: user: 'user:89e7', relation: 'viewer', object: 'space:demo_space'"

describe('#578: the permission store\'s own words do not reach the caller', () => {
  for (const [label, run] of [
    ['writeTuples', () => writeTuples(refusing(FGA_TEXT), [{ user: 'user:x', relation: 'viewer', object: 'space:s' }])],
    ['deleteTuples', () => deleteTuples(refusing(FGA_TEXT), [{ user: 'user:x', relation: 'viewer', object: 'space:s' }])],
  ] as const) {
    it(`${label}: the message is replaced and the cause is kept`, async () => {
      const err = await run().then(() => null, (e: unknown) => e) as { message: string; code?: string; statusCode?: number; cause?: unknown };
      expect(err, 'it still throws — the refusal is not swallowed').toBeTruthy();
      expect(err.message, 'no FGA vocabulary in what the caller sees').not.toMatch(/FGA API|tuple|relation:/i);
      expect(err.code, 'a code the surface can translate').toBe('authz_write_refused');
      // the caller sent a valid request; a tuple set our own code built being rejected is our bug
      expect(err.statusCode, 'not reported as the caller\'s fault').toBe(500);
      expect((err.cause as { message?: string })?.message, 'the original is kept for the log').toContain('FGA API');
    });
  }

  it('a non-validation failure passes through untouched (transport, auth, outage)', async () => {
    const boom = { write: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { statusCode: 503 }) } } as never;
    const err = await writeTuples(boom, [{ user: 'user:x', relation: 'viewer', object: 'space:s' }])
      .then(() => null, (e: unknown) => e) as { message: string; code?: string };
    expect(err.message, 'an outage is not a validation refusal and keeps its own diagnosis').toContain('ECONNREFUSED');
    expect(err.code).toBeUndefined();
  });
});

/**
 * A write that arrived without a body is a BAD REQUEST, not a crash (#667).
 *
 * Fastify leaves `req.body` UNDEFINED when a request carries no body at all — no payload and no
 * content-type. Nothing here declares a Fastify `schema`, so nothing catches that before the handler,
 * and the ordinary way these handlers are written (`req.body.title`) throws a TypeError the moment it
 * runs. `curl -X PATCH /pages/anything` answered 500.
 *
 * Two things were wrong with that. A malformed request deserves 400 — a 500 says the server is broken,
 * and it was not. And it broke the UNIFORM refusal: every other way of asking about a page you may not
 * see answers the same, deliberately, so the answer cannot be read as "this exists". A route that
 * crashes answers differently from all of them, and which routes crash is itself a map.
 *
 * ⚠️ Deliberately NOT a global rule. Roughly sixty parameterised writes here take no body at all
 * (`POST /pages/:id/publish` and its kin), and a blanket "every write needs a body" would refuse every
 * one of them. This is opted into where the handler actually reads the body.
 *
 * ⚠️ And it is not a validator. It answers "is there a body", nothing about what is in it — the
 * per-field checks each handler already does are unchanged. The guard against the NEXT handler written
 * this way is `bodyless-write-667`, which walks every registered write rather than naming these five.
 */
export function requireBody<T>(body: T | undefined | null): T {
  if (body == null || typeof body !== 'object') {
    throw Object.assign(new Error('a request body is required'), { statusCode: 400, code: 'body_required' })
  }
  return body
}

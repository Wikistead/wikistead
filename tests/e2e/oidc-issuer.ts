// Minimal REAL OpenID Provider for e2e (not a mock): discovery + JWKS + /authorize
// + /token, signing real RS256 id_tokens with jose. Lets the e2e browser drive the
// genuine OIDC login flow through the same-origin proxy. /authorize auto-approves
// and issues a fixed subject (default "dev-user", which fga:seed already grants
// tenant#member), so no extra provisioning is needed.
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";

export interface E2eIssuer {
  url: string;
  close(): Promise<void>;
}

export async function startE2eIssuer(opts: { clientId: string; sub?: string; port?: number }): Promise<E2eIssuer> {
  const sub = opts.sub ?? "dev-user";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "e2e-key";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const codes = new Map<string, { nonce: string; codeChallenge: string | null }>();
  let seq = 0;

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const issuerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

    if (u.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        jwks_uri: `${issuerUrl}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
      });
    }
    if (u.pathname === "/jwks") return json({ keys: [jwk] });

    if (u.pathname === "/authorize") {
      const code = `e2e-code-${++seq}`;
      codes.set(code, { nonce: u.searchParams.get("nonce") ?? "", codeChallenge: u.searchParams.get("code_challenge") });
      const loc = `${u.searchParams.get("redirect_uri")}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(u.searchParams.get("state") ?? "")}`;
      res.writeHead(302, { location: loc });
      return res.end();
    }

    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          const p = new URLSearchParams(body);
          const pending = codes.get(p.get("code") ?? "");
          codes.delete(p.get("code") ?? "");
          if (!pending) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"invalid_grant"}'); }
          const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
          if (pending.codeChallenge && pending.codeChallenge !== challenge) {
            res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"invalid_grant"}');
          }
          const idToken = await new SignJWT({ nonce: pending.nonce, email: `${sub}@e2e.test`, name: sub })
            .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
            .setIssuedAt().setIssuer(issuerUrl).setAudience(opts.clientId).setSubject(sub).setExpirationTime("5m")
            .sign(privateKey as KeyLike);
          json({ access_token: "e2e-access", id_token: idToken, token_type: "Bearer", expires_in: 300 });
        })();
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  server.unref(); // don't keep the Playwright process alive at teardown
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

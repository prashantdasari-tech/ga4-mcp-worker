# PRODUCTION.md — hardening and runbook

Read this before you tell more than a couple of people about the server.

> **This document describes the current production design: per-user Google OAuth.** An earlier
> version of this server ran a shared-secret mode (one hand-minted `GOOGLE_REFRESH_TOKEN` for
> everyone, one `SHARED_SECRET` password). That mode, and a staging environment used to prove OAuth
> before promoting it, have both been retired and torn down — the Worker, its secrets, and its KV
> namespace no longer exist. Nothing below refers to either.

This is part 1 of 2. Local development, the incident runbook, the security checklist, and the OAuth
implementation reference are in
[docs/PRODUCTION-PART2.md](docs/PRODUCTION-PART2.md) (§5–§8).

---

## 1. The identity model

Each teammate signs into Google themselves. The Worker stores their grant — their own refresh token,
encrypted — and every query they run uses their own token, with their own real GA4 access. See
[docs/PRODUCTION-PART2.md § 8](docs/PRODUCTION-PART2.md#8-how-per-user-oauth-is-implemented) for
exactly how this is implemented and stored.

This resolves the three problems a single shared credential has:

1. **Offboarding is no longer a silent risk.** When someone loses GA4 access (leaves Zuddl, is
   removed from a property), their queries here stop working immediately and automatically — there is
   no separate "someone forgot this Worker exists" failure mode, because there's no single credential
   whose owner leaving breaks everyone.
2. **GA4 audit logs are correct.** Every query is attributed to the real person who asked it.
3. **There is no password that acts as an impersonation key.** Nobody can read GA4 "as" someone else
   by holding a shared secret, because there isn't one. Google's own per-property access control is
   the only gate.

### What's left

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are still a single pair, shared across every user's
sign-in — this is unavoidable, since Google requires one app registration regardless of how many
people use it. If `GOOGLE_CLIENT_SECRET` leaks, the practical risk is someone standing up a
lookalike consent flow against your registered app, not direct data access (they still can't read
GA4 without a real person completing a real Google sign-in). Rotation is in § 4.

The Google Cloud **project** that owns this OAuth client has an owner — whoever created it. That's an
administrative fact about the Cloud project, not a data-access dependency: losing that person doesn't
break anyone's queries, it just means someone else needs Owner/Editor rights on the Cloud project
before they can rotate the client secret or change consent-screen settings. Worth having at least one
other person with access to the Cloud project for exactly that reason.

---

## 2. Monitoring

**The failure mode to design around is a quiet, partial one:** an individual teammate's Google grant
can expire or be revoked without anything on the Worker itself breaking. The connector still shows
connected for them, and their queries fail with an auth error they'll likely read as "Claude being
flaky" rather than "I need to reconnect."

`/health` is unauthenticated and returns no analytics data. In this auth mode it checks what's
actually shared infrastructure — the app registration and the grant store — not any individual's
sign-in, since there is no single credential left to represent "the server":

```bash
curl -s https://ga4-mcp-worker.YOUR-SUBDOMAIN.workers.dev/health
```

- `200 {"status":"ok","auth":"oauth", "note": "..."}` — app config and `OAUTH_KV` are both reachable.
- `503 {"status":"error","auth":"invalid","detail":"..."}` — one of those two is broken (e.g.
  `GOOGLE_CLIENT_ID`/`SECRET` missing, or the KV binding is gone).

**Point a free uptime monitor at it anyway** (UptimeRobot, Better Stack, Cronitor, 5-minute interval)
— it catches the shared-infrastructure failures fast, it's just not a substitute for individuals
noticing their own sign-in died. If a teammate reports "it stopped working for me" but `/health` is
green, that's expected: ask them to reconnect via `/mcp` in Claude Code rather than treating it as a
server incident.

**Live logs:**

```bash
npm run tail
```

The Worker emits one JSON line per MCP request, per rejected auth attempt, per tool error, per health
failure, and per OAuth event (`oauth_authorize_redirect`, `oauth_authorized`, `oauth_domain_rejected`,
`oauth_google_error`, `oauth_token_exchange_failed`). No token material is ever logged — `oauth_authorized`
logs the signer's Google `sub` and email domain only. With `[observability] enabled = true` in
`wrangler.toml`, these are also queryable in the Cloudflare dashboard under **Workers & Pages → your
Worker → Logs**.

Watch for repeated `oauth_domain_rejected` from the same source, or a burst of `401`s on `/mcp` —
either suggests someone probing the endpoint rather than a real teammate.

---

## 3. GA4 API quotas

GA4 Data API quotas are **per property, per day**, and they are token-based rather than
request-based: a request's cost scales with how expensive it is to compute. Buckets that matter here
are core tokens per property per day, tokens per property per hour, and concurrent requests.

Quota is consumed by whoever's token makes the request — in this auth mode, that's the querying
teammate's own quota allowance against that property, not a single shared budget. Heavy use by one
person does not exhaust another's ability to query, though the property-level daily ceiling is still
shared underneath.

**What burns quota fastest:**

- Many dimensions in one request, especially high-cardinality ones (`pagePath`, `pageLocation`,
  `sessionSource`)
- Long date ranges, and multiple date ranges in one request
- Large `limit` values
- Complex nested filter expressions
- Realtime requests, which draw on a separate and smaller pool

**Diagnosing.** Every reporting tool accepts `return_property_quota: true`. Ask Claude to re-run a
query with it set, and the response carries the remaining tokens per bucket. Do this *before* a big
batch of queries, not after you get a 429.

**Mitigations, in the order worth trying:**

1. **Ask for fewer, broader reports.** The tool descriptions already push Claude toward one broader
   query filtered client-side rather than several narrow ones — this is the single biggest lever.
2. **Prefer explicit date ranges** over relative ones, and keep them as short as the question needs.
3. **Do not paginate through 250,000 rows** to answer a question that an aggregate would settle. Use
   `limit` with `order_bys` to get the top N.
4. **Push heavy recurring analysis to BigQuery.** If GA4 → BigQuery export is on, a scheduled query
   there costs zero GA4 quota and handles volumes this API never will.
5. If you genuinely need more, request a quota increase in the Google Cloud Console, or look at
   GA4 360.

Quota exhaustion is per-property, so heavy use of the canonical property does not affect the legacy
ones.

---

## 4. Rotation and revocation

### Rotating `GOOGLE_CLIENT_SECRET`

This affects **new sign-ins only** — teammates who already have a stored grant keep working, since
their own refresh token isn't tied to the client secret staying the same in the way you'd expect.
Still, treat a rotation as a real change:

1. Google Cloud Console → Credentials → your OAuth client → reset/regenerate the client secret.
2. `npx wrangler secret put GOOGLE_CLIENT_SECRET --env=""`
3. `npm run deploy`

**Rotate immediately if:** it was pasted into a chat, doc, ticket, or screenshot, or committed to
git.

### Revoking one teammate's access

This is new — the old shared-secret design had no such thing as "one person's" access. Two ways,
pick based on who's asking:

- **The teammate no longer has GA4 access at all** (left Zuddl, removed from the property): nothing
  to do here. Their next query fails at Google's end with `403 PERMISSION_DENIED`, correctly, without
  any action from you.
- **You want to force-revoke someone specifically, e.g. they still have GA4 access but shouldn't use
  this connector:** delete their grant directly from the KV store. Find their Google `sub` in the
  `oauth_authorized` log line from when they connected, then:

  ```bash
  npx wrangler kv key list --namespace-id <your-OAUTH_KV-id> --remote | grep <their-sub>
  npx wrangler kv key delete --namespace-id <your-OAUTH_KV-id> "grant:<their-sub>:<grant-id>" --remote
  ```

  They'll need to sign in again to regain access, which is the point.

### If you ever need the old shared-secret mode back

The code still supports `AUTH_MODE = "secret"` (see `src/index.ts`), but the credentials for it were
deleted along with the retired Worker and are not recoverable. Reviving it means minting a fresh
`GOOGLE_REFRESH_TOKEN` and a fresh `SHARED_SECRET` from scratch — there is no faster path back.

---

**Continued in [docs/PRODUCTION-PART2.md](docs/PRODUCTION-PART2.md):** § 5 local development,
§ 6 runbook, § 7 security checklist, § 8 how per-user OAuth is implemented.

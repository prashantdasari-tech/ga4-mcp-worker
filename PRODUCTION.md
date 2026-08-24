# PRODUCTION.md — hardening and runbook

Read this before you tell more than a couple of people about the server.

> **This document describes the current production design: per-user Google OAuth.** An earlier
> version of this server ran a shared-secret mode (one hand-minted `GOOGLE_REFRESH_TOKEN` for
> everyone, one `SHARED_SECRET` password). That mode, and a staging environment used to prove OAuth
> before promoting it, have both been retired and torn down — the Worker, its secrets, and its KV
> namespace no longer exist. Nothing below refers to either.

---

## 1. The identity model

Each teammate signs into Google themselves. The Worker stores their grant — their own refresh token,
encrypted — and every query they run uses their own token, with their own real GA4 access. See § 8
for exactly how this is implemented and stored.

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

## 5. Local development

```bash
cp .dev.vars.example .dev.vars
```

Fill in real values, then:

```bash
npm run dev
```

`.dev.vars` is gitignored and must stay that way. Local dev talks to the **real** Google APIs and
consumes **real** GA4 quota against the real property — there is no sandbox. Prefer short date ranges
and small `limit`s while iterating.

Before every deploy:

```bash
npm run typecheck && npm run dry-run
```

There is currently no persistent staging environment — the one used to prove OAuth mode before
promotion was torn down after it served its purpose (§ 8 has the history, for context). If you want
to test a risky change in isolation before it reaches teammates, the cheapest approach is a temporary
second Worker: `npx wrangler deploy --name ga4-mcp-worker-test`, with its own KV namespace and OAuth
client redirect URI, torn down the same way once you're done (§ 8 documents the exact commands used
last time, as a template).

---

## 6. Runbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns 503 | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` missing, or `OAUTH_KV` binding broken | `npx wrangler secret list --env=""`; confirm `wrangler.toml`'s `[[kv_namespaces]]` block still points at a real namespace |
| `/health` is green but one specific person's queries fail | Their individual grant expired, was revoked at Google's end, or you force-revoked it (§ 4) | Have them run `/mcp` in Claude Code and reconnect — this is expected and not a server incident |
| A teammate gets `redirect_uri_mismatch` during sign-in | The OAuth client's redirect URIs don't include this exact hostname's `/callback` | Google Cloud Console → Credentials → your client → Authorized redirect URIs — add the missing one |
| "That account cannot be used" during sign-in | `ALLOWED_EMAIL_DOMAIN` is set and they used a non-`@zuddl.com` account | Expected — sign in with the correct account |
| Sign-in succeeds but every tool returns `403 PERMISSION_DENIED` | That person's own Google account can't see the property, or an API is disabled on the Cloud project | Ask them to run `get_account_summaries` — it lists exactly what their token can see. Grant GA4 property access, or re-enable the Data/Admin API |
| Numbers disagree with the GA4 UI | Almost always date-range semantics: relative ranges, timezone, or partial "today" data | Re-run with explicit `YYYY-MM-DD`. Check the reporting timezone via `get_property_details`. Exclude today |
| Custom dimension rejected as `INVALID_ARGUMENT` | Using the GA4 UI parameter name instead of the API name | Call `get_custom_dimensions_and_metrics` and use the `apiName` verbatim (e.g. `customEvent:form_id`) |
| Realtime query fails but the same fields work in `run_report` | Realtime has a separate, smaller schema | Check the [realtime schema](https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema). Custom metrics are unavailable; custom dimensions must be user-scoped (`customUser:`) |
| `429` / quota errors | Per-property daily token quota exhausted | Re-run with `return_property_quota: true`; see § 3 |
| Deploy fails on `nodejs_compat` | `compatibility_flags` removed or `compatibility_date` moved backwards | Restore `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml` |
| Connector shows connected but lists zero tools | Client hit the wrong path or transport | URL must end in `/mcp`. This server speaks Streamable HTTP, not SSE |
| `401` with a `WWW-Authenticate: Bearer` header | Correct behaviour for an unauthenticated request — not a bug | The client needs to complete `/authorize` first; a real MCP client (Claude Code) does this automatically via `/mcp` |

---

## 7. Security checklist

- [ ] OAuth consent screen user type is **Internal** (SETUP-GUIDE Part 1.3) — restricts sign-in to
      `@zuddl.com` at the Google level, before `ALLOWED_EMAIL_DOMAIN` even runs.
- [ ] `ALLOWED_EMAIL_DOMAIN` is set to `zuddl.com` in `wrangler.toml` as a second, server-side check.
- [ ] `GOOGLE_CLIENT_SECRET` has never been in Slack, a doc, a ticket, or a screenshot.
- [ ] `git status` is clean of `.dev.vars`, `*client_secret*.json`, and any ADC JSON. Verify with
      `git check-ignore -v .dev.vars`.
- [ ] `git log -p | grep -i "client_secret\|GOCSPX"` finds nothing. If it does, rotate immediately
      (§ 4) — deleting the commit alone is not enough.
- [ ] An uptime monitor watches `/health` and alerts a channel a human actually reads.
- [ ] At least one person besides you has Owner/Editor access to the Google Cloud project, so client
      secret rotation isn't blocked on one person (§ 1).
- [ ] You have confirmed `/mcp` rejects an unauthenticated request with `401` (SETUP-GUIDE Part 3.3).
- [ ] You've read § 4 and know how to revoke one teammate's access specifically, not just everyone's.

---

## 8. How per-user OAuth is implemented

This section is the technical reference for the design in § 1 — what's actually stored, where, and
how it was rolled out. Useful if you're debugging the auth flow itself or reviewing what data this
server holds about each teammate.

### The two auth modes in the code

The Worker supports two modes via `AUTH_MODE` in `wrangler.toml`, both fully implemented in
`src/index.ts`:

| | `"secret"` (retired, not deployed) | `"oauth"` (current) |
|---|---|---|
| Google credential | One shared `GOOGLE_REFRESH_TOKEN` | Each user's own, obtained at sign-in |
| Teammate auth | `SHARED_SECRET` in an `x-api-key` header | Google sign-in |
| Queries run as | Whoever held the shared token | The person asking |
| Onboarding | Send them the secret | Send them the URL |

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are required in both — they register the app itself, not
any individual's access.

### Scopes requested

`analytics.readonly` (the only data scope), plus `openid` and `email`. The latter two grant no access
to any data — they exist so the Worker learns a stable user ID to key the grant on, and an email for
logs. Without them every grant would be anonymous and unable to be revoked per person. See
`GOOGLE_SCOPES` in `src/google-oauth.ts`.

### How grants are stored

One record per user in the `OAUTH_KV` namespace. The user's Google refresh token lives in the
record's `props`, which `@cloudflare/workers-oauth-provider` **encrypts with AES-GCM**, keyed off the
corresponding MCP token. `userId` and `metadata` are **not** encrypted — the library needs them
unencrypted to enumerate and revoke grants — which is why grants are keyed on Google's opaque `sub`
rather than on email, and the email itself lives inside the encrypted `props`.

### Rollout history

Built and proven on a temporary staging Worker (`ga4-mcp-worker-staging`) with its own KV namespace,
verified end-to-end — a real Google sign-in completed, a grant was confirmed written to KV via
`wrangler kv key list --remote` (not just inferred from a green checkmark), and a live query returned
the correct GA4 properties. Promoted to production on 2026-08-11:

1. Production `/callback` URI added to the same Google OAuth client already used for staging.
2. `AUTH_MODE` flipped to `"oauth"` in the top-level `[vars]`, with a fresh production `OAUTH_KV`
   namespace (deliberately not reusing staging's, to keep test data out of production).
3. Deployed. Confirmed via direct request that the old `x-api-key` header now gets `401` — the old
   door is provably closed, not just assumed closed.
4. `ga4` connector removed and re-added without a header; reconnected via Google sign-in.
5. `GOOGLE_REFRESH_TOKEN` and `SHARED_SECRET` deleted from the Worker's secrets.
6. Staging fully decommissioned: connector removed from Claude Code, staging Worker deleted
   (`wrangler delete --env staging`), staging KV namespace deleted.

One step outside the Worker's control: the **old shared refresh token still exists on Google's side**
until someone with that Google account visits myaccount.google.com/permissions and removes the app's
access there. Deleting the secret from Cloudflare doesn't reach into Google to revoke it.

# PRODUCTION.md, continued — dev, runbook, security, OAuth design

Continued from [PRODUCTION.md](../PRODUCTION.md) §1–4 (identity model, monitoring, quotas, rotation).
This part covers local development, the incident runbook, the pre-rollout security checklist, and how
per-user OAuth is actually implemented under the hood.

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
promotion was torn down after it served its purpose (§ 8 below has the history, for context). If you
want to test a risky change in isolation before it reaches teammates, the cheapest approach is a
temporary second Worker: `npx wrangler deploy --name ga4-mcp-worker-test`, with its own KV namespace
and OAuth client redirect URI, torn down the same way once you're done (§ 8 documents the exact
commands used last time, as a template).

---

## 6. Runbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns 503 | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` missing, or `OAUTH_KV` binding broken | `npx wrangler secret list --env=""`; confirm `wrangler.toml`'s `[[kv_namespaces]]` block still points at a real namespace |
| `/health` is green but one specific person's queries fail | Their individual grant expired, was revoked at Google's end, or you force-revoked it ([§ 4](../PRODUCTION.md#4-rotation-and-revocation)) | Have them run `/mcp` in Claude Code and reconnect — this is expected and not a server incident |
| A teammate gets `redirect_uri_mismatch` during sign-in | The OAuth client's redirect URIs don't include this exact hostname's `/callback` | Google Cloud Console → Credentials → your client → Authorized redirect URIs — add the missing one |
| "That account cannot be used" during sign-in | `ALLOWED_EMAIL_DOMAIN` is set and they used a non-`@zuddl.com` account | Expected — sign in with the correct account |
| Sign-in succeeds but every tool returns `403 PERMISSION_DENIED` | That person's own Google account can't see the property, or an API is disabled on the Cloud project | Ask them to run `get_account_summaries` — it lists exactly what their token can see. Grant GA4 property access, or re-enable the Data/Admin API |
| Numbers disagree with the GA4 UI | Almost always date-range semantics: relative ranges, timezone, or partial "today" data | Re-run with explicit `YYYY-MM-DD`. Check the reporting timezone via `get_property_details`. Exclude today |
| Custom dimension rejected as `INVALID_ARGUMENT` | Using the GA4 UI parameter name instead of the API name | Call `get_custom_dimensions_and_metrics` and use the `apiName` verbatim (e.g. `customEvent:form_id`) |
| Realtime query fails but the same fields work in `run_report` | Realtime has a separate, smaller schema | Check the [realtime schema](https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema). Custom metrics are unavailable; custom dimensions must be user-scoped (`customUser:`) |
| `429` / quota errors | Per-property daily token quota exhausted | Re-run with `return_property_quota: true`; see [§ 3](../PRODUCTION.md#3-ga4-api-quotas) |
| Deploy fails on `nodejs_compat` | `compatibility_flags` removed or `compatibility_date` moved backwards | Restore `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml` |
| Connector shows connected but lists zero tools | Client hit the wrong path or transport | URL must end in `/mcp`. This server speaks Streamable HTTP, not SSE |
| `401` with a `WWW-Authenticate: Bearer` header | Correct behaviour for an unauthenticated request — not a bug | The client needs to complete `/authorize` first; a real MCP client (Claude Code) does this automatically via `/mcp` |

---

## 7. Security checklist

- [ ] OAuth consent screen user type is **Internal**
      ([SETUP-GUIDE Part 1.3](../SETUP-GUIDE.md#13--configure-the-consent-screen)) — restricts sign-in
      to `@zuddl.com` at the Google level, before `ALLOWED_EMAIL_DOMAIN` even runs.
- [ ] `ALLOWED_EMAIL_DOMAIN` is set to `zuddl.com` in `wrangler.toml` as a second, server-side check.
- [ ] `GOOGLE_CLIENT_SECRET` has never been in Slack, a doc, a ticket, or a screenshot.
- [ ] `git status` is clean of `.dev.vars`, `*client_secret*.json`, and any ADC JSON. Verify with
      `git check-ignore -v .dev.vars`.
- [ ] `git log -p | grep -i "client_secret\|GOCSPX"` finds nothing. If it does, rotate immediately
      ([§ 4](../PRODUCTION.md#4-rotation-and-revocation)) — deleting the commit alone is not enough.
- [ ] An uptime monitor watches `/health` and alerts a channel a human actually reads.
- [ ] At least one person besides you has Owner/Editor access to the Google Cloud project, so client
      secret rotation isn't blocked on one person ([§ 1](../PRODUCTION.md#1-the-identity-model)).
- [ ] You have confirmed `/mcp` rejects an unauthenticated request with `401`
      ([SETUP-GUIDE Part 3.3](SETUP-GUIDE-PART2.md#33--mcp-demands-a-real-token)).
- [ ] You've read [§ 4](../PRODUCTION.md#4-rotation-and-revocation) and know how to revoke one
      teammate's access specifically, not just everyone's.

---

## 8. How per-user OAuth is implemented

This section is the technical reference for the design in
[§ 1](../PRODUCTION.md#1-the-identity-model) — what's actually stored, where, and how it was rolled
out. Useful if you're debugging the auth flow itself or reviewing what data this server holds about
each teammate.

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

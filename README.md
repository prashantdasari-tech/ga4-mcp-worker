# ga4-mcp-worker

A **read-only** Google Analytics 4 MCP server that runs on Cloudflare Workers, so teammates can query
GA4 from Claude with nothing installed locally — no Python, no gcloud, no ADC file, and as of this
version, **no shared password either.** Adding it means clicking "Connect," signing in with your own
Google account, and answering GA4 questions as yourself.

It mirrors the tool surface of the official
[`googleanalytics/google-analytics-mcp`](https://github.com/googleanalytics/google-analytics-mcp)
stdio server, but calls the Google Analytics REST APIs directly, because Google's client libraries do
not run on the Workers runtime.

> **Read this first:** [§ What has and has not been tested](#what-has-and-has-not-been-tested). Live
> end-to-end verification is in, but a few surfaces (the v1alpha endpoints, pagination) remain
> fixture-only.

### Auth mode: per-user OAuth

Each teammate signs in with their own Google account. There is no shared secret and no single Google
credential that everyone relies on — see [PRODUCTION.md § 1](PRODUCTION.md#1-the-identity-problem)
and [§ 8](PRODUCTION.md#8-per-user-oauth-mode-auth_mode--oauth) for the full design and how it differs
from the retired shared-secret mode. Sign-in is restricted to `@zuddl.com` Google accounts
(`ALLOWED_EMAIL_DOMAIN` in `wrangler.toml`).

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are still required — Google requires every app that
requests user data to be registered, and those two values *are* the registration, set once at deploy.
What is gone is the hand-minted refresh token and the password teammates used to type in.

---

## Documentation

| File                                 | What it is                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **[SETUP-GUIDE.md](SETUP-GUIDE.md)** | First deploy, explained from scratch — assumes no prior OAuth knowledge. Creating the Google app, minting a correctly-scoped refresh token, deploying, testing, connecting Claude. **Start here.** |
| **[PRODUCTION.md](PRODUCTION.md)**   | The identity problem, monitoring, GA4 quotas, secret rotation, staging, runbook, security checklist. Read before a wide rollout. |
| `src/index.ts`                       | The MCP server: tools, fetch helpers, normaliser, router. Heavily commented.              |
| `src/google-oauth.ts`                | The "sign in with Google" handler — `/authorize` and `/callback`. Heavily commented.      |
| `wrangler.toml`                      | Worker config. Note `nodejs_compat` — see gotchas.                                       |
| `.dev.vars.example`                  | Template for local dev. Copy to `.dev.vars` (gitignored).                                |

---

## Our GA4 properties

| Property ID     | Name                              | Measurement ID | Status                                                 |
| --------------- | --------------------------------- | -------------- | ------------------------------------------------------ |
| **`314138239`** | **New zuddl website GA4 property**| `G-JWBQ2Z84QF` | **Canonical — use this one unless told otherwise.**    |
| `260479909`     | legacy                            | —              | Legacy. Historical only; do not use for current reporting. |
| `328977581`     | legacy                            | —              | Legacy. Historical only; do not use for current reporting. |

The server is **property-agnostic**: every tool takes `property_id`, and accepts either `314138239`
or `"properties/314138239"`. If omitted, it falls back to `DEFAULT_PROPERTY_ID` in `wrangler.toml`,
which is set to the canonical property so teammates do not have to memorise a number. Call
`get_account_summaries` to list everything the credentials can actually see.

---

## Tools (9)

| Tool                                | Method + endpoint                                                    | What it is for                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `run_report`                        | POST `analyticsdata.googleapis.com/v1beta/properties/{id}:runReport` | **The workhorse.** Historical reporting. Full parameter set.                   |
| `run_realtime_report`               | POST `.../v1beta/properties/{id}:runRealtimeReport`                  | Last ~30 minutes. Separate, smaller schema.                                    |
| `run_funnel_report`                 | POST `.../v1alpha/properties/{id}:runFunnelReport`                   | Ordered step sequences and drop-off.                                           |
| `run_conversions_report`            | POST `.../v1alpha/properties/{id}:runReport`                         | Conversions, ad spend, ROAS, attribution modelling. Restricted field list.     |
| `get_custom_dimensions_and_metrics` | GET `.../v1beta/properties/{id}/metadata`                            | Custom fields **with the queryable `apiName`**. Call before using custom fields. |
| `get_account_summaries`             | GET `analyticsadmin.googleapis.com/v1beta/accountSummaries`          | Everything these credentials can read. No arguments.                           |
| `get_property_details`              | GET `.../v1beta/properties/{id}`                                     | Timezone, currency, service level. Timezone explains date mismatches.          |
| `list_property_annotations`         | GET `.../v1alpha/properties/{id}/reportingDataAnnotations`           | Dated notes explaining spikes and dips.                                        |
| `list_google_ads_links`             | GET `.../v1beta/properties/{id}/googleAdsLinks`                      | Linked Ads accounts. Confirms whether ad-cost metrics can have data.           |

`run_report` accepts the full official parameter set: `property_id`, `date_ranges` (a **list**, so
period-over-period works in one request), `dimensions`, `metrics`, `dimension_filter`,
`metric_filter`, `order_bys`, `limit`, `offset`, `currency_code`, `return_property_quota`.
`run_realtime_report` takes the same shape minus `date_ranges` and `currency_code`.

Tool descriptions are long on purpose — they carry worked examples for every filter shape, and they
are the only place the model learns the request format. Treat edits to them as behaviour changes.

---

## Endpoints

| Endpoint                                       | Auth                | Purpose                                                                       |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `POST /mcp`                                     | OAuth bearer token  | The MCP connection (Streamable HTTP). There is no `/sse`.                     |
| `GET /authorize`, `POST /token`, `POST /register` | —                  | OAuth endpoints, implemented by `@cloudflare/workers-oauth-provider`.         |
| `GET /callback`                                 | —                   | Google redirects here after sign-in. Not for humans to open directly.        |
| `GET /health`                                   | **none**            | Status check. `200 {"status":"ok","auth":"oauth", ...}` or `503` + detail. See the note below — it means less here than it did in shared-secret mode. Leaks no data. Point an uptime monitor at it. |
| `GET /`                                         | none                | Plain-text status banner, names the current auth mode.                       |

Anything else returns 404.

> **`/health` proves less in OAuth mode.** There is no single shared credential to exercise, so a
> `200` only confirms the app registration is configured and the grant store (`OAUTH_KV`) is
> reachable — not that any particular person's sign-in is still valid. An individual user's grant can
> be expired or revoked while `/health` is green. This is inherent to per-user auth, not a defect.

The Worker logs one JSON line per MCP request, per rejected auth attempt, per tool error, and per
health failure, plus OAuth-specific events (`oauth_authorize_redirect`, `oauth_authorized`,
`oauth_domain_rejected`, etc.). No token material is ever logged. All Google API calls send a custom
`User-Agent` (`ga4-mcp-worker/1.0.0 (+cloudflare-workers)`) so quota use is attributable.

---

## Read-only enforcement

Three independent layers, all present:

1. **OAuth scope** — every token, whether the old shared one or a teammate's own, is requested with
   `https://www.googleapis.com/auth/analytics.readonly` and nothing else (plus `openid`/`email` for
   identity in OAuth mode — see `src/google-oauth.ts`, which grant no data access). Google rejects
   writes server-side. **This is the real guarantee.** SETUP-GUIDE.md walks through verifying it with
   `tokeninfo`.
2. **Endpoint allowlist** — anchored regexes checked inside the two fetch helpers *before any network
   call*. A future edit that introduces a write endpoint throws instead of dialling out.
3. **No mutating verbs** — no `PATCH`, `PUT` or `DELETE` anywhere in the codebase. There are exactly
   three `fetch` call sites: the token mint (POST), `gaGet` (GET), and `gaPost` (POST).

`:runReport`, `:runRealtimeReport` and `:runFunnelReport` are HTTP POST but are **queries** — the body
carries the report definition because it is too large for a query string. Nothing in GA4 is created
or mutated.

---

## Quick commands

```bash
npm install
```

```bash
npm run typecheck && npm run dry-run
```

```bash
npm run deploy
```

```bash
npm run tail
```

```bash
curl -s https://ga4-mcp-worker.YOUR-SUBDOMAIN.workers.dev/health
```

Set the two secrets both auth modes need (paste interactively — piping mangles values):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Connect from Claude Code — no header, since sign-in happens through the browser:

```bash
claude mcp add --transport http --scope user ga4 https://ga4-mcp-worker.YOUR-SUBDOMAIN.workers.dev/mcp
```

Then in an interactive `claude` session, run `/mcp`, pick `ga4`, and sign in with Google.

---

## Gotchas honoured in this implementation

Each of these was verified against the official server's source before implementing:

1. **Custom dimensions come from the Data API `/metadata` endpoint, not the Admin API.** Only
   `/metadata` returns the queryable `apiName` (`customEvent:form_id`). The Admin API's
   `customDimensions` returns `parameterName` (`form_id`), which `run_report` rejects. Results are
   filtered on `customDefinition === true`. The Admin API `customDimensions` endpoint is deliberately
   **not** on the allowlist.
2. **REST needs camelCase; the official server accepts snake_case.** A recursive normaliser converts
   keys in either direction of style, so filters written either way work. **Keys only** — values are
   never rewritten, so `fieldName: "customEvent:form_id"` and `value: "request_a_demo"` survive
   verbatim.
3. **Integer enums are coerced to strings.** Protobuf-shaped callers send `matchType: 2`; REST needs
   `"BEGINS_WITH"`. Both `matchType` (7 values) and NumericFilter `operation` (6 values) are mapped,
   accepting int, snake_case, or the correct string. An out-of-range value throws a message listing
   the valid ones.
4. **Property IDs accepted in both formats** — `314138239` and `"properties/314138239"` — mirroring
   Google's `construct_property_rn`. A measurement ID (`G-JWBQ2Z84QF`) throws an error that says so
   explicitly, since that is the likely mistake.
5. **`compatibility_flags = ["nodejs_compat"]`** is set in `wrangler.toml`. The MCP SDK needs Node
   built-ins; without it the Worker fails to build.
6. **`z.any()` for complex object params** (`dimension_filter`, `metric_filter`, `order_bys`,
   `date_ranges`, `funnel_steps`, `segments`, `conversion_spec`) rather than nested zod schemas.
   Nested schemas emit JSON Schema where `additionalProperties` is an object rather than a boolean,
   which breaks Claude Desktop — the official server carries a `sanitize_mcp_schema_properties`
   workaround for exactly this. Expected shapes live in the tool descriptions instead.
7. **Errors return as text content, not thrown exceptions.** Every handler is wrapped; a malformed
   filter comes back as a readable message with `isError: true` so the model can correct itself,
   rather than killing the connection. Google errors are annotated with cause-specific hints.
8. **`invalid_grant` gets a specific message** naming the most likely cause — the OAuth consent
   screen sitting in "Testing", which expires refresh tokens after 7 days — plus the other causes and
   the fix.

Also handled: `dimensionFilter`/`metricFilter` independence (`(D1 AND M1) OR (D2 AND M2)` is
impossible in one request) is documented in every reporting tool's description, with guidance to
broaden and filter client-side and to prefer fewer reports to conserve quota; realtime's separate
schema, unavailable custom metrics, and `customUser:` prefix requirement; `limit` max of 250000 with
`offset` pagination; and a standing push toward explicit `YYYY-MM-DD` dates over relative ranges.

---

## What has and has not been tested

I would rather you know the boundary than trust a blanket claim.

### Verified, by running it

| Check                                  | Result                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm install`                          | Resolves cleanly, 0 vulnerabilities. Required correcting my initial version guesses — `agents` 0.20.1 needs **zod v4**, and wrangler 4.120 needs `@cloudflare/workers-types` **v5**. |
| `npx tsc --noEmit`                     | **0 errors**, strict mode with `noUnusedLocals`/`noUnusedParameters`.                          |
| `npx wrangler deploy --dry-run`        | **Bundles successfully.** 2855 KiB raw / **527 KiB gzipped**, comfortably inside Workers limits. Durable Object binding and var resolve. |
| Fixture suite (52 assertions)          | **All pass**, run against the real `src/index.ts` bundled with only `agents/mcp` and the MCP SDK stubbed. Covers: snake→camel normalisation, value preservation, integer/string/snake enum coercion in protobuf order, invalid-enum errors, `order_bys`/`date_ranges` shaping, all property-ID formats incl. the measurement-ID error, the allowlist permitting all 9 real endpoints and blocking 8 hostile/wrong ones, `safeEqual`, and that all 9 tools register with the expected parameter sets. |
| Mutating-verb audit                    | No `PATCH`/`PUT`/`DELETE` used anywhere; the strings appear only in the header comment. Exactly 3 outbound `fetch` call sites. |
| Delimiter balance                      | `tsc` parses the file, which is the authoritative proof. (A naive character tally reports `-2` parens — that is the `a)` / `b)` list markers inside a description string, not a code imbalance.) |
| Tool parameter parity                  | Cross-checked against the official server's live tool schemas and its Python source (`core.py`, `realtime.py`, `funnel.py`, `conversions.py`, `metadata.py`, `admin/info.py`, `utils.py`, `client.py`). |

### Verified on the live deployment

The server ran through two full lifecycles: shared-secret mode (deployed, queried, then retired) and
per-user OAuth (built on staging, proven, then promoted to production). Confirmed against real
infrastructure, not fixtures:

- **A `run_report` call returned real GA4 data.** `date_ranges` arrived from the client as a JSON
  *string*, not an array — `z.any()` gives clients no type hint, so this was a real bug fixtures
  never would have caught. Fixed (`parseIfJsonString`), re-verified with 41 assertions including the
  exact failing shape, redeployed.
- **`get_account_summaries` returned the real Zuddl Marketing account** (`188446559`) with the
  correct three properties — the canonical one and both legacies — confirming credentials, scope, and
  response parsing end to end.
- **The full per-user OAuth flow completed for real**, once, start to finish: `/authorize` → Google
  consent screen → `/callback` → a grant written to `OAUTH_KV`, `AES-GCM`-encrypted, keyed on the
  signer's Google `sub` (confirmed directly via `wrangler kv key list --remote`, not inferred from a
  green checkmark) → Claude Code showing the connector `✔ Connected` → a live query against
  `ga4-staging` returning the same three properties as the shared-secret server did.
- **Production, post-promotion:** `/`, `/health`, and the OAuth discovery document
  (`/.well-known/oauth-authorization-server`) all serve correctly. `POST /mcp` with the **old**
  `x-api-key` header now returns `401` with a `WWW-Authenticate: Bearer` challenge — confirmed
  directly, proving the shared-secret door is actually closed rather than just believed closed.
- Retired secrets (`GOOGLE_REFRESH_TOKEN`, `SHARED_SECRET`) deleted from the Worker;
  `wrangler secret list` confirms only `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` remain.

### Still NOT verified

- **A second person has not yet signed in.** Only one Google account has completed the OAuth flow.
  Per-user token isolation (two users never sharing a cached token) is proven by a fixture test with
  a fake `fetch`, not by two real people connecting simultaneously.
- **Domain restriction (`ALLOWED_EMAIL_DOMAIN`) has not been tested against a rejection.** The one
  sign-in so far used an allowed `@zuddl.com` account; the "not permitted" page for an outside account
  has never actually rendered.
- **The v1alpha endpoints are the least certain** — `run_funnel_report` and especially
  `run_conversions_report`. Alpha surfaces change, and the conversions field allowlist was copied
  from upstream rather than confirmed against the live API. Neither has been exercised in either auth
  mode.
- **`return_property_quota` response shape** is passed through untouched and unvalidated.
- **Pagination loops** (`gaGetPaged`, capped at 20 pages) have never followed a real `nextPageToken`.
- **Refresh-token renewal in OAuth mode is unexercised.** The one grant on file is fresh; nothing has
  yet forced Google's hourly access-token expiry to trigger a real re-mint via `getAccessTokenFor`.

**Fastest way to close the rest:** have a second teammate connect (proves multi-user isolation for
real), and ask Claude to run `run_funnel_report` or `run_conversions_report` once each.

### One known deprecation

`agents` 0.20.1 marks **`McpAgent` as deprecated and feature-frozen**, recommending
`createMcpHandler` from `agents/mcp/server`. This server still builds on `McpAgent` — it still ships,
typechecks, and bundles today, and Cloudflare's own OAuth authorization docs still show `McpAgent`
as the pattern for reading `ctx.props` in an OAuth-protected server (via `this.props` inside `init()`
— see `GA4MCP` in `src/index.ts`), calling it out explicitly as "for existing deprecated McpAgent
routes." Worth scheduling a migration eventually; not urgent, and it would not change the URL or
anything teammates see.

---

## Costs

Comfortably inside Cloudflare's free tier for this usage pattern: 100,000 Worker requests/day,
Durable Objects are included on the Workers Free plan, and the `OAUTH_KV` grant store (one small
encrypted record per signed-in teammate) is a rounding error against KV's free-tier limits. GA4 API
quota is the resource that will bind first — see PRODUCTION.md § 3.

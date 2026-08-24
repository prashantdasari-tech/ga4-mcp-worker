# ga4-mcp-worker

A **read-only** Google Analytics 4 MCP server that runs on Cloudflare Workers, so teammates can query
GA4 from Claude with nothing installed locally — no Python, no gcloud, no ADC file, and as of this
version, **no shared password either.** Adding it means clicking "Connect," signing in with your own
Google account, and answering GA4 questions as yourself.

It mirrors the tool surface of the official
[`googleanalytics/google-analytics-mcp`](https://github.com/googleanalytics/google-analytics-mcp)
stdio server, but calls the Google Analytics REST APIs directly, because Google's client libraries do
not run on the Workers runtime.

> **Read this first:** [docs/IMPLEMENTATION-NOTES.md § What has and has not been tested](docs/IMPLEMENTATION-NOTES.md#what-has-and-has-not-been-tested).
> Live end-to-end verification is in, but a few surfaces (the v1alpha endpoints, pagination) remain
> fixture-only.

### Auth mode: per-user OAuth

Each teammate signs in with their own Google account. There is no shared secret and no single Google
credential that everyone relies on — see [PRODUCTION.md § 1](PRODUCTION.md#1-the-identity-model)
and [docs/PRODUCTION-PART2.md § 8](docs/PRODUCTION-PART2.md#8-how-per-user-oauth-is-implemented) for
the full design and how it differs from the retired shared-secret mode. Sign-in is restricted to
`@zuddl.com` Google accounts (`ALLOWED_EMAIL_DOMAIN` in `wrangler.toml`).

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are still required — Google requires every app that
requests user data to be registered, and those two values *are* the registration, set once at deploy.
What is gone is the hand-minted refresh token and the password teammates used to type in.

---

## Documentation

| File                                                       | What it is                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **[SETUP-GUIDE.md](SETUP-GUIDE.md)** (+ [part 2](docs/SETUP-GUIDE-PART2.md)) | First deploy, explained from scratch — assumes no prior OAuth knowledge. Creating the Google app, deploying, testing, connecting Claude. **Start here.** |
| **[PRODUCTION.md](PRODUCTION.md)** (+ [part 2](docs/PRODUCTION-PART2.md)) | The identity model, monitoring, GA4 quotas, secret rotation, local dev, runbook, security checklist, OAuth internals. Read before a wide rollout. |
| **[docs/IMPLEMENTATION-NOTES.md](docs/IMPLEMENTATION-NOTES.md)** | Gotchas this implementation gets right, what has and hasn't been tested, and running costs. |
| `src/index.ts`                                             | The MCP server: tools, fetch helpers, normaliser, router. Heavily commented.              |
| `src/google-oauth.ts`                                       | The "sign in with Google" handler — `/authorize` and `/callback`. Heavily commented.      |
| `wrangler.toml`                                             | Worker config. Note `nodejs_compat` — see [gotchas](docs/IMPLEMENTATION-NOTES.md#gotchas-honoured-in-this-implementation). |
| `.dev.vars.example`                                         | Template for local dev. Copy to `.dev.vars` (gitignored).                                |

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
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
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

## More

- **Gotchas, test coverage, and running costs:** [docs/IMPLEMENTATION-NOTES.md](docs/IMPLEMENTATION-NOTES.md)
- **First deploy walkthrough:** [SETUP-GUIDE.md](SETUP-GUIDE.md) → [part 2](docs/SETUP-GUIDE-PART2.md)
- **Hardening, monitoring, and the OAuth runbook:** [PRODUCTION.md](PRODUCTION.md) → [part 2](docs/PRODUCTION-PART2.md)

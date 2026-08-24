# Implementation notes

Continued from [README.md](../README.md) — the gotchas this implementation gets right, what has and
hasn't actually been verified, and running costs.

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
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
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
quota is the resource that will bind first — see [PRODUCTION.md § 3](../PRODUCTION.md#3-ga4-api-quotas).

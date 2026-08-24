/**
 * ga4-mcp-worker — a READ-ONLY Google Analytics 4 MCP server for Cloudflare Workers.
 *
 * Mirrors the tool surface of the official stdio server
 * (github.com/googleanalytics/google-analytics-mcp) but talks to the Google
 * Analytics REST APIs directly, because the official Python/Node client
 * libraries do not run on the Workers runtime.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY ENFORCEMENT — three independent layers. All three are load-bearing.
 * ---------------------------------------------------------------------------
 *
 *   Layer 1 — OAuth scope. The refresh token is minted with
 *             https://www.googleapis.com/auth/analytics.readonly and nothing
 *             else. Google rejects any write server-side. THIS IS THE REAL
 *             GUARANTEE; the other two layers exist to stop us from ever
 *             *attempting* a write, not to stop Google from allowing one.
 *
 *   Layer 2 — Endpoint allowlist (ALLOWED_GET / ALLOWED_POST below), checked
 *             inside gaGet()/gaPost() BEFORE any network call. A future code
 *             edit that adds a write endpoint throws instead of dialling out.
 *
 *   Layer 3 — No PATCH / PUT / DELETE anywhere in this codebase. There are
 *             exactly two fetch helpers and they hardcode GET and POST.
 *
 * NOTE ON POST: `:runReport`, `:runRealtimeReport` and `:runFunnelReport` are
 * HTTP POST but they are QUERIES, not writes. The Data API takes the report
 * definition (dimensions, metrics, filters) in the request body because it is
 * far too large for a query string. Nothing in GA4 is created or mutated by
 * these calls. The same is true of the v1alpha `:runReport` used by
 * run_conversions_report.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createGoogleAuthHandler, type GoogleAuthProps } from "./google-oauth.js";

// ===========================================================================
// Environment
// ===========================================================================

export interface Env {
  /**
   * Which door teammates come through. Set per environment in wrangler.toml.
   *
   *   "secret" (default) — one shared GOOGLE_REFRESH_TOKEN for the whole
   *       Worker; teammates authenticate with SHARED_SECRET in an x-api-key
   *       header. Everyone queries as the deployer.
   *
   *   "oauth" — no shared token and no shared password. Each person signs in
   *       to Google and the Worker stores their own grant, encrypted. Queries
   *       run as them, with their own GA4 access.
   *
   * Both modes need GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — Google requires
   * every app that requests user data to be registered, and those two values
   * ARE the registration.
   */
  AUTH_MODE?: "secret" | "oauth";

  /** OAuth 2.0 client ID. Required in BOTH modes. */
  GOOGLE_CLIENT_ID: string;
  /** OAuth 2.0 client secret. Required in BOTH modes. */
  GOOGLE_CLIENT_SECRET: string;

  /** Shared-secret mode only. Refresh token, scope `analytics.readonly`. */
  GOOGLE_REFRESH_TOKEN?: string;
  /** Shared-secret mode only. Gates POST /mcp via the `x-api-key` header. */
  SHARED_SECRET?: string;

  /** OAuth mode only. Injected by OAuthProvider; not a wrangler binding. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** OAuth mode only. KV namespace holding encrypted grants. */
  OAUTH_KV: KVNamespace;
  /** OAuth mode only, optional. Restrict sign-in to one domain, e.g. "zuddl.com". */
  ALLOWED_EMAIL_DOMAIN?: string;

  /** Optional plain var from wrangler.toml. Fallback when a tool omits property_id. */
  DEFAULT_PROPERTY_ID?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

/**
 * Everything a tool needs to reach Google: the environment, and a way to get
 * an access token for WHOEVER this request belongs to. Threading this through
 * rather than reading a module-scope token is what makes per-user auth possible
 * — in OAuth mode two concurrent requests legitimately use different tokens.
 */
export interface Ga4Ctx {
  env: Env;
  getToken: TokenFn;
  /** Present in OAuth mode only. For logging and attribution. */
  actor?: string;
}

const SERVER_NAME = "ga4-mcp-worker";
const SERVER_VERSION = "1.0.0";

/** Sent on every outbound Google API call so quota usage is attributable. */
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+cloudflare-workers)`;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com";
const ADMIN_API = "https://analyticsadmin.googleapis.com";

// ===========================================================================
// Layer 2: endpoint allowlist
// ===========================================================================
//
// Anything not matched here throws before a socket is opened. Keep these
// anchored (^...$) — an unanchored regex would let a crafted property_id
// smuggle in a different path.

const ALLOWED_GET: readonly RegExp[] = [
  // Data API metadata — the ONLY correct source of queryable custom-dimension
  // `apiName` values. See getCustomDimensionsAndMetrics() for why.
  /^https:\/\/analyticsdata\.googleapis\.com\/v1beta\/properties\/\d+\/metadata$/,
  // Admin API, read-only list/get endpoints.
  /^https:\/\/analyticsadmin\.googleapis\.com\/v1beta\/accountSummaries(\?[^#]*)?$/,
  /^https:\/\/analyticsadmin\.googleapis\.com\/v1beta\/properties\/\d+$/,
  /^https:\/\/analyticsadmin\.googleapis\.com\/v1beta\/properties\/\d+\/googleAdsLinks(\?[^#]*)?$/,
  /^https:\/\/analyticsadmin\.googleapis\.com\/v1alpha\/properties\/\d+\/reportingDataAnnotations(\?[^#]*)?$/,
];

const ALLOWED_POST: readonly RegExp[] = [
  // All four are QUERIES. The body carries the report definition. See the
  // "NOTE ON POST" in the file header.
  /^https:\/\/analyticsdata\.googleapis\.com\/v1beta\/properties\/\d+:runReport$/,
  /^https:\/\/analyticsdata\.googleapis\.com\/v1beta\/properties\/\d+:runRealtimeReport$/,
  /^https:\/\/analyticsdata\.googleapis\.com\/v1alpha\/properties\/\d+:runFunnelReport$/,
  /^https:\/\/analyticsdata\.googleapis\.com\/v1alpha\/properties\/\d+:runReport$/,
];

export function assertAllowed(url: string, method: "GET" | "POST"): void {
  const list = method === "GET" ? ALLOWED_GET : ALLOWED_POST;
  if (!list.some((re) => re.test(url))) {
    throw new Error(
      `Blocked by read-only endpoint allowlist: ${method} ${url}. ` +
        `This server may only call an explicit list of Google Analytics read endpoints. ` +
        `If you are adding a feature, add the endpoint to ALLOWED_${method} in src/index.ts ` +
        `and confirm it cannot mutate data.`,
    );
  }
}

// ===========================================================================
// Access token: mint from refresh token, cache in module scope
// ===========================================================================
//
// Module scope on Workers is per-isolate and can be evicted at any time, so
// this is a best-effort cache, never a correctness dependency. Worst case we
// mint a token more often than strictly necessary.

interface CachedToken {
  token: string;
  /** Epoch ms at which Google says the token expires. */
  expiresAt: number;
}

/**
 * Access-token cache, keyed so shared-secret mode and per-user OAuth mode can
 * coexist. Key is "shared" in secret mode, or the Google `sub` in OAuth mode —
 * so two teammates never share a cache entry.
 */
const tokenCache = new Map<string, CachedToken>();
/** De-dupes concurrent refreshes so nine parallel tool calls mint one token. */
const inFlightTokens = new Map<string, Promise<string>>();

/** Refresh this many ms BEFORE the stated expiry, to absorb clock skew + latency. */
const TOKEN_SKEW_MS = 60_000;

const INVALID_GRANT_HELP =
  "Google rejected the refresh token (invalid_grant).\n\n" +
  "MOST LIKELY CAUSE: the OAuth consent screen for this Google Cloud project has user type " +
  '"External" and is still in "Testing" status. Google expires refresh tokens issued by a ' +
  "Testing-status External app after 7 days, without warning. Fix: Google Cloud Console -> " +
  "APIs & Services -> OAuth consent screen -> PUBLISH APP (Testing -> In production), then mint a " +
  "NEW refresh token and update the secret with `wrangler secret put GOOGLE_REFRESH_TOKEN`. " +
  "See SETUP-GUIDE.md Part 1.3 and Part 2. (Apps with user type \"Internal\" are not affected by " +
  "this expiry at all, which is why Internal is the recommended setting.)\n\n" +
  "Other possible causes: the Google account password was changed; the user revoked access at " +
  "myaccount.google.com/permissions; the token was superseded (Google keeps roughly the last 100 " +
  "refresh tokens per OAuth client and silently invalidates older ones); or GOOGLE_CLIENT_ID / " +
  "GOOGLE_CLIENT_SECRET do not belong to the same OAuth client that issued the refresh token.";

async function mintAccessToken(env: Env, refreshToken: string, cacheKey: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: body.toString(),
  });

  const raw = await res.text();

  if (!res.ok) {
    let errCode = "";
    let errDesc = "";
    try {
      const parsed = JSON.parse(raw) as { error?: string; error_description?: string };
      errCode = parsed.error ?? "";
      errDesc = parsed.error_description ?? "";
    } catch {
      // Non-JSON error body; fall through to the generic message.
    }
    if (errCode === "invalid_grant") {
      throw new Error(INVALID_GRANT_HELP);
    }
    throw new Error(
      `Token refresh failed (HTTP ${res.status}${errCode ? ` ${errCode}` : ""})` +
        `${errDesc ? `: ${errDesc}` : `: ${truncate(raw, 400)}`}`,
    );
  }

  const json = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("Token endpoint returned 200 but no access_token was present.");
  }

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

async function getAccessTokenFor(env: Env, refreshToken: string, cacheKey: string): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.token;

  const pending = inFlightTokens.get(cacheKey);
  if (pending) return pending;

  const p = mintAccessToken(env, refreshToken, cacheKey).finally(() => {
    inFlightTokens.delete(cacheKey);
  });
  inFlightTokens.set(cacheKey, p);
  return p;
}

/**
 * How a request obtains a Google access token. Exactly one of two shapes:
 *   - shared-secret mode: the Worker's single GOOGLE_REFRESH_TOKEN
 *   - OAuth mode:         the signed-in user's own refresh token, from props
 */
export type TokenFn = () => Promise<string>;

/** Shared-secret mode: one refresh token for the whole Worker. */
export function sharedTokenSource(env: Env): TokenFn {
  return () => {
    if (!env.GOOGLE_REFRESH_TOKEN) {
      throw new Error(
        "GOOGLE_REFRESH_TOKEN is not set. In shared-secret mode the Worker needs one. " +
          "Set it with `wrangler secret put GOOGLE_REFRESH_TOKEN`, or switch AUTH_MODE to \"oauth\".",
      );
    }
    return getAccessTokenFor(env, env.GOOGLE_REFRESH_TOKEN, "shared");
  };
}

/** OAuth mode: this user's own grant. Cache is keyed by their Google `sub`. */
export function userTokenSource(env: Env, props: GoogleAuthProps): TokenFn {
  return () => getAccessTokenFor(env, props.googleRefreshToken, `user:${props.sub}`);
}

// ===========================================================================
// Fetch helpers (the only two places this Worker talks to Google)
// ===========================================================================

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}... [truncated ${s.length - n} chars]`;
}

/** Turns a Google API error body into something a human can act on. */
function explainGoogleError(status: number, raw: string, url: string): Error {
  let message = truncate(raw, 800);
  let reason = "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; status?: string; details?: unknown };
    };
    if (parsed.error?.message) message = parsed.error.message;
    if (parsed.error?.status) reason = parsed.error.status;
  } catch {
    // keep the raw body
  }

  let hint = "";
  if (status === 403 && reason === "PERMISSION_DENIED") {
    hint =
      "\n\nHINT: the Google account behind GOOGLE_REFRESH_TOKEN does not have access to this GA4 " +
      "property, OR the Google Analytics Data/Admin API is not enabled on the Cloud project that " +
      "owns the OAuth client. Check the property ID with get_account_summaries — it lists exactly " +
      "the properties this token can see.";
  } else if (status === 401) {
    hint =
      "\n\nHINT: the access token was rejected. This usually means the refresh token is no longer " +
      "valid — check GET /health, which reports token status directly.";
  } else if (status === 400 && reason === "INVALID_ARGUMENT") {
    hint =
      "\n\nHINT: usually a bad dimension/metric name or a malformed filter. Custom dimensions must " +
      "use the apiName from get_custom_dimensions_and_metrics (e.g. 'customEvent:form_id'), not the " +
      "parameter name. Standard names are at " +
      "https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema";
  } else if (status === 429) {
    hint =
      "\n\nHINT: GA4 API quota exhausted for this property. Re-run with return_property_quota=true " +
      "to see which bucket is empty. See PRODUCTION.md section 'GA4 API quotas'.";
  }

  return new Error(`Google API error (HTTP ${status}${reason ? ` ${reason}` : ""}) for ${url}: ${message}${hint}`);
}

async function gaGet(ctx: Ga4Ctx, url: string): Promise<unknown> {
  assertAllowed(url, "GET"); // Layer 2 — before any network call.
  const token = await ctx.getToken();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      accept: "application/json",
    },
  });
  const raw = await res.text();
  if (!res.ok) throw explainGoogleError(res.status, raw, url);
  return raw ? JSON.parse(raw) : {};
}

async function gaPost(ctx: Ga4Ctx, url: string, payload: unknown): Promise<unknown> {
  assertAllowed(url, "POST"); // Layer 2 — before any network call.
  const token = await ctx.getToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) throw explainGoogleError(res.status, raw, url);
  return raw ? JSON.parse(raw) : {};
}

/**
 * Follows nextPageToken for the Admin API list endpoints.
 * Capped so a pathological account can't spin here forever.
 */
async function gaGetPaged(
  ctx: Ga4Ctx,
  baseUrl: string,
  itemsKey: string,
  pageSize = 200,
  maxPages = 20,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const u = new URL(baseUrl);
    u.searchParams.set("pageSize", String(pageSize));
    if (pageToken) u.searchParams.set("pageToken", pageToken);

    const body = (await gaGet(ctx, u.toString())) as Record<string, unknown>;
    const batch = body[itemsKey];
    if (Array.isArray(batch)) items.push(...batch);

    const next = body["nextPageToken"];
    if (typeof next === "string" && next.length > 0) pageToken = next;
    else return items;
  }
  return items;
}

// ===========================================================================
// Property ID handling
// ===========================================================================
//
// Mirrors construct_property_rn() in the official server
// (analytics_mcp/tools/utils.py): accepts a number, a numeric string, or a
// string of the form "properties/<number>". Anything else is a clear error.

export function constructPropertyRn(input: unknown, env: Env): string {
  let value: unknown = input;

  if (value === undefined || value === null || value === "") {
    if (env.DEFAULT_PROPERTY_ID && env.DEFAULT_PROPERTY_ID.trim() !== "") {
      value = env.DEFAULT_PROPERTY_ID;
    } else {
      throw new Error(
        "No property_id was supplied and no DEFAULT_PROPERTY_ID is configured on this Worker. " +
          "Pass property_id explicitly, or call get_account_summaries to list the properties this " +
          "server can read.",
      );
    }
  }

  let propertyNum: string | null = null;

  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0) propertyNum = String(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      propertyNum = trimmed;
    } else if (trimmed.startsWith("properties/")) {
      const numericPart = trimmed.slice("properties/".length);
      if (/^\d+$/.test(numericPart)) propertyNum = numericPart;
    }
  }

  if (propertyNum === null) {
    throw new Error(
      `Invalid property ID: ${JSON.stringify(input)}. A valid property value is either a number ` +
        `(e.g. 314138239) or a string starting with 'properties/' followed by a number ` +
        `(e.g. "properties/314138239"). Note this is the numeric PROPERTY ID from GA4 Admin -> ` +
        `Property Settings, not the measurement ID (G-XXXXXXX) and not the stream ID.`,
    );
  }

  return `properties/${propertyNum}`;
}

// ===========================================================================
// Request normalisation: snake_case -> camelCase, and integer enums -> strings
// ===========================================================================
//
// Why this exists:
//
//   * The official Google MCP server speaks protobuf, so its tool descriptions
//     tell the model to use snake_case (`field_name`, `string_filter`,
//     `match_type`). The REST API this Worker calls requires camelCase
//     (`fieldName`, `stringFilter`, `matchType`).
//   * Models trained on the official server, or on the REST reference docs,
//     will produce either style — often both inside one request.
//   * Protobuf callers also pass enums as integers (`matchType: 2`). REST
//     requires the string form ("BEGINS_WITH").
//
// So we normalise KEYS ONLY, recursively, and coerce known enum positions.
// Values are never touched: `fieldName: "landing_page"` and
// `value: "customEvent:form_id"` must survive verbatim.

const MATCH_TYPES = [
  "MATCH_TYPE_UNSPECIFIED",
  "EXACT",
  "BEGINS_WITH",
  "ENDS_WITH",
  "CONTAINS",
  "FULL_REGEXP",
  "PARTIAL_REGEXP",
] as const;

const NUMERIC_OPERATIONS = [
  "OPERATION_UNSPECIFIED",
  "EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
] as const;

export function snakeToCamel(key: string): string {
  // Leaves already-camelCase keys untouched.
  return key.replace(/_+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function coerceEnum(value: unknown, table: readonly string[], label: string): unknown {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value < table.length) return table[value];
    throw new Error(
      `Invalid ${label} value ${value}. Expected an integer 0-${table.length - 1} or one of: ${table.join(", ")}.`,
    );
  }
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (table.includes(upper)) return upper;
    // A numeric string, e.g. "2".
    if (/^\d+$/.test(upper)) return coerceEnum(Number(upper), table, label);
    throw new Error(`Invalid ${label} value ${JSON.stringify(value)}. Expected one of: ${table.join(", ")}.`);
  }
  return value;
}

/**
 * Recursively normalise an arbitrary request fragment.
 * `keyHint` is the (already camelised) key this value was found under, which is
 * what lets us spot enum positions.
 */
export function normalize(value: unknown, keyHint?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, keyHint));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = snakeToCamel(k);
      out[camelKey] = normalize(v, camelKey);
    }
    return out;
  }

  // Scalars: coerce enums at known key positions.
  if (keyHint === "matchType") return coerceEnum(value, MATCH_TYPES, "matchType");
  if (keyHint === "operation") return coerceEnum(value, NUMERIC_OPERATIONS, "NumericFilter operation");

  return value;
}

/**
 * Parse a value that arrived as a JSON string.
 *
 * WHY THIS IS NEEDED: the complex params are declared `z.any()` (see gotcha 6 —
 * nested zod schemas emit JSON Schema where `additionalProperties` is an object
 * rather than a boolean, which breaks some MCP clients). The cost of `z.any()`
 * is that the emitted schema carries NO type information, so a client has no
 * way to know whether to send an array, an object, or text — and several
 * clients serialise the whole value to a JSON string.
 *
 * Verified against a live client: `date_ranges` arrived as the string
 * '[{"start_date":"2026-08-03",...}]' rather than an array. So we accept both.
 */
export function parseIfJsonString(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `${label} was supplied as a string, but it is not valid JSON: ${truncate(trimmed, 200)}. ` +
        `Pass it as a JSON array/object, or as a correctly-quoted JSON string.`,
    );
  }
}

/** Normalise an optional object-ish argument, returning undefined when absent. */
export function normObj(value: unknown, label = "value"): Record<string, unknown> | undefined {
  const parsed = parseIfJsonString(value, label);
  if (parsed === undefined || parsed === null) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${label} must be a JSON object, received ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }
  return normalize(parsed) as Record<string, unknown>;
}

/** Normalise an optional array-ish argument, returning undefined when absent. */
export function normArray(value: unknown, label: string): unknown[] | undefined {
  const parsed = parseIfJsonString(value, label);
  if (parsed === undefined || parsed === null) return undefined;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array (a list), received ${typeof parsed}.`);
  }
  return normalize(parsed) as unknown[];
}

/**
 * Build the Data API's [{name: "..."}] list from dimension/metric API names.
 *
 * Tolerant on input because clients vary: accepts a real array, a JSON string
 * holding an array, a comma-separated string, a single bare name, or a list of
 * {name} objects that a caller built by hand. All collapse to the same shape.
 */
export function toNameList(value: unknown, label: string): { name: string }[] {
  let parsed: unknown = value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON — treat as one name, or a comma-separated list of names.
      // Safe because GA4 API names never contain commas.
      parsed = trimmed.includes(",") ? trimmed.split(",").map((s) => s.trim()) : [trimmed];
    }
  }

  if (parsed === undefined || parsed === null) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list.map((entry) => {
    if (typeof entry === "string") return { name: entry.trim() };
    if (entry !== null && typeof entry === "object") {
      const n = (entry as { name?: unknown }).name;
      if (typeof n === "string") return { name: n.trim() };
    }
    throw new Error(
      `${label} must be a list of GA4 API name strings, e.g. ["sessions","totalUsers"]. ` +
        `Received an entry of type ${typeof entry}.`,
    );
  });
}

// ===========================================================================
// Shared description fragments
// ===========================================================================
//
// These are deliberately long. The tool description is the only place the model
// learns the request shape, and a wrong filter costs a round trip plus quota.

const PROPERTY_ID_HINT = `
'property_id' — the numeric GA4 property ID. Accepts either 314138239 or "properties/314138239".
This is NOT the measurement ID (G-JWBQ2Z84QF) and NOT a stream ID. If omitted, the server falls
back to its configured default property. Call 'get_account_summaries' to discover valid IDs.`;

const KEY_STYLE_HINT = `
KEY STYLE: this server accepts snake_case ('field_name', 'string_filter', 'match_type') and
camelCase ('fieldName', 'stringFilter', 'matchType') interchangeably, and accepts enums as either
strings ("CONTAINS") or protobuf integers (4). Keys are normalised before the request is sent.
Values are never rewritten.`;

const DATE_RANGES_HINT = `
'date_ranges' is a LIST of DateRange objects. Passing more than one gives you period-over-period
comparison in a single response; each row then carries a 'dateRange' column naming which range it
came from.

  Single explicit range (PREFERRED):
    [{"startDate": "2025-01-01", "endDate": "2025-01-31", "name": "Jan2025"}]

  Period over period:
    [{"startDate": "2025-01-01", "endDate": "2025-01-31", "name": "Jan2025"},
     {"startDate": "2025-02-01", "endDate": "2025-02-28", "name": "Feb2025"}]

  Relative ranges (supported, but see the warning):
    [{"startDate": "yesterday", "endDate": "today", "name": "YesterdayAndToday"}]
    [{"startDate": "30daysAgo", "endDate": "yesterday", "name": "Previous30Days"}]

  WARNING: PREFER EXPLICIT YYYY-MM-DD DATES. Relative keywords are evaluated in the property's
  reporting timezone, and whether "today" is included is the single most common reason a number
  from this tool disagrees with a number someone read off the GA4 UI. "today" also returns partial,
  still-settling data. If the user says "last 30 days", resolve it to real dates and say which
  dates you used.`;

const FILTER_EXPRESSION_HINT = `
A FilterExpression is a recursive structure. Exactly one of these keys at each level:
'filter', 'andGroup', 'orGroup', 'notExpression'.

  1. Simple string filter — landing page contains "/pricing":
     {"filter": {"fieldName": "landingPagePlusQueryString",
                 "stringFilter": {"matchType": "CONTAINS", "value": "/pricing",
                                  "caseSensitive": false}}}

     matchType is one of: EXACT, BEGINS_WITH, ENDS_WITH, CONTAINS, FULL_REGEXP, PARTIAL_REGEXP.

  2. inListFilter — one of several exact values (cheaper than an orGroup of EXACTs):
     {"filter": {"fieldName": "deviceCategory",
                 "inListFilter": {"values": ["mobile", "tablet"], "caseSensitive": false}}}

  3. notExpression — everything EXCEPT paid traffic:
     {"notExpression": {"filter": {"fieldName": "sessionDefaultChannelGroup",
                                   "stringFilter": {"matchType": "EXACT", "value": "Paid Search"}}}}

  4. andGroup — organic sessions that landed on /pricing:
     {"andGroup": {"expressions": [
        {"filter": {"fieldName": "sessionDefaultChannelGroup",
                    "stringFilter": {"matchType": "EXACT", "value": "Organic Search"}}},
        {"filter": {"fieldName": "landingPagePlusQueryString",
                    "stringFilter": {"matchType": "CONTAINS", "value": "/pricing"}}}]}}

  5. orGroup — either of two events:
     {"orGroup": {"expressions": [
        {"filter": {"fieldName": "eventName",
                    "stringFilter": {"matchType": "EXACT", "value": "generate_lead"}}},
        {"filter": {"fieldName": "eventName",
                    "stringFilter": {"matchType": "EXACT", "value": "sign_up"}}}]}}

  6. Numeric filter (belongs in metric_filter, not dimension_filter) — more than 100 sessions:
     {"filter": {"fieldName": "sessions",
                 "numericFilter": {"operation": "GREATER_THAN",
                                   "value": {"int64Value": "100"}}}}

     operation is one of: EQUAL, LESS_THAN, LESS_THAN_OR_EQUAL, GREATER_THAN,
     GREATER_THAN_OR_EQUAL. Use {"int64Value": "100"} for integers (as a STRING) or
     {"doubleValue": 12.5} for decimals.

  7. betweenFilter — sessions between 10 and 100:
     {"filter": {"fieldName": "sessions",
                 "betweenFilter": {"fromValue": {"int64Value": "10"},
                                   "toValue": {"int64Value": "100"}}}}`;

const FILTER_INDEPENDENCE_NOTE = `
IMPORTANT — 'dimension_filter' and 'metric_filter' are applied INDEPENDENTLY by the API. Some
combinations are therefore impossible in a single request. You cannot express:

    ((eventName = "page_view" AND eventCount > 100)
      OR
     (eventName = "join_group" AND eventCount < 50))

because there is no way to scope "eventCount > 100" to only the page_view rows. More generally
((D1 AND M1) OR (D2 AND M2)) is not expressible.

When you hit this, either:
  a) Run ONE report with the broader subset of conditions (e.g. just the dimension filter) and
     apply the rest yourself to the returned rows; or
  b) Run separate reports and combine the results.

PREFER (a), AND PREFER FEWER REPORTS GENERALLY. Each request consumes GA4 API quota, which is
per-property and per-day, and complex requests cost more tokens from that quota than simple ones.`;

const ORDER_BYS_HINT = `
'order_bys' is a LIST of OrderBy objects. Each has exactly one of 'metric', 'dimension' or
'pivot', plus an optional 'desc' boolean (default false = ascending).

  Most sessions first:
    [{"metric": {"metricName": "sessions"}, "desc": true}]

  Alphabetical by page path:
    [{"dimension": {"dimensionName": "pagePath"}, "desc": false}]

  Numeric-aware dimension ordering (so "10" sorts after "9"):
    [{"dimension": {"dimensionName": "dayOfWeek", "orderType": "NUMERIC"}, "desc": false}]

  Sort by conversions desc, then by source asc:
    [{"metric": {"metricName": "conversions"}, "desc": true},
     {"dimension": {"dimensionName": "sessionSource"}}]

Every dimension or metric named in order_bys MUST also appear in the 'dimensions' / 'metrics'
arguments of the same request.`;

const PAGINATION_HINT = `
'limit' caps rows per response. Maximum 250000; the API default is 10000. 'offset' is the
zero-based index of the first row to return — use it to page through a large report
(offset 0, then offset=limit, and so on). The response's 'rowCount' tells you the total available.`;

const DIMENSIONS_METRICS_HINT = `
'dimensions' and 'metrics' are lists of API names (strings).

  Standard names: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema

  Custom dimensions/metrics: call 'get_custom_dimensions_and_metrics' FIRST and use the exact
  'apiName' it returns (e.g. "customEvent:form_id", "customUser:plan_tier"). Do not guess, and do
  not use the parameter name from the GA4 admin UI — the API rejects it.`;

// ===========================================================================
// MCP tool result plumbing
// ===========================================================================

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  // Compact, not pretty-printed: indentation/newlines cost real tokens on every
  // report response and buy the model nothing — it doesn't need pretty JSON to
  // parse it. Measured ~57% smaller on a typical 20-row report, same data.
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Every handler is wrapped in this. A malformed filter or a Google 400 comes
 * back as readable text the model can correct from, rather than an exception
 * that tears down the MCP connection.
 */
function guard(name: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  return fn()
    .then(ok)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logJson({ event: "tool_error", tool: name, message: truncate(message, 500) });
      return {
        content: [{ type: "text" as const, text: `Tool '${name}' failed.\n\n${message}` }],
        isError: true,
      };
    });
}

function logJson(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// ===========================================================================
// Tool implementations
// ===========================================================================

interface ReportArgs {
  property_id?: string | number;
  date_ranges?: unknown;
  dimensions?: string[];
  metrics?: string[];
  dimension_filter?: unknown;
  metric_filter?: unknown;
  order_bys?: unknown;
  limit?: number;
  offset?: number;
  currency_code?: string;
  return_property_quota?: boolean;
  conversion_spec?: unknown;
}

/** Shared body assembly for run_report and run_conversions_report. */
function buildReportBody(args: ReportArgs, env: Env): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dimensions: toNameList(args.dimensions, "dimensions"),
    metrics: toNameList(args.metrics, "metrics"),
    dateRanges: normArray(args.date_ranges, "date_ranges") ?? [],
    returnPropertyQuota: args.return_property_quota === true,
  };

  const dimensionFilter = normObj(args.dimension_filter, "dimension_filter");
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;

  const metricFilter = normObj(args.metric_filter, "metric_filter");
  if (metricFilter) body.metricFilter = metricFilter;

  const orderBys = normArray(args.order_bys, "order_bys");
  if (orderBys) body.orderBys = orderBys;

  if (args.limit !== undefined && args.limit !== null) body.limit = args.limit;
  if (args.offset !== undefined && args.offset !== null) body.offset = args.offset;
  if (args.currency_code) body.currencyCode = args.currency_code;

  void env; // property is set by the caller, which owns the resource name.
  return body;
}

async function runReport(ctx: Ga4Ctx, args: ReportArgs): Promise<unknown> {
  const rn = constructPropertyRn(args.property_id, ctx.env);
  const body = buildReportBody(args, ctx.env);
  // POST, but a QUERY — the body is the report definition. Nothing is written.
  return gaPost(ctx, `${DATA_API}/v1beta/${rn}:runReport`, body);
}

async function runRealtimeReport(ctx: Ga4Ctx, args: ReportArgs): Promise<unknown> {
  const rn = constructPropertyRn(args.property_id, ctx.env);
  const body: Record<string, unknown> = {
    dimensions: toNameList(args.dimensions, "dimensions"),
    metrics: toNameList(args.metrics, "metrics"),
    returnPropertyQuota: args.return_property_quota === true,
  };

  const dimensionFilter = normObj(args.dimension_filter, "dimension_filter");
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  const metricFilter = normObj(args.metric_filter, "metric_filter");
  if (metricFilter) body.metricFilter = metricFilter;
  const orderBys = normArray(args.order_bys, "order_bys");
  if (orderBys) body.orderBys = orderBys;
  if (args.limit !== undefined && args.limit !== null) body.limit = args.limit;

  // Realtime has no dateRanges (it is always "now") and no currencyCode.
  // POST, but a QUERY.
  return gaPost(ctx, `${DATA_API}/v1beta/${rn}:runRealtimeReport`, body);
}

async function runConversionsReport(ctx: Ga4Ctx, args: ReportArgs): Promise<unknown> {
  const rn = constructPropertyRn(args.property_id, ctx.env);
  const body = buildReportBody(args, ctx.env);
  const spec = normObj(args.conversion_spec, "conversion_spec");
  if (!spec) {
    throw new Error(
      "conversion_spec is required for run_conversions_report. Pass " +
        '{"conversionActions": [], "attributionModel": "DATA_DRIVEN"} to report on all conversion ' +
        "events, or list specific conversionActions resource names.",
    );
  }
  body.conversionSpec = spec;
  // v1alpha :runReport — POST, but a QUERY.
  return gaPost(ctx, `${DATA_API}/v1alpha/${rn}:runReport`, body);
}

interface FunnelArgs {
  property_id?: string | number;
  funnel_steps?: unknown;
  date_ranges?: unknown;
  funnel_breakdown?: unknown;
  funnel_next_action?: unknown;
  segments?: unknown;
  return_property_quota?: boolean;
}

async function runFunnelReport(ctx: Ga4Ctx, args: FunnelArgs): Promise<unknown> {
  const rn = constructPropertyRn(args.property_id, ctx.env);

  const rawSteps = normArray(args.funnel_steps, "funnel_steps");
  if (!rawSteps || rawSteps.length === 0) {
    throw new Error("funnel_steps must contain at least one step.");
  }

  // Mirrors the official server: a step is either {name, filterExpression} or
  // the {name, event} shorthand, which we expand into a funnelEventFilter.
  const steps = rawSteps.map((step, i) => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`Funnel step ${i + 1} must be a JSON object.`);
    }
    const s = step as Record<string, unknown>;
    const name = typeof s.name === "string" && s.name ? s.name : `Step ${i + 1}`;

    if (s.filterExpression !== undefined) {
      return { name, filterExpression: s.filterExpression };
    }
    if (typeof s.event === "string" && s.event) {
      return { name, filterExpression: { funnelEventFilter: { eventName: s.event } } };
    }
    throw new Error(
      `Funnel step ${i + 1} ("${name}") must contain either 'filter_expression' or the 'event' shorthand.`,
    );
  });

  const body: Record<string, unknown> = {
    funnel: { steps },
    dateRanges: normArray(args.date_ranges, "date_ranges") ?? [],
    returnPropertyQuota: args.return_property_quota === true,
  };

  const breakdown = normObj(args.funnel_breakdown, "funnel_breakdown");
  if (breakdown && typeof breakdown.breakdownDimension === "string") {
    body.funnelBreakdown = { breakdownDimension: { name: breakdown.breakdownDimension } };
  }

  const nextAction = normObj(args.funnel_next_action, "funnel_next_action");
  if (nextAction && typeof nextAction.nextActionDimension === "string") {
    const na: Record<string, unknown> = {
      nextActionDimension: { name: nextAction.nextActionDimension },
    };
    if (nextAction.limit !== undefined) na.limit = nextAction.limit;
    body.funnelNextAction = na;
  }

  const segments = normArray(args.segments, "segments");
  if (segments) body.segments = segments;

  // POST, but a QUERY.
  return gaPost(ctx, `${DATA_API}/v1alpha/${rn}:runFunnelReport`, body);
}

/**
 * IMPORTANT: this deliberately uses the DATA API /metadata endpoint, NOT the
 * Admin API customDimensions/customMetrics endpoints.
 *
 * Only /metadata returns 'apiName' — the string run_report actually accepts,
 * e.g. "customEvent:form_id". The Admin API returns 'parameterName' (e.g.
 * "form_id"), which run_report rejects with INVALID_ARGUMENT. This mirrors
 * get_custom_dimensions_and_metrics in the official server, which filters
 * metadata on custom_definition.
 */
async function getCustomDimensionsAndMetrics(ctx: Ga4Ctx, propertyId: unknown): Promise<unknown> {
  const rn = constructPropertyRn(propertyId, ctx.env);
  const metadata = (await gaGet(ctx, `${DATA_API}/v1beta/${rn}/metadata`)) as {
    dimensions?: { customDefinition?: boolean }[];
    metrics?: { customDefinition?: boolean }[];
  };

  return {
    property: rn,
    custom_dimensions: (metadata.dimensions ?? []).filter((d) => d.customDefinition === true),
    custom_metrics: (metadata.metrics ?? []).filter((m) => m.customDefinition === true),
  };
}

// ===========================================================================
// The MCP agent
// ===========================================================================

export class GA4MCP extends McpAgent<Env, unknown, GoogleAuthProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init(): Promise<void> {
    const env = this.env;

    // Which identity does this session query as?
    //
    // In OAuth mode the provider hands us the signed-in user's decrypted grant
    // as `this.props`, so every tool call below uses THEIR Google token and
    // therefore THEIR GA4 access. In shared-secret mode props is absent and we
    // fall back to the Worker's single refresh token.
    const props = this.props as GoogleAuthProps | undefined;
    const ctx: Ga4Ctx = props?.googleRefreshToken
      ? { env, getToken: userTokenSource(env, props), actor: props.email || props.sub }
      : { env, getToken: sharedTokenSource(env) };

    logJson({
      event: "mcp_session_init",
      mode: props?.googleRefreshToken ? "oauth" : "secret",
      actor: ctx.actor ?? "shared-credential",
    });

    // -----------------------------------------------------------------
    // run_report
    // -----------------------------------------------------------------
    this.server.tool(
      "run_report",
      `Run a Google Analytics 4 Data API report. This is the primary tool — use it for almost every
historical GA4 question (traffic, sessions, users, events, conversions, landing pages, sources).

${PROPERTY_ID_HINT}
${KEY_STYLE_HINT}

### dimensions / metrics
${DIMENSIONS_METRICS_HINT}

### date_ranges
${DATE_RANGES_HINT}

### dimension_filter
A FilterExpression applied to DIMENSIONS. The 'fieldName' must be a dimension. Do not use this to
filter metrics — use metric_filter.
${FILTER_EXPRESSION_HINT}

### metric_filter
A FilterExpression applied to METRICS, using the same shapes shown above. The 'fieldName' must be a
metric, and you will almost always use numericFilter or betweenFilter.
${FILTER_INDEPENDENCE_NOTE}

### order_bys
${ORDER_BYS_HINT}

### limit / offset
${PAGINATION_HINT}

### currency_code
ISO 4217 code ("USD", "EUR", "INR") overriding the property default for currency metrics.

### return_property_quota
Set true to include remaining GA4 API quota in the response. Use it when diagnosing 429s or before
running a batch of heavy queries.`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID, e.g. 314138239 or 'properties/314138239'. Defaults to the server's configured property."),
        date_ranges: z.any().optional().describe("LIST of DateRange objects. See the tool description."),
        dimensions: z.array(z.string()).optional().describe("List of dimension API names, e.g. ['sessionSource','landingPagePlusQueryString']."),
        metrics: z.array(z.string()).optional().describe("List of metric API names, e.g. ['sessions','totalUsers']."),
        dimension_filter: z.any().optional().describe("FilterExpression applied to dimensions."),
        metric_filter: z.any().optional().describe("FilterExpression applied to metrics."),
        order_bys: z.any().optional().describe("LIST of OrderBy objects."),
        limit: z.number().optional().describe("Max rows per response, <= 250000."),
        offset: z.number().optional().describe("Zero-based index of the first row, for pagination."),
        currency_code: z.string().optional().describe("ISO 4217 currency code."),
        return_property_quota: z.boolean().optional().describe("Include remaining API quota in the response."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => guard("run_report", () => runReport(ctx, args as ReportArgs)),
    );

    // -----------------------------------------------------------------
    // run_realtime_report
    // -----------------------------------------------------------------
    this.server.tool(
      "run_realtime_report",
      `Run a GA4 Data API REALTIME report — activity in roughly the last 30 minutes (up to 60 for some
dimensions). Use this only for "what is happening right now"; for anything historical use
run_report.

${PROPERTY_ID_HINT}
${KEY_STYLE_HINT}

### Realtime uses a SEPARATE, SMALLER SCHEMA
Realtime has its own dimension and metric list, which is much shorter than the core one:
https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema

Do not assume a core dimension exists in realtime. Common valid ones: 'unifiedScreenName',
'eventName', 'country', 'city', 'deviceCategory', 'platform', 'streamId'. Common valid metrics:
'activeUsers', 'screenPageViews', 'eventCount', 'conversions'.

Two further restrictions:
  * CUSTOM METRICS ARE NOT AVAILABLE in realtime at all.
  * Custom dimensions must be USER-SCOPED, referenced with the 'customUser:' prefix (e.g.
    'customUser:plan_tier'). Event-scoped 'customEvent:' dimensions do NOT work in realtime.

There is NO date_ranges argument (realtime is always "now") and NO currency_code.

### dimension_filter / metric_filter
Same FilterExpression shapes as 'run_report's dimension_filter/metric_filter (simple string filter,
inListFilter, notExpression, andGroup/orGroup, numericFilter, betweenFilter) — see that tool's
description for the full syntax and worked examples; it is not repeated here. The same
dimension_filter/metric_filter independence restriction documented there applies here too: you
cannot express ((D1 AND M1) OR (D2 AND M2)) in one request.

### order_bys
Same OrderBy shape as run_report's order_bys — see that tool's description for the full syntax and
examples.

### limit
Max rows per response. Realtime does not support 'offset' pagination.`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
        dimensions: z.array(z.string()).optional().describe("Realtime dimension API names only."),
        metrics: z.array(z.string()).optional().describe("Realtime metric API names only. Custom metrics are not supported."),
        dimension_filter: z.any().optional().describe("FilterExpression applied to dimensions."),
        metric_filter: z.any().optional().describe("FilterExpression applied to metrics."),
        order_bys: z.any().optional().describe("LIST of OrderBy objects."),
        limit: z.number().optional().describe("Max rows per response."),
        return_property_quota: z.boolean().optional().describe("Include remaining API quota in the response."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => guard("run_realtime_report", () => runRealtimeReport(ctx, args as ReportArgs)),
    );

    // -----------------------------------------------------------------
    // run_funnel_report
    // -----------------------------------------------------------------
    this.server.tool(
      "run_funnel_report",
      `Run a GA4 Data API funnel report (v1alpha) — how many users progress through an ordered sequence
of steps, and where they drop off. Use this when the question is about a SEQUENCE. For a simple
"how many did X" count, run_report is cheaper.

${PROPERTY_ID_HINT}
${KEY_STYLE_HINT}

### funnel_steps (required)
A LIST of steps, in order. Each step is either the SHORTHAND form:

    {"name": "Session start", "event": "session_start"}

or the full form with a FunnelFilterExpression:

    {"name": "Home page view",
     "filterExpression": {"andGroup": {"expressions": [
        {"funnelEventFilter": {"eventName": "page_view"}},
        {"funnelFieldFilter": {"fieldName": "pageLocation",
                               "stringFilter": {"matchType": "CONTAINS", "value": "/"}}}]}}}

Funnel filter expressions use funnel-specific node names — 'funnelEventFilter',
'funnelFieldFilter', 'andGroup', 'orGroup', 'notExpression' — NOT the plain 'filter' node used by
run_report.

  Multiple events with OR:
    {"name": "First open/visit",
     "filterExpression": {"orGroup": {"expressions": [
        {"funnelEventFilter": {"eventName": "first_open"}},
        {"funnelEventFilter": {"eventName": "first_visit"}}]}}}

  Field filter (organic traffic):
    {"name": "Organic visitors",
     "filterExpression": {"funnelFieldFilter": {"fieldName": "firstUserMedium",
        "stringFilter": {"matchType": "CONTAINS", "caseSensitive": false, "value": "organic"}}}}

  Event with a parameter condition (add_to_cart where value > 50):
    {"name": "Add to cart (value > 50)",
     "filterExpression": {"funnelEventFilter": {"eventName": "add_to_cart",
        "funnelParameterFilterExpression": {"funnelParameterFilter": {
           "eventParameterName": "value",
           "numericFilter": {"operation": "GREATER_THAN", "value": {"doubleValue": 50.0}}}}}}}

  A complete 4-step example:
    [{"name": "Session start", "event": "session_start"},
     {"name": "Viewed pricing",
      "filterExpression": {"funnelFieldFilter": {"fieldName": "pagePath",
         "stringFilter": {"matchType": "CONTAINS", "value": "/pricing"}}}},
     {"name": "Viewed demo form",
      "filterExpression": {"funnelFieldFilter": {"fieldName": "pagePath",
         "stringFilter": {"matchType": "CONTAINS", "value": "/request-a-demo"}}}},
     {"name": "Submitted", "event": "generate_lead"}]

### date_ranges
Same DateRange shape as run_report's date_ranges (a LIST; explicit dates or relative keywords) —
see that tool's description for the full syntax and examples. PREFER EXPLICIT YYYY-MM-DD DATES:
relative keywords are the most common reason a number here disagrees with the GA4 UI.

### funnel_breakdown
Splits the funnel by a dimension: {"breakdownDimension": "deviceCategory"}. Also useful:
'country', 'browser', 'operatingSystem'.

### funnel_next_action
What users do after each step: {"nextActionDimension": "eventName", "limit": 5}. Also useful:
'pagePath'.

### segments
Optional list of Segment objects. See
https://developers.google.com/analytics/devguides/reporting/data/v1/funnels#segments`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
        funnel_steps: z.any().describe("REQUIRED. LIST of ordered funnel steps. See the tool description."),
        date_ranges: z.any().optional().describe("LIST of DateRange objects."),
        funnel_breakdown: z.any().optional().describe('e.g. {"breakdownDimension": "deviceCategory"}'),
        funnel_next_action: z.any().optional().describe('e.g. {"nextActionDimension": "eventName", "limit": 5}'),
        segments: z.any().optional().describe("Optional LIST of Segment objects."),
        return_property_quota: z.boolean().optional().describe("Include remaining API quota in the response."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => guard("run_funnel_report", () => runFunnelReport(ctx, args as FunnelArgs)),
    );

    // -----------------------------------------------------------------
    // run_conversions_report
    // -----------------------------------------------------------------
    this.server.tool(
      "run_conversions_report",
      `Run a GA4 Data API conversions report (v1alpha). USE THIS INSTEAD OF run_report WHEN the question
is specifically about conversions, ad spend, return on ad spend (ROAS), or ATTRIBUTION MODELLING —
in particular when the user wants DATA_DRIVEN or LAST_CLICK attribution applied.

For ordinary conversion counts with no attribution-model requirement, run_report is simpler and
uses a broader schema.

${PROPERTY_ID_HINT}
${KEY_STYLE_HINT}

### Restricted schema — this report accepts ONLY these fields
dimensions (choose from): campaignName, continent, country, defaultChannelGroup, deviceCategory,
medium, platform, primaryChannelGroup, source, sourceMedium, sourcePlatform, subcontinent.

metrics (choose from): advertiserAdClicks, advertiserAdCost,
advertiserAdCostPerAllConversionsByConversionDate,
advertiserAdCostPerAllConversionsByInteractionDate, advertiserAdCostPerClick,
advertiserAdImpressions, allConversionsByConversionDate, allConversionsByInteractionDate,
returnOnAdSpendByConversionDate, returnOnAdSpendByInteractionDate, totalRevenueByConversionDate,
totalRevenueByInteractionDate.

Anything outside those two lists is rejected by the API.

### conversion_spec (required)
    {"conversionActions": [], "attributionModel": "DATA_DRIVEN"}

Pass an empty conversionActions list for ALL conversion events, or specific resource names such as
["conversionActions/12345"]. attributionModel is "DATA_DRIVEN" or "LAST_CLICK".

### date_ranges
Same DateRange shape as run_report's date_ranges — see that tool's description for the full syntax
and examples. PREFER EXPLICIT YYYY-MM-DD DATES over relative keywords.

### dimension_filter / metric_filter
Same FilterExpression shapes as run_report's dimension_filter/metric_filter — see that tool's
description for the full syntax and worked examples. The same independence restriction applies:
you cannot express ((D1 AND M1) OR (D2 AND M2)) in one request.

### order_bys
Same OrderBy shape as run_report's order_bys — see that tool's description for the full syntax and
examples.

### limit / offset
${PAGINATION_HINT}`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
        date_ranges: z.any().optional().describe("LIST of DateRange objects."),
        dimensions: z.array(z.string()).optional().describe("Only the allowed conversions dimensions listed in the description."),
        metrics: z.array(z.string()).optional().describe("Only the allowed conversions metrics listed in the description."),
        conversion_spec: z.any().describe('REQUIRED, e.g. {"conversionActions": [], "attributionModel": "DATA_DRIVEN"}'),
        dimension_filter: z.any().optional().describe("FilterExpression applied to dimensions."),
        metric_filter: z.any().optional().describe("FilterExpression applied to metrics."),
        order_bys: z.any().optional().describe("LIST of OrderBy objects."),
        limit: z.number().optional().describe("Max rows per response, <= 250000."),
        offset: z.number().optional().describe("Zero-based index of the first row."),
        currency_code: z.string().optional().describe("ISO 4217 currency code."),
        return_property_quota: z.boolean().optional().describe("Include remaining API quota in the response."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => guard("run_conversions_report", () => runConversionsReport(ctx, args as ReportArgs)),
    );

    // -----------------------------------------------------------------
    // get_custom_dimensions_and_metrics
    // -----------------------------------------------------------------
    this.server.tool(
      "get_custom_dimensions_and_metrics",
      `List the CUSTOM dimensions and metrics defined on a GA4 property, with the exact 'apiName' that
run_report accepts.

CALL THIS BEFORE using any non-standard field in a report. The value you need is 'apiName' — for
example "customEvent:form_id" (event-scoped) or "customUser:plan_tier" (user-scoped). The bare
parameter name shown in the GA4 admin UI ("form_id") is NOT accepted by the reporting API and will
come back as INVALID_ARGUMENT.

Backed by the Data API metadata endpoint, filtered to entries where customDefinition is true.
Standard dimensions and metrics are not returned here — they are documented at
https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema

${PROPERTY_ID_HINT}`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) =>
        guard("get_custom_dimensions_and_metrics", () =>
          getCustomDimensionsAndMetrics(ctx, args?.property_id),
        ),
    );

    // -----------------------------------------------------------------
    // get_account_summaries
    // -----------------------------------------------------------------
    this.server.tool(
      "get_account_summaries",
      `List every Google Analytics account and GA4 property this server's credentials can read, with
display names and property IDs.

Use this when you do not know which property to query, when a property ID returns PERMISSION_DENIED,
or when the user refers to a property by name rather than number. It takes no arguments and returns
exactly the properties the underlying Google account has access to — so it doubles as a way to
confirm what this server can and cannot see.`,
      {},
      () =>
        guard("get_account_summaries", () =>
          gaGetPaged(
            ctx, `${ADMIN_API}/v1beta/accountSummaries`, "accountSummaries"),
        ),
    );

    // -----------------------------------------------------------------
    // get_property_details
    // -----------------------------------------------------------------
    this.server.tool(
      "get_property_details",
      `Get configuration details for one GA4 property: display name, parent account, reporting time
zone, currency code, industry category, service level, and create/update timestamps.

Worth calling before interpreting date-sensitive numbers — the reporting TIME ZONE returned here is
what GA4 uses to decide which day an event belongs to, and it is a common source of off-by-one-day
disagreements. The currency code matters when reading revenue metrics.

${PROPERTY_ID_HINT}`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) =>
        guard("get_property_details", async () => {
          const rn = constructPropertyRn(args?.property_id, ctx.env);
          return gaGet(ctx, `${ADMIN_API}/v1beta/${rn}`);
        }),
    );

    // -----------------------------------------------------------------
    // list_property_annotations
    // -----------------------------------------------------------------
    this.server.tool(
      "list_property_annotations",
      `List reporting data annotations on a GA4 property — the dated notes people leave in the GA4 UI to
record releases, campaign launches, tracking changes, or anything that explains a sudden move in
the data.

Check this whenever you are explaining a spike, dip, or anomaly: an annotation on the same date is
usually the answer, and citing it beats speculating. Uses the Admin API v1alpha.

${PROPERTY_ID_HINT}`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) =>
        guard("list_property_annotations", async () => {
          const rn = constructPropertyRn(args?.property_id, ctx.env);
          return gaGetPaged(
            ctx,
            `${ADMIN_API}/v1alpha/${rn}/reportingDataAnnotations`,
            "reportingDataAnnotations",
          );
        }),
    );

    // -----------------------------------------------------------------
    // list_google_ads_links
    // -----------------------------------------------------------------
    this.server.tool(
      "list_google_ads_links",
      `List the Google Ads accounts linked to a GA4 property, including customer IDs and whether
personalised advertising and auto-tagging are enabled.

Use this to confirm that ad-cost and ROAS metrics can be expected to have data before running
run_conversions_report — if no Ads account is linked, advertiserAdCost and related metrics will be
empty, and that is a configuration fact rather than a reporting failure.

${PROPERTY_ID_HINT}`,
      {
        property_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("GA4 property ID. Defaults to the server's configured property."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) =>
        guard("list_google_ads_links", async () => {
          const rn = constructPropertyRn(args?.property_id, ctx.env);
          return gaGetPaged(
            ctx, `${ADMIN_API}/v1beta/${rn}/googleAdsLinks`, "googleAdsLinks");
        }),
    );

    logJson({ event: "mcp_init", server: SERVER_NAME, version: SERVER_VERSION, tools: 9 });
  }
}

// ===========================================================================
// HTTP layer
// ===========================================================================

/** Length-independent-ish comparison, to avoid leaking the secret via timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// --- /health ---------------------------------------------------------------
//
// Unauthenticated by design: an uptime monitor must be able to reach it, and it
// reveals nothing about the data. It DOES cause a token mint, so results are
// cached briefly — otherwise anyone could make us hammer Google's token
// endpoint and burn refresh quota.

interface HealthCache {
  at: number;
  status: number;
  body: Record<string, unknown>;
}
let healthCache: HealthCache | null = null;
const HEALTH_CACHE_MS = 30_000;

async function handleHealth(env: Env): Promise<Response> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
    return jsonResponse({ ...healthCache.body, cached: true }, healthCache.status);
  }

  let status: number;
  let body: Record<string, unknown>;

  try {
    if (env.AUTH_MODE === "oauth") {
      // In OAuth mode there is NO shared credential to validate — each user
      // holds their own grant, and we cannot exercise someone else's token
      // from an unauthenticated endpoint. So we check what we legitimately
      // can: that the app registration is configured and the grant store is
      // reachable. This is a weaker check than secret mode, and says so.
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not both set.");
      }
      if (!env.OAUTH_KV) throw new Error("OAUTH_KV namespace is not bound.");
      await env.OAUTH_KV.get("__health__"); // reachability probe; null is a fine answer
      status = 200;
      body = {
        status: "ok",
        auth: "oauth",
        note: "Per-user OAuth: no shared credential exists to validate. This checks app config and grant-store reachability only. An individual user's grant can still be expired or revoked.",
      };
    } else {
      await sharedTokenSource(env)();
      status = 200;
      body = { status: "ok", auth: "valid" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status = 503;
    // The detail names the failure mode. It contains no analytics data, no
    // token material, and no property identifiers.
    body = { status: "error", auth: "invalid", detail: truncate(message, 600) };
    logJson({ event: "health_fail", detail: truncate(message, 300) });
  }

  healthCache = { at: Date.now(), status, body };
  return jsonResponse(body, status);
}

function rootText(env: Env): string {
  const oauth = env.AUTH_MODE === "oauth";
  return (
    `${SERVER_NAME} v${SERVER_VERSION} — read-only Google Analytics 4 MCP server.\n\n` +
    `auth mode: ${oauth ? "oauth (sign in with Google)" : "shared secret (x-api-key)"}\n\n` +
    `POST /mcp     MCP endpoint${oauth ? " (OAuth bearer token)" : " (requires the x-api-key header)"}\n` +
    (oauth ? `GET  /authorize, /callback, POST /token, /register  — OAuth endpoints\n` : "") +
    `GET  /health  status check for uptime monitoring (no auth required)\n\n` +
    `This server can only read from Google Analytics. See README.md.\n`
  );
}

const mcpHandler = GA4MCP.serve("/mcp");

/** Routes that must work without any token, in BOTH auth modes. */
async function publicRoutes(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/health") return handleHealth(env);

  if (path === "/" || path === "") {
    return new Response(rootText(env), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return jsonResponse(
    { error: `Not found: ${path}.` },
    404,
  );
}

/**
 * OAuth mode. The provider owns /authorize, /token and /register, gates /mcp
 * on a valid bearer token, and passes everything else to our Google handler
 * (which serves /callback plus the public routes).
 *
 * Constructed lazily: in shared-secret mode env.OAUTH_KV is not bound, and
 * building this at module scope would be wasted work on every cold start.
 */
let oauthWorker: { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> } | null = null;

function getOAuthWorker(): NonNullable<typeof oauthWorker> {
  if (!oauthWorker) {
    oauthWorker = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: createGoogleAuthHandler({
        publicRoutes: publicRoutes as never,
      }) as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      // Dynamic client registration. MCP clients (including Claude) register
      // themselves on first connect, so there is nothing to configure by hand.
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["analytics.readonly"],
    }) as never;
  }
  return oauthWorker;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ---- OAuth mode: hand the whole request to the OAuth provider ----------
    if (env.AUTH_MODE === "oauth") {
      return getOAuthWorker().fetch(request, env, ctx);
    }

    // ---- Shared-secret mode: the original router, unchanged ---------------
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return handleHealth(env);
    }

    if (path === "/" || path === "") {
      return new Response(rootText(env), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (path === "/mcp") {
      const provided = request.headers.get("x-api-key") ?? "";

      if (!env.SHARED_SECRET) {
        logJson({ event: "config_error", detail: "SHARED_SECRET is not set" });
        return jsonResponse(
          { error: "Server misconfigured: SHARED_SECRET is not set. Run `wrangler secret put SHARED_SECRET`." },
          500,
        );
      }

      if (!safeEqual(provided, env.SHARED_SECRET)) {
        // Logged so repeated probing is visible in `wrangler tail`. The
        // supplied key itself is never logged.
        logJson({
          event: "auth_rejected",
          path,
          key_present: provided.length > 0,
          key_length: provided.length,
          ip: request.headers.get("cf-connecting-ip") ?? "unknown",
          ua: truncate(request.headers.get("user-agent") ?? "unknown", 120),
          country: (request as { cf?: { country?: string } }).cf?.country ?? "unknown",
        });
        return jsonResponse(
          { error: "Unauthorized. Supply the shared secret in the 'x-api-key' header." },
          401,
        );
      }

      logJson({
        event: "mcp_request",
        method: request.method,
        ip: request.headers.get("cf-connecting-ip") ?? "unknown",
        ua: truncate(request.headers.get("user-agent") ?? "unknown", 120),
        country: (request as { cf?: { country?: string } }).cf?.country ?? "unknown",
      });

      return mcpHandler.fetch(request, env, ctx);
    }

    return jsonResponse({ error: `Not found: ${path}. Valid paths are /, /health and /mcp.` }, 404);
  },
};

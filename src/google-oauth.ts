/**
 * Google OAuth handler — the "sign in with Google" half of per-user auth.
 *
 * WHAT THIS REPLACES
 * ------------------
 * In shared-secret mode the Worker holds ONE refresh token (the deployer's) and
 * every teammate queries as that person, proving themselves with a shared
 * password. In OAuth mode there is no shared token and no shared password:
 * each person signs into Google themselves and the Worker stores THEIR grant.
 *
 * THE FLOW (the Worker is both an OAuth server and an OAuth client)
 * -----------------------------------------------------------------
 *   Claude ──/authorize──► this Worker ──redirect──► Google consent screen
 *                                                          │
 *   Claude ◄──redirect──── this Worker ◄──/callback────────┘
 *          exchanges for                exchanges code for Google tokens,
 *          an MCP token                 stores them in the encrypted grant
 *
 * Claude never sees the Google tokens. It gets an MCP token issued by this
 * Worker, which is bound to the stored grant.
 *
 * WHY GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ARE STILL REQUIRED
 * --------------------------------------------------------------
 * Google requires every application that requests user data to be registered,
 * and those two values ARE the registration. This is not avoidable, and it is
 * not specific to this project: Slack's MCP server has a client ID and secret
 * too — Slack owns them, so users never see them. For a private internal
 * server you are the vendor, so you hold them. The difference between this and
 * shared-secret mode is that they are set once at deploy and never touched
 * again: no hand-minted refresh token, no 7-day clock, nothing to distribute.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Scopes requested from each user.
 *
 * NOTE ON SCOPE CREEP — read this before adding anything.
 * `analytics.readonly` is the only DATA scope, exactly as in shared-secret
 * mode. `openid` and `email` are identity-only: they grant no access to any
 * user data, they exist solely so the Worker learns a stable user identifier
 * to key the grant on and an email to show in logs. Without them every grant
 * would be anonymous and could not be attributed or revoked per person.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
] as const;

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/**
 * Data stored in the grant's ENCRYPTED props, and handed to tool handlers as
 * `this.props`. The library encrypts this with AES-GCM, so the user's Google
 * refresh token is not readable from KV without the corresponding token.
 */
export interface GoogleAuthProps extends Record<string, unknown> {
  /** Google's stable opaque user ID. Also the grant's userId. */
  sub: string;
  /** For logging and for `whoami`-style answers. Encrypted at rest. */
  email: string;
  /** THIS user's Google refresh token. Never leaves the Worker. */
  googleRefreshToken: string;
}

export interface OAuthEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional: restrict sign-in to one Google Workspace domain, e.g. "zuddl.com". */
  ALLOWED_EMAIL_DOMAIN?: string;
}

// ===========================================================================
// Small helpers
// ===========================================================================

function b64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Read the claims out of a Google id_token.
 *
 * We deliberately do NOT verify the signature. That is safe here, and only
 * here, because this token did not arrive from a browser or a third party — we
 * received it directly from Google's token endpoint over TLS, in the response
 * to a request we made using our own client secret. Verifying a signature on a
 * token fetched over an authenticated channel from its own issuer adds nothing.
 * If this token were ever accepted from any other source, it MUST be verified.
 */
function readIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token from Google.");
  return JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
}

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111}` +
      `h1{font-size:1.3rem;margin:0 0 .75rem}code{background:#f3f3f3;padding:.1em .35em;border-radius:4px;font-size:.9em}` +
      `.muted{color:#666;font-size:.9em}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}.muted{color:#999}}</style>` +
      body,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function logJson(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// ===========================================================================
// /authorize — start of the flow
// ===========================================================================

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logJson({ event: "oauth_authorize_bad_request", detail: message });
    return htmlPage(
      "Invalid request",
      `<h1>Invalid authorization request</h1><p>${escapeHtml(message)}</p>` +
        `<p class="muted">Start the connection from your MCP client rather than opening this URL directly.</p>`,
      400,
    );
  }

  // Confirm the client is one we know (registered via DCR or created by hand).
  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) {
    logJson({ event: "oauth_unknown_client", client_id: authReq.clientId });
    return htmlPage(
      "Unknown client",
      `<h1>Unknown client</h1><p class="muted">This MCP client is not registered with this server.</p>`,
      400,
    );
  }

  // We do not show our own consent screen. Google is about to show a real one
  // naming the exact scopes, and a second homemade dialog adds friction without
  // adding information. The MCP request is carried through Google's `state`.
  const state = b64urlEncode(JSON.stringify(authReq));

  const redirectUri = new URL("/callback", request.url).toString();
  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // offline + consent is what makes Google issue a refresh token every time,
  // rather than only on a user's very first authorization.
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("prompt", "consent");
  target.searchParams.set("include_granted_scopes", "false");
  target.searchParams.set("state", state);
  if (env.ALLOWED_EMAIL_DOMAIN) {
    // A UI hint only — Google does not enforce it. The real check is in /callback.
    target.searchParams.set("hd", env.ALLOWED_EMAIL_DOMAIN);
  }

  logJson({ event: "oauth_authorize_redirect", client_id: authReq.clientId });
  return Response.redirect(target.toString(), 302);
}

// ===========================================================================
// /callback — Google sends the user back here
// ===========================================================================

async function handleCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  const googleError = url.searchParams.get("error");
  if (googleError) {
    logJson({ event: "oauth_google_error", detail: googleError });
    return htmlPage(
      "Sign-in cancelled",
      `<h1>Sign-in did not complete</h1><p>Google returned <code>${escapeHtml(googleError)}</code>.</p>` +
        `<p class="muted">If you clicked Cancel, just start the connection again.</p>`,
      400,
    );
  }

  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return htmlPage("Invalid callback", `<h1>Invalid callback</h1><p class="muted">Missing code or state.</p>`, 400);
  }

  let authReq: AuthRequest;
  try {
    authReq = JSON.parse(b64urlDecode(stateRaw)) as AuthRequest;
  } catch {
    return htmlPage("Invalid callback", `<h1>Invalid callback</h1><p class="muted">State could not be read.</p>`, 400);
  }

  // --- Exchange the one-time code for Google tokens -----------------------
  const redirectUri = new URL("/callback", request.url).toString();
  const form = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const rawBody = await tokenRes.text();

  if (!tokenRes.ok) {
    logJson({ event: "oauth_token_exchange_failed", status: tokenRes.status, detail: rawBody.slice(0, 300) });
    let hint = "";
    if (rawBody.includes("redirect_uri_mismatch")) {
      hint =
        `<p>The redirect URI does not match. Add exactly this to your OAuth client's ` +
        `<b>Authorised redirect URIs</b> in Google Cloud Console:</p><p><code>${escapeHtml(redirectUri)}</code></p>`;
    }
    return htmlPage(
      "Sign-in failed",
      `<h1>Could not complete sign-in</h1>${hint}<p class="muted">Google returned HTTP ${tokenRes.status}.</p>`,
      502,
    );
  }

  const tokens = JSON.parse(rawBody) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };

  // --- Validate what we actually got --------------------------------------
  if (!tokens.refresh_token) {
    // Should not happen: we send prompt=consent on every authorize.
    return htmlPage(
      "Sign-in incomplete",
      `<h1>Google did not return a refresh token</h1>` +
        `<p>Revoke this app at <code>myaccount.google.com/permissions</code> and connect again.</p>`,
      502,
    );
  }
  if (!tokens.id_token) {
    return htmlPage(
      "Sign-in incomplete",
      `<h1>Google did not return an identity token</h1><p class="muted">The 'openid' scope may have been removed.</p>`,
      502,
    );
  }
  // The user can untick scopes on the consent screen. If Analytics was not
  // granted, every tool would fail later with a confusing 403 — fail now instead.
  if (tokens.scope && !tokens.scope.split(" ").includes(ANALYTICS_SCOPE)) {
    return htmlPage(
      "Missing permission",
      `<h1>Analytics permission was not granted</h1>` +
        `<p>This server needs read-only access to Google Analytics. Connect again and leave that box ticked.</p>`,
      403,
    );
  }

  const claims = readIdTokenClaims(tokens.id_token);
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!sub) {
    return htmlPage("Sign-in failed", `<h1>Could not identify the account</h1>`, 502);
  }

  // --- Optional domain restriction ----------------------------------------
  if (env.ALLOWED_EMAIL_DOMAIN) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain !== env.ALLOWED_EMAIL_DOMAIN.toLowerCase()) {
      logJson({ event: "oauth_domain_rejected", domain: domain ?? "none" });
      return htmlPage(
        "Not permitted",
        `<h1>That account cannot be used</h1>` +
          `<p>Sign in with your <code>@${escapeHtml(env.ALLOWED_EMAIL_DOMAIN)}</code> account.</p>`,
        403,
      );
    }
  }

  // --- Store the grant and hand control back to the MCP client ------------
  const props: GoogleAuthProps = {
    sub,
    email,
    googleRefreshToken: tokens.refresh_token,
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    // Google's opaque subject, NOT the email: userId is stored UNENCRYPTED
    // because the library needs it to enumerate and revoke grants. The email
    // lives in props, which are encrypted.
    userId: sub,
    metadata: { authorizedAt: Date.now() },
    scope: authReq.scope,
    props,
  });

  logJson({ event: "oauth_authorized", sub, email_domain: email.split("@")[1] ?? "unknown" });
  return Response.redirect(redirectTo, 302);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ===========================================================================
// The handler OAuthProvider calls for every non-API request
// ===========================================================================

export function createGoogleAuthHandler(options: {
  /** Serves GET / and GET /health, which must work without a token. */
  publicRoutes: (request: Request, env: never) => Promise<Response> | Response;
}) {
  return {
    async fetch(request: Request, env: OAuthEnv, _ctx: ExecutionContext): Promise<Response> {
      const path = new URL(request.url).pathname;

      if (path === "/authorize") return handleAuthorize(request, env);
      if (path === "/callback") return handleCallback(request, env);

      return options.publicRoutes(request, env as never);
    },
  };
}

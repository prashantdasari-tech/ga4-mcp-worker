# SETUP-GUIDE.md, continued — deploy, verify, connect

Continued from [SETUP-GUIDE.md](../SETUP-GUIDE.md) Part 1 (creating the Google app). You should
already have `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` before starting here.

---

# Part 2 — Deploy

**What you're doing:** uploading the code to Cloudflare and handing it the two values from Part 1,
stored encrypted so nobody (including you) can read them back out later.

```bash
npm install
```

```bash
npx wrangler login
```

Set the two secrets. **Paste at the prompt — don't pipe** (`echo "..." | wrangler secret put ...`
appends an invisible newline that breaks things in confusing ways, and also leaves the secret in your
shell history):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Confirm both landed, and that nothing else is lingering:

```bash
npx wrangler secret list --env=""
```

Should show exactly `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — nothing more.

Deploy:

```bash
npm run deploy
```

Wrangler prints your URL: `https://ga4-mcp-worker.<your-subdomain>.workers.dev`. **If this is your
first deploy**, go back to [SETUP-GUIDE.md Part 1.4](../SETUP-GUIDE.md#14--create-the-oauth-client)
now and add the exact `/callback` URL for this hostname to the OAuth client's redirect URIs, if you
hadn't already.

---

# Part 3 — Verify the deployment

> **Set your real URL once, here, and reuse it.**
>
> ```bash
> export URL="https://ga4-mcp-worker.YOUR-SUBDOMAIN.workers.dev"
> ```
>
> Use the exact hostname `npm run deploy` printed. A command below returning Cloudflare's
> `error code: 1042` almost always means this placeholder was never replaced.

## 3.1 — Root and health

```bash
curl -s "$URL/"
```

Should mention `auth mode: oauth (sign in with Google)`. Then:

```bash
curl -s "$URL/health"
```

**Want:** `{"status":"ok","auth":"oauth", ...}`. Read the `note` field in that response once — it
explains something worth knowing: in this auth mode, `/health` only confirms the app registration and
grant storage are working, **not** that any particular person's sign-in is still valid. There's no
single shared credential left to check the way the old mode had.

## 3.2 — OAuth discovery document

Proves the OAuth machinery is actually wired up, not just that the Worker responds:

```bash
curl -s "$URL/.well-known/oauth-authorization-server"
```

Should return JSON listing `/authorize`, `/token`, and `/register`.

## 3.3 — `/mcp` demands a real token

```bash
curl -s -o /dev/null -D - -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Want:** `401`, with a `www-authenticate: Bearer ...` header. That's correct — it's the server
telling a client "you need to sign in first," which is exactly what should happen to an anonymous
request now.

## Error → cause → fix

| What you see | What it means | Fix |
|---|---|---|
| `error code: 1042` from Cloudflare | Hostname doesn't exist — `$URL` still has the placeholder | `echo $URL`, compare against what `npm run deploy` printed |
| `/health` returns `503` | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` missing, or `OAUTH_KV` not bound | `npx wrangler secret list --env=""`; confirm `wrangler.toml` has the `[[kv_namespaces]]` block with `binding = "OAUTH_KV"` |
| `redirect_uri_mismatch` during actual sign-in (Part 4) | The Google OAuth client's redirect URI doesn't exactly match `$URL/callback` | [SETUP-GUIDE.md Part 1.4](../SETUP-GUIDE.md#14--create-the-oauth-client) — check for trailing slash, http vs https, or editing the wrong OAuth client |
| "Invalid origin: URIs must not contain a path" while editing the OAuth client | Pasted the callback URL into **Authorized JavaScript origins** instead of **Authorized redirect URIs** | Use the redirect URIs field — see the callout in [SETUP-GUIDE.md Part 1.4](../SETUP-GUIDE.md#14--create-the-oauth-client) |
| "Access blocked: this app's request is invalid" / `Error 400: redirect_uri_mismatch` shown by Google itself during sign-in | Same cause as above, surfaced by Google's page instead of a curl error | Same fix — recheck Part 1.4, wait ~60s after saving for it to propagate |
| Sign-in shows "That account cannot be used" | `ALLOWED_EMAIL_DOMAIN` is set and the account isn't `@zuddl.com` | Expected behaviour — sign in with a Zuddl Google account |
| `403 PERMISSION_DENIED` on a query, after successful sign-in | That person's Google account can't see the property, or an API isn't enabled | Ask Claude to run `get_account_summaries` — it lists exactly what that person's token can see. Confirm the two APIs are enabled (Part 1.2) |
| `400 INVALID_ARGUMENT` on a query | Bad dimension/metric name, or a malformed filter | For custom fields use the `apiName` from `get_custom_dimensions_and_metrics`, not the bare parameter name |
| `429` / quota errors | GA4 daily quota exhausted for that property | Re-run with `return_property_quota: true`. See [PRODUCTION.md § 3](../PRODUCTION.md#3-ga4-api-quotas) |
| `404 Not found` | Wrong path | Only `/`, `/health`, `/mcp`, and the OAuth endpoints exist |

Watch requests live while testing:

```bash
npm run tail
```

---

# Part 4 — Connect Claude Code

There is no header to configure and no secret to paste — this is the entire point of the new design.

```bash
claude mcp add --transport http --scope user ga4 "$URL/mcp"
```

Then, in an **interactive** `claude` terminal session (this exact command won't trigger a browser
sign-in from a non-interactive script):

```
/mcp
```

Pick `ga4` from the list. It should open your browser straight to the Google consent screen, scoped
to read-only Google Analytics access plus your basic identity (name/email — nothing else). Approve
it, and you'll land back on a plain confirmation page the Worker serves after `/callback`.

Confirm end to end:

> *"Using the GA4 connector, what GA4 properties can you see?"*

You should get back the three Zuddl properties (or fewer, if your Google account has narrower GA4
access than that — which is now enforced correctly, by Google, per person).

**For other teammates:** each person runs the exact same `claude mcp add` command with the same URL,
then does their own `/mcp` sign-in. Nobody needs a secret from you — they only need the URL, and
their own existing GA4 access decides what they can see.

If the connector shows connected but every query fails, check `$URL/health` first — remembering it
only proves the app itself is configured, not that a specific sign-in is still valid (see 3.1).

---

# One thing to set up before you forget

**Point a free uptime monitor at `$URL/health`** (UptimeRobot, Better Stack), 5-minute interval,
alerting somewhere you'll actually see it. It catches the app-level failures (KV unreachable,
misconfigured client) — see [PRODUCTION.md § 2](../PRODUCTION.md#2-monitoring) and
[§ 8](PRODUCTION-PART2.md#8-how-per-user-oauth-is-implemented) for what it can and can't tell you in
this auth mode.

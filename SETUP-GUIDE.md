# SETUP-GUIDE.md — first deploy, explained

This guide assumes you have never set up a Google OAuth app before. Every step says **what you're
doing and why** before it says which button to click.

Budget ~25 minutes, mostly clicking through Google Cloud Console.

> **Note if you set this server up before 2026-08-11:** an earlier version of this guide walked
> through a shared-secret flow — one hand-minted `GOOGLE_REFRESH_TOKEN`, one `SHARED_SECRET` password
> teammates pasted into a header. That mode is retired. This version has each teammate sign in with
> their own Google account instead. If you're migrating from the old mode, see
> [PRODUCTION.md § 8](PRODUCTION.md#8-per-user-oauth-mode-auth_mode--oauth) for the promotion steps —
> this guide covers a first deploy of the current design.

---

## First: what are we actually building?

You're putting a small program (a "Worker") on the internet at a URL. When a teammate wants to ask
Claude a GA4 question, they connect Claude to that URL. The Worker then needs to know two things:
**who is asking**, and **is this app even allowed to talk to Google Analytics at all**.

Those are two separate problems, solved two separate ways:

```
  Teammate's Claude          Your Worker                      Google
       │                          │                               │
       │  "sign in with Google"   │                               │
       ├─────────────────────────►│──── redirect to consent ─────►│
       │                          │                               │
       │◄─── MCP token ───────────│◄──── their own tokens ────────┤
       │                          │    (stored, encrypted,        │
       │  every later request     │     one record per person)    │
       ├─────────────────────────►│───── their token ────────────►│  GA4 data,
       │                          │                               │  as THEM
```

**Who's asking** is handled by real Google sign-in — no password of yours to distribute. Each
teammate gets their own consent screen, their own token, and their own GA4 access. If someone doesn't
have access to a property in real GA4, they don't get it here either.

**Is this app allowed to exist** is a separate, one-time registration step with Google, done once by
you at deploy time — this is what `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are for. Every
application that asks a Google user for permission has to be registered like this; it's true of this
server and it's equally true of tools like Slack's own MCP server — the difference is only that
Slack owns their registration and you never see it, whereas for a private internal tool, you're the
one holding it.

### The two values, in plain terms

| Value | What it is | Who sees it |
|---|---|---|
| `GOOGLE_CLIENT_ID` | The app's name badge — identifies "this is the Zuddl GA4 Worker" to Google. You create it in Part 1. | Set once in Cloudflare. No teammate ever sees or handles it. |
| `GOOGLE_CLIENT_SECRET` | The password proving that badge is genuine. | Same — set once, never distributed. |

An analogy that holds up: these two are the **courier company's ID card** that gets it in the
building. Each teammate's own Google sign-in is **their own signed note**, authorising the courier to
collect *their* mail specifically, not anyone else's.

Notice what's **not** in this table anymore: there is no refresh token you mint by hand, and no
password you invent and hand out to the team. Both existed in the retired shared-secret flow. Neither
exists now.

> **Never paste `GOOGLE_CLIENT_SECRET` into a chat window, Google Doc, Notion page, Jira ticket, or
> Slack message.** If it leaks, treat it as an incident — see PRODUCTION.md § 4.

### What you need before starting

- A Google Workspace account at `@zuddl.com` — sign-in is restricted to this domain (see
  `ALLOWED_EMAIL_DOMAIN` in `wrangler.toml`). Anyone at Zuddl with GA4 access can complete this flow
  for themselves; you (the deployer) only need Zuddl Google access, not any special GA4 permission,
  to do the deploy itself.
- A Cloudflare account.
- Access to Google Cloud Console. If you've never used it, that's fine — Part 1 creates everything.

---

# Part 1 — Create the Google app

**What you're doing:** registering a new application with Google, once, so Google will let *anyone*
sign into it later. This produces `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 1.1 — Pick or create a project

Go to [console.cloud.google.com](https://console.cloud.google.com). A **project** is just a
container for Google Cloud things. Use the project dropdown at the top to pick an existing one, or
create one named something like `zuddl-ga4-mcp`.

## 1.2 — Turn on the two APIs

**Why:** by default a new project can't call anything. You have to switch on each API you intend to
use. Skipping this produces a `403 PERMISSION_DENIED` later that looks exactly like a GA4 permissions
problem but isn't.

Go to **APIs & Services → Library**, then search for and **Enable** each of these:

- **Google Analytics Data API** — the one that runs reports
- **Google Analytics Admin API** — the one that lists properties and settings

## 1.3 — Configure the consent screen

**What this actually is:** the consent screen is that "*App X wants to view your Google Analytics
data — Allow / Deny*" dialog every teammate will see the first time they connect. Configuring it
means writing what that dialog says.

**Why it comes first:** Google won't let you create an OAuth client until this exists.

Go to **APIs & Services → OAuth consent screen**.

**The one choice that matters — User type:** choose **Internal**. Zuddl uses Google Workspace, so
this is available, and it means only `@zuddl.com` accounts can ever complete sign-in. It also has no
review process, no publishing step, and — unlike the External option — no 7-day token expiry to worry
about. There's no reason to pick External for this server.

Fill in the basics: app name (e.g. `Zuddl GA4 MCP`), user support email (yours), developer contact
email (yours). Nothing else is required. Save.

## 1.4 — Create the OAuth client

**What you're doing:** generating the actual ID-card-and-password pair, and telling Google exactly
where it's allowed to send people back to after they sign in.

Go to **APIs & Services → Credentials → + CREATE CREDENTIALS → OAuth client ID**.

- **Application type:** **Web application**
- **Name:** `GA4 MCP Worker` (internal label, doesn't matter)
- **Authorised redirect URIs** → **+ ADD URI** → paste exactly (substitute your Cloudflare
  subdomain — you'll know it after Part 4, but you can also come back and add it then):

```
https://ga4-mcp-worker.YOUR-SUBDOMAIN.workers.dev/callback
```

**Why this matters:** after someone approves the consent screen, Google needs somewhere legitimate to
send them back to. If the URI here doesn't match your deployed Worker's `/callback` URL **exactly** —
no trailing slash, correct scheme — sign-in fails with `redirect_uri_mismatch`. This is the single
most common setup error, and it's always a URI typo, never a code problem.

> **This field only accepts URLs with a path.** If Google complains "Invalid origin: URIs must not
> contain a path," you're pasting into the wrong box — **Authorized JavaScript origins** is a
> different field on the same page that requires a bare domain. Leave that one alone; use
> **Authorized redirect URIs** for the `/callback` URL above.

Click **Create**. A panel shows your **Client ID** and **Client secret**.

**Copy both into your password manager now.** The client secret can be re-viewed later in Cloud
Console, but saving it now avoids a round trip.

✅ You now have `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — the only two Google values this setup
needs.

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
first deploy**, go back to Part 1.4 now and add the exact `/callback` URL for this hostname to the
OAuth client's redirect URIs, if you hadn't already.

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
| `redirect_uri_mismatch` during actual sign-in (Part 4) | The Google OAuth client's redirect URI doesn't exactly match `$URL/callback` | Part 1.4 — check for trailing slash, http vs https, or editing the wrong OAuth client |
| "Invalid origin: URIs must not contain a path" while editing the OAuth client | Pasted the callback URL into **Authorized JavaScript origins** instead of **Authorized redirect URIs** | Use the redirect URIs field — see the callout in Part 1.4 |
| "Access blocked: this app's request is invalid" / `Error 400: redirect_uri_mismatch` shown by Google itself during sign-in | Same cause as above, surfaced by Google's page instead of a curl error | Same fix — recheck Part 1.4, wait ~60s after saving for it to propagate |
| Sign-in shows "That account cannot be used" | `ALLOWED_EMAIL_DOMAIN` is set and the account isn't `@zuddl.com` | Expected behaviour — sign in with a Zuddl Google account |
| `403 PERMISSION_DENIED` on a query, after successful sign-in | That person's Google account can't see the property, or an API isn't enabled | Ask Claude to run `get_account_summaries` — it lists exactly what that person's token can see. Confirm the two APIs are enabled (Part 1.2) |
| `400 INVALID_ARGUMENT` on a query | Bad dimension/metric name, or a malformed filter | For custom fields use the `apiName` from `get_custom_dimensions_and_metrics`, not the bare parameter name |
| `429` / quota errors | GA4 daily quota exhausted for that property | Re-run with `return_property_quota: true`. See PRODUCTION.md § 3 |
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
misconfigured client) — see PRODUCTION.md § 2 and § 8 for what it can and can't tell you in this auth
mode.

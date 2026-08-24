# SETUP-GUIDE.md — first deploy, explained

This guide assumes you have never set up a Google OAuth app before. Every step says **what you're
doing and why** before it says which button to click.

Budget ~25 minutes, mostly clicking through Google Cloud Console.

> **Note if you set this server up before 2026-08-11:** an earlier version of this guide walked
> through a shared-secret flow — one hand-minted `GOOGLE_REFRESH_TOKEN`, one `SHARED_SECRET` password
> teammates pasted into a header. That mode is retired. This version has each teammate sign in with
> their own Google account instead. If you're migrating from the old mode, see
> [docs/PRODUCTION-PART2.md § 8](docs/PRODUCTION-PART2.md#8-how-per-user-oauth-is-implemented) for the
> promotion steps — this guide covers a first deploy of the current design.

This is part 1 of 2 — creating the Google app. Deploying, verifying, and connecting Claude Code are
in [docs/SETUP-GUIDE-PART2.md](docs/SETUP-GUIDE-PART2.md).

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
> Slack message.** If it leaks, treat it as an incident — see [PRODUCTION.md § 4](PRODUCTION.md#4-rotation-and-revocation).

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

**Continue to [docs/SETUP-GUIDE-PART2.md](docs/SETUP-GUIDE-PART2.md):** Part 2 (deploy), Part 3
(verify the deployment), Part 4 (connect Claude Code).

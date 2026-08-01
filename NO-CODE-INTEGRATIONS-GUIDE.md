# Connecting Signal Deck to Other Systems

**Start with Settings → Automation Rules first.** That's fully built into
Signal Deck — no account to create anywhere, no sign-up, nothing external.
Most customers never need anything past that.

This guide covers an *optional, more advanced* path using Zapier or Make,
only useful if a customer already has an account with one of those tools for
other reasons and wants to connect a Google Sheet, a different app, or
something Automation Rules doesn't cover yet. It requires creating a free
account with a company that isn't Signal Deck, so it's a deliberate opt-in,
not something to reach for by default.

If you already have a developer or IT contractor, they may prefer the raw
API instead — see `API-DOCS.md`.


## What you can do without writing anything

- Automatically create a Signal Deck incident when something happens in
  another tool (a form is submitted, a row is added to a spreadsheet, an
  email arrives)
- Automatically send new Signal Deck incidents into a Google Sheet, an
  email, a Slack channel, or hundreds of other apps
- Get notified the moment an incident is resolved, anywhere Zapier/Make can
  deliver a notification

## Recipe 1: Automatically log an incident from a Google Form or Sheet

Use case: staff fill in a simple Google Form to report a problem, and it
should show up in Signal Deck automatically, without anyone opening the app.

1. Sign up free at [zapier.com](https://zapier.com) (no card required).
2. Click **Create Zap**.
3. For the trigger, search for **Google Forms** (or **Google Sheets** if
   you'd rather use a spreadsheet row), choose **New Form Response** (or
   **New Spreadsheet Row**), and connect your Google account.
4. For the action, search for **Webhooks by Zapier**, choose **POST**.
5. Set the URL to:
   ```
   https://<your-project-ref>.supabase.co/rest/v1/rpc/api_create_incident
   ```
   (Your Signal Deck account owner can get `<your-project-ref>` from Settings, or from whoever set up your Signal Deck account.)
6. Set **Payload Type** to `json`.
7. Add these fields, mapping them to your form's questions where it says "map":
   ```
   api_key: (the API key your Signal Deck admin generated for you in Settings → API keys)
   incident_title: (map to your form's "what's wrong" question)
   incident_notes: (map to your form's "details" question, or leave blank)
   category_name: Software
   severity_name: Medium
   ```
8. Add one header: `apikey` = (your Signal Deck admin will give you the Supabase anon key for this).
9. Click **Test**, then **Publish**. Done — no code was written anywhere in this recipe.

## Recipe 2: Send every new incident into a Google Sheet automatically

Use case: you want a running log of every incident in a spreadsheet you
already use, without exporting CSVs by hand.

1. In Signal Deck, go to **Settings → Webhooks**, click **Add webhook**.
2. For the URL, you'll paste a Zapier "Catch Hook" URL — so first go to
   Zapier, **Create Zap**, choose **Webhooks by Zapier** as the trigger,
   pick **Catch Hook**, and copy the URL it gives you.
3. Paste that URL into Signal Deck's webhook URL field. For the secret,
   type any random word — Zapier's free-tier "Catch Hook" doesn't check
   signatures, so this step is mainly for if you upgrade later.
4. Tick `incident.created` as the event, save.
5. Back in Zapier, for the action, search **Google Sheets**, choose
   **Create Spreadsheet Row**, connect your Google account, and map the
   incoming fields (`incident.display_id`, `incident.title`, etc.) to
   columns.
6. Publish the Zap. From now on, every new incident appears as a new row
   automatically.

## Recipe 3: Get an email whenever a Critical incident is logged

1. In Zapier, **Create Zap**, trigger: **Webhooks by Zapier** → **Catch Hook**
   (same as Recipe 2 — you can reuse the same webhook for multiple Zaps).
2. Action: search **Email by Zapier**, choose **Send Outbound Email**, fill
   in the recipient and a message using the incoming incident fields.
3. Publish. No inbox setup, no email service to configure — Zapier sends it
   for you.

## A note on security for this simple path

The "Catch Hook" URL Zapier gives you is private and hard to guess, which is
the same protection your Signal Deck self-service portal link uses. That's
good enough for most SME use. If you want stronger protection (verifying
Signal Deck's signature before trusting a webhook), that requires a small
amount of configuration in Zapier's paid "Code by Zapier" step — at that
point it's worth asking whoever manages your Signal Deck account whether the
raw API path (see `API-DOCS.md`) might suit you better instead.

## Getting help

If a recipe above doesn't work, the most common cause is a typo in the API
key or project reference — double-check those first. Otherwise, take a
screenshot of the Zapier error and share it with whoever manages your
Signal Deck account.

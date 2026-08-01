# Signal Deck — Integration API

This is for whoever builds or maintains your integration — your own developer,
an IT contractor, or a vendor's team. You (the Signal Deck account owner)
don't need to write any of this yourself; you just need to generate an API
key in **Settings → API keys** and hand this document, plus the key, to
whoever is doing the integration work.

Everything below is metadata-only: no customer names, emails, or phone
numbers are ever created, read, or exposed through this API, regardless of
what scopes a key has.

## Base URL

All calls go to your Supabase project's REST endpoint:

```
https://<your-project-ref>.supabase.co/rest/v1/rpc/<function-name>
```

Every request needs two headers:

```
Content-Type: application/json
apikey: <your Supabase anon key>
```

The Signal Deck API key itself (starting `sk_live_...`) is passed as a field
inside the JSON body, not as a header — see each example below.

## 1. Create an incident

Requires a key with the `create_incidents` scope.

```bash
curl -X POST "https://<your-project-ref>.supabase.co/rest/v1/rpc/api_create_incident" \
  -H "Content-Type: application/json" \
  -H "apikey: <supabase-anon-key>" \
  -d '{
    "api_key": "sk_live_...",
    "incident_title": "Cold room temperature alarm",
    "incident_notes": "Sensor 3 reporting -2°C above threshold for 10 minutes",
    "category_name": "Facilities",
    "severity_name": "High"
  }'
```

Returns the new incident's reference number as plain text, e.g. `"INC-2026-4821"`.

`category_name` and `severity_name` must match names configured in Settings —
if they don't match anything, the system falls back to your first category
and Medium severity respectively, so a typo never fails silently into
nothing being logged.

## 2. Update an incident's status

Requires a key with the `update_incidents` scope.

```bash
curl -X POST "https://<your-project-ref>.supabase.co/rest/v1/rpc/api_update_status" \
  -H "Content-Type: application/json" \
  -H "apikey: <supabase-anon-key>" \
  -d '{
    "api_key": "sk_live_...",
    "incident_display_id": "INC-2026-4821",
    "new_status_name": "Resolved"
  }'
```

`new_status_name` must match a status configured in Settings exactly.

## 3. List incidents

Requires a key with the `read_incidents` scope. Returns metadata only — title,
category, severity, status, source, and timestamps. Never returns names,
emails, or phone numbers, even if this organisation's Identity Module is on.

```bash
curl -X POST "https://<your-project-ref>.supabase.co/rest/v1/rpc/api_list_incidents" \
  -H "Content-Type: application/json" \
  -H "apikey: <supabase-anon-key>" \
  -d '{
    "api_key": "sk_live_...",
    "since": "2026-07-01T00:00:00Z"
  }'
```

Omit `"since"` (or pass `null`) to get the most recent 200 incidents.

## 4. Webhooks — Signal Deck notifying your system

Configured in **Settings → Webhooks**. The moment a matching event happens,
Signal Deck sends:

```
POST <your URL>
Content-Type: application/json
X-Signal-Deck-Signature: <hex-encoded HMAC-SHA256 of the raw request body, using your webhook secret as the key>

{
  "event": "incident.created",
  "incident": {
    "display_id": "INC-2026-4821",
    "title": "Cold room temperature alarm",
    "source": "api",
    "created_at": "2026-07-16T09:12:00Z",
    "resolved_at": null
  }
}
```

Events available: `incident.created`, `incident.resolved`, `incident.status_changed`.

**Always verify the signature before trusting a webhook call.** Example in Node.js:

```js
const crypto = require("crypto");

function isValid(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

If the signature doesn't match, discard the request — it didn't come from
Signal Deck.

## Key management notes

- A key is shown in full exactly once, at creation. If it's lost, revoke it
  and create a new one — there's no way to retrieve a raw key after the fact.
- Revoking a key takes effect immediately; anything using it will start
  getting an "Invalid API key" error on the next call.
- Scope a key to only what the integration actually needs. A system that
  only ever creates incidents should hold a key with `create_incidents`
  only, not all three scopes.

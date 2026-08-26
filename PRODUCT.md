# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small-business staff across any department — IT, HR, Facilities, Vendor & Procurement — managing tickets end to end (intake, triage, resolution, follow-up). Confirmed: no template is "the real product" with others bolted on; an HR or Vendor & Procurement org is meant to feel exactly as first-class as an IT org, both in the staff app (terminology, enabled modules) and on the customer-facing portal/track pages. Staff are generally non-technical small-business employees, not dedicated ITSM specialists.

Secondary users, all reached without an account: anonymous customers/employees filing and tracking a ticket via a portal/track link, vendors receiving an RFQ or a tracking link for an issue that involves them, and on-call responders acknowledging an escalation from an emailed/WhatsApp link.

## Product Purpose

Incident/ticket management built to serve any department at a small business, not just IT — track an issue from self-service intake through resolution with severity/SLA handling, automatic self-service deflection before a ticket is even filed, category-based team routing, vendor/procurement coordination, and on-call escalation.

## Positioning

Confirmed as a combination, not a single differentiator: (1) genuine self-service deflection — KB search is built directly into the submission form itself as the customer types, with what was shown and whether it helped fed back to staff on the resulting ticket, not a separate help center nobody visits; (2) built for South African SMEs specifically — POPIA-driven privacy handling, ZAR pricing, and an honestly lean/affordable alternative to enterprise ITSM tools that don't tailor for this market; (3) no-login flows for every non-staff party, not just the customer — vendors and on-call responders also get token-based access with no account required, which most comparable tools only offer on the customer side.

## Operating Context

Portal submission (with live KB deflection) → tracking link for the customer → staff triage/assignment/resolution → optional vendor RFQ/quote or vendor-visible comment thread → escalation policies (Slack/Teams/WhatsApp/email) with on-call rotations → War Room for critical, actively-worked incidents → custom dashboards for reporting. A "practice mode" lets a new org owner safely try their own portal without a submission being mistaken for a real ticket.

## Capabilities and Constraints

- Business templates set terminology (e.g. "Incident" → "Case"/"Vendor Issue") and which modules are even visible (Problems, CMDB, on-call, service catalog, SLA policies, vendors, time logging); org-level overrides always win over the template default.
- Categories can route a new ticket straight to a resolver group/team automatically; portal and manual creation both use this.
- Vendor and customer communication both run through token-based, no-login pages with a real two-way comment thread, kept structurally separate from internal-only notes.
- Everything customer-facing text-input runs through PII redaction before storage; the portal never collects a name/contact/ID number even when the optional Identity Module (explicit-consent customer contact capture, for follow-up notifications) is on.
- Time-in-status and manual time logging feed an optional ambient cost estimate (org sets an hourly rate) and reporting.
- Naming note (open, not resolved): an internal brand-audit check exists in this repo because a similarly-named "Signaldeck.com" competitor was flagged as a possible trademark/naming-conflict risk — unresolved, not a confirmed constraint, but worth surfacing before any brand/identity work.

## Evidence on Hand

Real production deployment (Cloudflare Worker, live Supabase backend) with real accumulated multi-org QA/test data across several business templates. No customer testimonials, case studies, press, or third-party benchmarks exist — do not fabricate any.

## Product Principles

- Self-service that fails must never trap someone with no way to actually get help — the Submit button stays available throughout.
- Honest data over fabricated precision — e.g. the customer-facing "typical resolution time" only ever renders with 5+ real historical samples; it stays silent otherwise rather than showing a fake number.
- No added complexity that doesn't earn its place — new capability only ships when it demonstrably serves a stated need, not novelty for its own sake.
- Privacy by default — redaction and consent gating apply everywhere customer or vendor text is captured, not just on the paths someone happened to think of.
- Every non-staff party (customer, vendor, on-call responder) gets the same no-login, no-jargon, "often only one chance" standard of care as the primary customer flow.

## Accessibility & Inclusion

WCAG 2 contrast (4.5:1 floor) is an enforced standard on every customer/vendor-facing page, not just the staff app. Portal/track/vendor pages are designed for a non-technical visitor with no account, no training, and often no one to ask — copy stays plain and error states stay honest about what went wrong without exposing internals.

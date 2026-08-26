---
name: Signal Deck
description: A calm, dark ops console for incident/ticket management, where one amber signal is the only color allowed to shout
colors:
  deep-signal-navy: "#0A1120"
  console-panel: "#121B2E"
  raised-console: "#182338"
  hairline-steel: "#232F47"
  signal-amber: "#F5A623"
  clear-channel-teal: "#2DD4BF"
  alarm-red: "#F0483E"
  low-signal-blue: "#6C8CFF"
  caution-yellow: "#EAB308"
  pending-violet: "#A78BFA"
  deck-white: "#E8ECF3"
  muted-slate: "#8B96AB"
  faint-slate: "#838EA9"
  amber-ink: "#1A1200"
  pure-white: "#fff"
  modal-scrim: "rgba(5,8,16,0.9)"
typography:
  display:
    fontFamily: "Space Grotesk, sans-serif"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Inter, sans-serif"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "8px"
  lg: "12px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
components:
  button-primary:
    backgroundColor: "{colors.signal-amber}"
    textColor: "#1A1200"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  badge:
    rounded: "{rounded.full}"
    padding: "2px 8px"
---

# Design System: Signal Deck

## Overview

**Creative North Star: "The Single Signal"**

Named by the author, not a user-confirmed metaphor — the user declined all three offered options without naming a replacement, so this is a disclosed executive call, easy to overrule later. It's grounded in the system's own recurring, user-confirmed logic: one hue (amber) is allowed to carry weight on any given screen, and every other color in the system already has a specific, claimed meaning (severity, health, pending-decision) rather than existing for decoration. Confirmed mood: **calm & restrained**. Confirmed component character: **tactile and confident** — clickable things read as solidly clickable, but there's still only ever one loud thing per screen.

The system reads as a technical operations console, not a marketing surface: exact monospaced data (IDs, timestamps, tokens) sits next to plain-language copy, and nothing is decorated beyond what a specific state (severity, breach, escalation, pending) needs to say. Depth comes from three flat, stacked layers of near-black navy — never a shadow. The whole thing is engineered to stay legible and calm while someone is looking at it because something is actually wrong.

**Key Characteristics:**
- One primary accent (amber), used sparingly, never decoratively
- Fully flat — depth is layered background steps plus hairline borders, not shadows
- Every non-neutral hue has one specific, claimed meaning; none are interchangeable
- Monospace for anything a human reads aloud or copies; Inter for everything else

## Colors

A near-black neutral stack carries almost the entire interface; color only enters to mean something specific.

### Primary
- **Signal Amber** (#F5A623): the one primary accent — primary buttons, the brand mark, High severity, "approaching breach" states. Used on a small minority of any given screen by design; its rarity is what makes it legible as "pay attention here."

### Secondary
- **Clear Channel Teal** (#2DD4BF): healthy / resolved / met-deadline states, and the late end of the Status pill gradient (see Named Rules below).
- **Alarm Red** (#F0483E): Critical severity, SLA breach, escalation, destructive actions. The only hue reserved exclusively for "something is actually wrong."

### Tertiary
- **Low-Signal Blue** (#6C8CFF): Low severity, and the early end of the Status pill gradient.
- **Caution Yellow** (#EAB308): Medium severity only — deliberately distinct from amber so a mid-severity incident and a High/near-breach one never look identical at a glance.
- **Pending Violet** (#A78BFA): "awaiting a decision" states (e.g. pending approval) — chosen specifically because every warm hue already implies urgency and teal already implies health; violet implies neither.

### Neutral
- **Deep Signal Navy** (#0A1120): page background, the base layer.
- **Console Panel** (#121B2E): panel/card surfaces, one step lighter than the page.
- **Raised Console** (#182338): inputs and anything that needs to read as "in front of" its containing panel.
- **Hairline Steel** (#232F47): the one border color used everywhere; also the scrollbar thumb.
- **Deck White** (#E8ECF3): primary text.
- **Muted Slate** (#8B96AB): secondary text (field labels, helper copy).
- **Faint Slate** (#838EA9): tertiary text (timestamps, reference IDs, "no data yet" placeholders) — pinned at exactly the WCAG 4.5:1 floor on both Deep Signal Navy and Console Panel; a real regression under this value was found and fixed across four files in this project's history.
- **Amber Ink** (#1A1200): the text/icon color used on top of a solid Signal Amber fill (primary buttons, the reveal-key modal) — near-black rather than true black, for warmth against the amber rather than a harsh punch-through.
- **Pure White** (#fff): text on top of a solid Alarm Red fill (destructive-confirm buttons only) — deliberately not Deck White, which is reserved for text on the neutral background stack.
- **Modal Scrim** (rgba(5,8,16,0.9)): the full-screen overlay behind a blocking modal (destructive confirmation, one-time secret reveal) — darker and more opaque than any panel background, so the modal reads as interrupting the page rather than sitting on it.

### Named Rules
**The One Claimed Meaning Rule.** No hue is reused across two unrelated concepts on the same surface. Every existing color already means something specific (severity rank, health, pending-decision, danger); introducing a new use for an existing hue recreates a real, previously-shipped ambiguity bug rather than a fresh one.

**The Tinted Badge Rule.** Every status/severity/exception badge uses the same recipe: `color + "22"` background (~13% opacity), `color + "55"` border (~33% opacity), solid `color` for the text/icon. Never a solid-fill badge; never a plain-bordered one.

## Typography

**Display Font:** Space Grotesk (with sans-serif fallback)
**Body Font:** Inter (with sans-serif fallback)
**Label/Mono Font:** JetBrains Mono (with monospace fallback)

**Character:** A geometric, slightly technical display face over a neutral, highly legible body face, with a true monospace reserved for anything data-shaped — the pairing reads as "engineered," not "designed."

### Hierarchy
- **Display** (600, 18–24px depending on context, tight line-height): brand wordmark, every panel/section title, and every large stat number (open/breached counts, time-open, effectiveness tallies). Not reserved for a single hero headline — it's the system's title-and-number face throughout.
- **Body** (400–500, 13–14px): paragraphs, descriptions, form values.
- **Label** (500, 10–12px, `COLORS.muted` or `COLORS.faint`): field labels, helper text, stat captions.
- **Mono** (400, 10–13px): reference IDs (`INC-2026-####`), timestamps, tokens, API keys — anything a person might need to read aloud or copy-paste exactly.

### Named Rules
**The Read-Aloud Rule.** If a value is something a person might read aloud over the phone or copy-paste exactly (an ID, a token, a timestamp), it's set in JetBrains Mono. Everything else is Inter.

## Layout

Single-column, mobile-first stacking: panels stack vertically by default and only form a grid (`grid-cols-3`) for compact stat cards on wider viewports. Panels are the atomic layout unit — a bordered, padded container with its own `sd-display` title — and a page is simply a vertical sequence of them. No sidebar-plus-canvas app-shell grid; navigation is a bottom/top tab bar, not a persistent rail.

## Elevation & Depth

Flat within the page — every embedded panel, card, and badge conveys depth through a three-step background ramp (Deep Signal Navy → Console Panel → Raised Console, darkest to lightest) plus a single hairline border color, never elevation or shadow. Emphasis (an active/selected/at-risk state) is conveyed the same flat way: an alpha-tinted background wash and a matching alpha-tinted border in the relevant semantic color, per the Tinted Badge Rule above.

The one confirmed exception: content that floats *above* the page rather than sitting embedded in it — the two transient notification types (bottom-center toast, top-right ambient flag) — uses a real box-shadow (`shadow-xl`/`shadow-2xl`) specifically because it needs to read as detached from the page underneath it, which the flat background-ramp technique can't communicate on its own. Modals use the Modal Scrim instead of a shadow for the same "this is above the page" job.

### Named Rules
**The Flat-By-Default Rule.** Nothing embedded in the page lifts off it. A state that needs to stand out within the page gets a color wash and a colored border, never a shadow or a translate/scale hover lift — reserve an actual shadow for the rare case of a transient element floating above the entire page.

## Shapes

Two radii cover the whole system: 8px (`rounded-lg`, hard-coded into the shared `.sd-in*`/`.sd-btn-*` CSS classes) for every button and input, and 12px (`rounded-xl`) for every panel/card container. Badges, pills, and avatars use `rounded-full`. No sharp corners appear anywhere. Borders are always 1px, always `Hairline Steel` at full opacity for structural dividers, or a semantic color at ~33% opacity for emphasis — never a heavier weight.

## Components

### Buttons
- **Shape:** 8px radius, matching every input.
- **Primary:** solid Signal Amber fill, near-black (#1A1200) text for maximum contrast — the one loud, unmistakably-clickable element on a screen.
- **Ghost/Secondary:** transparent background, 1px Hairline Steel border, Signal Amber text. Used for every non-primary action, including destructive ones that don't need extra alarm (e.g. "Unlink").

### Badges / Pills (severity, status, exceptions)
- **Style:** `rounded-full`, the Tinted Badge recipe (see Named Rules), 10–11px semibold text.
- **Distinctive behavior — Status pills specifically don't have a fixed color per status name.** Because every org can rename/reorder its own statuses, `StatusPill` interpolates a color between Low-Signal Blue and Clear Channel Teal based on the status's *position* in the org's own ordered list, not its label. A real, independent signal that can't be represented by this gradient (e.g. `escalated_at`, `acknowledged_at`) gets its own small standalone badge instead of being folded into the pill.

### Named Rules
**The Position Gradient Rule.** Status color is a function of list position (blue → teal, early → late), never a string match on a status name — the same org-configurability that makes templates possible means no status name is guaranteed to exist.

### Cards / Panels
- **Corner Style:** 12px radius.
- **Background:** Console Panel, one step lighter than the page behind it.
- **Shadow Strategy:** none — see Elevation & Depth.
- **Border:** 1px Hairline Steel.
- **Internal Padding:** 16px (`p-4`), with an `sd-display` title row (amber icon + title) at the top of nearly every panel — the Status panel is a deliberate, confirmed exception, where the icon color itself carries state (teal once resolved, amber otherwise).

### Inputs / Fields
- **Style:** Raised Console background (one step lighter than whatever panel contains it — an input is never the same color as its own container), 1px Hairline Steel border, 8px radius.
- **Error:** Alarm Red text for the message; the field border itself is not restyled on error.

### Navigation
Bottom/top tab bar (Deck, Incidents, Log Incident, Problems, Assets, Vendors, Preventatives, Dashboards, Diagnostics, Privacy, Settings), icon-over-label, amber for the active tab, muted-slate for inactive. No persistent sidebar.

## Do's and Don'ts

### Do:
- **Do** reserve Signal Amber for the single primary action or a genuinely high-severity/near-breach signal — never decoration.
- **Do** use the Tinted Badge recipe for any new status/exception indicator, never a solid-fill or plain-outline badge.
- **Do** set any ID, token, or timestamp in JetBrains Mono.
- **Do** derive status/severity color from data (position in list, severity rank) rather than hardcoding to a label string.

### Don't:
- **Don't** add a box-shadow to anything embedded in the page (panels, cards, badges) — reserve it for the rare transient element that genuinely floats above the whole page (a toast, an ambient notification).
- **Don't** reuse an existing hue for a new, unrelated meaning — every color here already means something specific, and this project has already shipped and fixed the ambiguity bug that causes.
- **Don't** set body text below Faint Slate (#838EA9) on either Deep Signal Navy or Console Panel — a real regression under the 4.5:1 WCAG floor was found and fixed here before.
- **Don't** hardcode a status or category name anywhere in styling logic — both are fully org-configurable per business template.

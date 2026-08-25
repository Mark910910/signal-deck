import React, { useState, useEffect, useCallback } from "react";
import { Anchor, Check } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
  // Was #5B6580 — ~3.25:1 on bg, failing WCAG 1.4.3's 4.5:1 floor. Same
  // fix already applied in App.jsx/WarRoom.jsx but missed on this file —
  // the one a vendor with zero context on Signal Deck reads first.
  // #838EA9 clears 4.5:1.
  faint: "#838EA9",
};

// Same no-login pattern as VendorTrackPage — the exact thing the SME-
// focused competitor found in research is most praised for: a link, no
// account, submit a price, done.
export default function VendorQuotePage({ token }) {
  const [request, setRequest] = useState(null);
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("get_quote_request_for_vendor", { track_token: token });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { setError("This link doesn't look right — please check it with whoever sent it."); return; }
    setRequest(row);
    if (row.submitted_at) { setSubmitted(true); setPrice(row.quoted_price || ""); setNotes(row.notes || ""); setValidUntil(row.valid_until || ""); }
    // Fire-and-forget — lets staff tell "opened, still deciding" apart from
    // "never even saw the link" instead of both looking like "no response".
    supabase.rpc("mark_quote_viewed", { track_token: token });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!price) return;
    setSending(true);
    const { error } = await supabase.rpc("submit_quote_response", { track_token: token, price: parseFloat(price), quote_notes: notes, expires: validUntil || null });
    setSending(false);
    if (error) { setError("Couldn't submit that — please try again."); return; }
    setSubmitted(true);
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh" }} className="flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-5 justify-center">
          <Anchor size={18} color={COLORS.amber} />
          <span style={{ color: COLORS.text, fontWeight: 600 }}>Submit your quote</span>
        </div>

        <div className="rounded-xl p-5" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          {error && <p className="text-sm" style={{ color: COLORS.red }}>{error}</p>}

          {request && (
            <>
              <div className="mb-4">
                <div className="text-xs mb-1" style={{ color: COLORS.faint }}>{request.display_id}</div>
                <div className="text-sm mb-1" style={{ color: COLORS.text }}>We'd like a quote for:</div>
                <p className="text-sm" style={{ color: COLORS.muted }}>{request.description}</p>
                {/* Deliberately coarse — a plain-language window, never an
                    exact countdown, and derived only from data the vendor
                    can already partly infer (that this is linked to
                    something urgent) — never the incident's own title or
                    customer detail, which stays internal. */}
                {request.linked_incident_severity && !request.linked_incident_resolved_at && (() => {
                  const deadline = new Date(request.linked_incident_created_at).getTime() + request.linked_incident_sla_minutes * 60000;
                  const hoursLeft = Math.round((deadline - Date.now()) / 3600000);
                  return (
                    <p className="text-xs mt-2" style={{ color: COLORS.amber }}>
                      This is holding up an active issue {hoursLeft > 0 ? `we're aiming to have sorted within about ${hoursLeft} hour${hoursLeft !== 1 ? "s" : ""}` : "that's already past its target time"}.
                    </p>
                  );
                })()}
              </div>

              {submitted ? (
                <div className="rounded-lg p-3 text-center" style={{ background: COLORS.teal + "18", border: `1px solid ${COLORS.teal}44` }}>
                  <Check size={20} color={COLORS.teal} className="mx-auto mb-1" />
                  <p className="text-sm" style={{ color: COLORS.teal }}>Quote submitted — thank you.</p>
                  <p className="text-xs mt-1" style={{ color: COLORS.muted }}>You quoted R{Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{validUntil ? `, valid until ${validUntil}` : ""}.</p>
                  {/* The backend RPC (submit_quote_response) is a plain UPDATE
                      with no re-submission guard — this confirmation screen was
                      the only thing actually blocking a correction. Re-showing
                      the form pre-filled with what was already submitted, same
                      pattern as editing a Typeform response after the fact. */}
                  <button onClick={() => setSubmitted(false)} className="text-xs underline mt-2" style={{ color: COLORS.muted }}>Edit my quote</button>
                </div>
              ) : (
                <>
                  <label htmlFor="quote-price" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Your price</label>
                  <input id="quote-price" type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
                    className="w-full mb-2 px-2.5 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
                  <label htmlFor="quote-valid-until" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Valid until (optional)</label>
                  <input id="quote-valid-until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)}
                    className="w-full mb-2 px-2.5 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
                  <label htmlFor="quote-notes" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Notes (optional)</label>
                  <textarea id="quote-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                    className="w-full mb-3 px-2.5 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
                  <button onClick={submit} disabled={sending || !price} className="w-full py-2 rounded-lg text-sm font-semibold" style={{ background: COLORS.amber, color: "#1A1200" }}>
                    {sending ? "Submitting…" : "Submit quote"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

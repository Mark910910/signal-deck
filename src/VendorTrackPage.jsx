import React, { useState, useEffect, useCallback } from "react";
import { Anchor, Send } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
  // Was #5B6580 — ~3.25:1 on bg, failing WCAG 1.4.3's 4.5:1 floor. Same
  // fix already applied in App.jsx/WarRoom.jsx but missed on this file —
  // the one most likely read by a vendor with no account. #838EA9 clears
  // 4.5:1.
  faint: "#838EA9",
};

// The vendor-facing half of the vendor portal — reuses the exact same
// proven pattern as the customer TrackPage: no login, a token from an
// emailed link, a status view, and a reply thread scoped to only what
// this vendor should see. Deliberately kept simpler than the customer
// version for this first pass — no attachments, no reopen — since the
// core gap being closed is "can a vendor see and respond at all," not
// full feature parity with the customer side yet.
export default function VendorTrackPage({ token }) {
  const [status, setStatus] = useState(null);
  const [comments, setComments] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      supabase.rpc("get_incident_status_for_vendor", { track_token: token }),
      supabase.rpc("list_vendor_visible_comments", { track_token: token }),
    ]);
    const row = Array.isArray(s.data) ? s.data[0] : s.data;
    if (!row) { setError("This link doesn't look right — please check it with whoever sent it."); return; }
    setStatus(row);
    setComments(c.data || []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function sendReply() {
    if (!reply.trim()) return;
    setSending(true);
    const { error } = await supabase.rpc("add_vendor_comment", { track_token: token, comment_body: reply });
    setSending(false);
    if (error) { setError("Couldn't send that — please try again."); return; }
    setReply("");
    await load();
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh" }} className="flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-5 justify-center">
          <Anchor size={18} color={COLORS.amber} />
          <span style={{ color: COLORS.text, fontWeight: 600 }}>View this issue</span>
        </div>

        <div className="rounded-xl p-5" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          {error && <p className="text-sm" style={{ color: COLORS.red }}>{error}</p>}

          {status && (
            <>
              <div className="mb-4">
                <div className="text-xs mb-1" style={{ color: COLORS.faint }}>{status.display_id}</div>
                <div className="text-sm font-medium mb-1" style={{ color: COLORS.text }}>{status.title}</div>
                <div className="text-xs mb-2" style={{ color: COLORS.muted }}>Regarding: {status.vendor_name}</div>
                <div className="text-xs px-2 py-0.5 rounded-full inline-block" style={{ background: status.resolved_at ? COLORS.teal + "22" : COLORS.amber + "22", color: status.resolved_at ? COLORS.teal : COLORS.amber }}>
                  {status.resolved_at ? "Resolved" : status.status_name || "In progress"}
                </div>
              </div>

              <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
                {comments.map((c, i) => (
                  <div key={i} className="text-xs p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
                    <div className="mb-1" style={{ color: COLORS.faint }}>{c.author_type === "vendor" ? "You" : "Support team"} · {new Date(c.created_at).toLocaleString()}</div>
                    <div style={{ color: COLORS.text }}>{c.body}</div>
                  </div>
                ))}
                {comments.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No messages yet.</p>}
              </div>

              <label htmlFor="vendor-reply" className="text-xs font-medium block mb-1" style={{ color: COLORS.faint }}>Reply</label>
              <textarea id="vendor-reply" value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Reply here…"
                className="w-full mb-2 px-2.5 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
              <button onClick={sendReply} disabled={sending || !reply.trim()} className="w-full py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5" style={{ background: COLORS.amber, color: "#1A1200" }}>
                <Send size={14} /> {sending ? "Sending…" : "Send reply"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

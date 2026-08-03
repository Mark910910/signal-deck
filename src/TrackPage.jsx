import React, { useState, useEffect, useCallback } from "react";
import { Anchor, Send } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB", faint: "#5B6580",
};

// The other half of the portal: once a customer has a tracking link, this
// is where they check status and read/write the customer-visible thread —
// never the internal-only notes staff leave for each other.
export default function TrackPage({ token }) {
  const [status, setStatus] = useState(null); // undefined-safe: null = loading/error
  const [comments, setComments] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      supabase.rpc("get_incident_status_for_customer", { track_token: token }),
      supabase.rpc("list_customer_visible_comments", { track_token: token }),
    ]);
    const row = Array.isArray(s.data) ? s.data[0] : s.data;
    if (!row) { setError("This link doesn't look right — please check it with whoever gave it to you."); return; }
    setStatus(row);
    setComments(c.data || []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function sendReply() {
    if (!reply.trim()) return;
    setSending(true);
    const { error } = await supabase.rpc("add_customer_comment", { track_token: token, comment_body: reply });
    setSending(false);
    if (error) { setError("Couldn't send that — please try again."); return; }
    setReply("");
    await load();
  }

  return (
    <Centered>
      <div className="w-full max-w-sm p-6 rounded-xl" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-4">
          <Anchor size={18} color={COLORS.amber} />
          <span className="text-base font-semibold" style={{ color: COLORS.text }}>Track your issue</span>
        </div>

        {error && <p className="text-sm" style={{ color: COLORS.red }}>{error}</p>}

        {status && (
          <>
            <div className="mb-4">
              <div className="text-xs sd-mono mb-1" style={{ color: COLORS.faint }}>{status.display_id}</div>
              <div className="text-sm font-medium mb-1" style={{ color: COLORS.text }}>{status.title}</div>
              <div className="text-xs px-2 py-0.5 rounded-full inline-block" style={{ background: status.resolved_at ? COLORS.teal + "22" : COLORS.amber + "22", color: status.resolved_at ? COLORS.teal : COLORS.amber }}>
                {status.resolved_at ? "Resolved" : status.status_name || "In progress"}
              </div>
            </div>

            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {comments.map((c, i) => (
                <div key={i} className="text-xs p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
                  <div className="mb-1" style={{ color: COLORS.faint }}>{c.author_type === "staff" ? "Support team" : "You"} · {new Date(c.created_at).toLocaleString()}</div>
                  <div style={{ color: COLORS.text }}>{c.body}</div>
                </div>
              ))}
              {comments.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No messages yet.</p>}
            </div>

            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Add a message — avoid sharing ID numbers or banking details"
              className="w-full mb-2 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
            <button onClick={sendReply} disabled={sending || !reply.trim()} className="w-full py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2" style={{ background: COLORS.amber, color: "#1A1200" }}>
              <Send size={13} /> {sending ? "Sending…" : "Send"}
            </button>
          </>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }) {
  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="flex items-center justify-center p-4">
      {children}
    </div>
  );
}

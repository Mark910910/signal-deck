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
  const [attachments, setAttachments] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [error, setError] = useState("");
  const [showReopen, setShowReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);

  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // Same 10MB cap as the staff side — one consistent limit everywhere

  const load = useCallback(async () => {
    const [s, c, a] = await Promise.all([
      supabase.rpc("get_incident_status_for_customer", { track_token: token }),
      supabase.rpc("list_customer_visible_comments", { track_token: token }),
      supabase.rpc("list_customer_attachments", { track_token: token }),
    ]);
    const row = Array.isArray(s.data) ? s.data[0] : s.data;
    if (!row) { setError("This link doesn't look right — please check it with whoever gave it to you."); return; }
    setStatus(row);
    setComments(c.data || []);
    setAttachments(a.data || []);
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

  async function reopen() {
    if (!reopenReason.trim()) return;
    setReopening(true);
    const { error } = await supabase.rpc("reopen_incident_via_token", { track_token: token, reason: reopenReason });
    setReopening(false);
    if (error) { setError(error.message); return; }
    setShowReopen(false); setReopenReason("");
    await load();
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadError("That file is larger than 10MB — please attach a smaller file.");
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(",")[1];
      const { data, error } = await supabase.functions.invoke("upload-customer-attachment", {
        body: { track_token: token, file_name: file.name, file_base64: base64 },
      });
      setUploading(false);
      if (error || data?.error) { setUploadError(data?.error || "Upload failed — please try again."); return; }
      await load();
    };
    reader.readAsDataURL(file);
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
              {status.can_reopen && !showReopen && (
                <button onClick={() => setShowReopen(true)} className="block mt-2 text-xs underline" style={{ color: COLORS.amber }}>Still not fixed? Reopen this</button>
              )}
              {showReopen && (
                <div className="mt-2 p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
                  <label htmlFor="reopen-reason" className="text-[11px] font-medium block mb-1" style={{ color: COLORS.faint }}>What's still wrong? (required)</label>
                  <textarea id="reopen-reason" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} rows={2} placeholder="Describe what's still not fixed"
                    className="w-full mb-2 px-2 py-1.5 rounded text-xs" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
                  <button onClick={reopen} disabled={reopening || !reopenReason.trim()} className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: COLORS.amber, color: "#1A1200" }}>
                    {reopening ? "Reopening…" : "Reopen"}
                  </button>
                </div>
              )}
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

            <div className="mb-4">
              <div className="text-xs mb-1.5" style={{ color: COLORS.faint }}>Attachments</div>
              {attachments.map((a, i) => (
                <div key={i} className="text-xs px-2 py-1.5 rounded-lg mb-1" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.muted }}>{a.file_name}</div>
              ))}
              {attachments.length === 0 && <p className="text-xs mb-1.5" style={{ color: COLORS.faint }}>None yet.</p>}
              {uploadError && <p className="text-xs mb-1.5" style={{ color: COLORS.red }}>{uploadError}</p>}
              <label htmlFor="attachment-input" className="text-xs underline cursor-pointer" style={{ color: COLORS.amber }}>
                {uploading ? "Uploading…" : "Attach a photo or file (up to 10MB)"}
                <input id="attachment-input" type="file" onChange={handleUpload} disabled={uploading} className="hidden" />
              </label>
            </div>

            <label htmlFor="reply-message" className="text-xs font-medium block mb-1" style={{ color: COLORS.faint }}>Add a message</label>
            <textarea id="reply-message" value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Avoid sharing ID numbers or banking details"
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

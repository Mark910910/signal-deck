import React, { useState, useEffect } from "react";
import { Anchor, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
};

// The receiving half of "received, not just sent" — AckPage.jsx already
// proves someone saw the *incident*; this proves someone saw a specific
// *escalation* (a Slack/Teams page, one of possibly several over an
// incident's life), so the Escalate log can say "acknowledged 4m ago"
// instead of just "sent" and stopping there. Same one-tap, no-login
// pattern, same reason: whoever's reading this is on their phone, not at
// a desk.
export default function EscalationAckPage({ token }) {
  const [state, setState] = useState("loading"); // loading | done | error
  const [displayId, setDisplayId] = useState("");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("acknowledge_escalation_via_token", { token_value: token });
      if (error) { setError(error.message); setState("error"); return; }
      setDisplayId(data?.display_id || "");
      setChannel(data?.channel || "");
      setState("done");
    })();
  }, [token]);

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="flex items-center justify-center p-4">
      <div className="w-full max-w-sm p-6 rounded-xl text-center" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-center gap-2 mb-4">
          <Anchor size={18} color={COLORS.amber} />
          <span className="text-base font-semibold" style={{ color: COLORS.text }}>Confirming you saw this</span>
        </div>
        {state === "loading" && <p className="text-sm" style={{ color: COLORS.muted }}>Confirming…</p>}
        {state === "done" && (
          <>
            <CheckCircle2 size={32} color={COLORS.teal} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: COLORS.text }}>Thanks — {displayId}'s {channel} escalation is marked seen.</p>
            <p className="text-xs mt-1" style={{ color: COLORS.muted }}>You can close this page.</p>
          </>
        )}
        {state === "error" && (
          <>
            <AlertCircle size={32} color={COLORS.red} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: COLORS.text }}>{error}</p>
            <p className="text-xs mt-1" style={{ color: COLORS.muted }}>This link may have already been used.</p>
          </>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from "react";
import { Anchor, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
};

// The whole point of this page: someone gets an escalation email at 2am,
// taps the link on their phone, and it's acknowledged — no app to open, no
// password to remember. This is the free alternative to PagerDuty's push
// notification acknowledge button.
export default function AckPage({ token }) {
  const [state, setState] = useState("loading"); // loading | done | error
  const [displayId, setDisplayId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("acknowledge_via_token", { token_value: token });
      if (error) { setError(error.message); setState("error"); return; }
      setDisplayId(data);
      setState("done");
    })();
  }, [token]);

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="flex items-center justify-center p-4">
      <div className="w-full max-w-sm p-6 rounded-xl text-center" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-center gap-2 mb-4">
          <Anchor size={18} color={COLORS.amber} />
          <span className="text-base font-semibold" style={{ color: COLORS.text }}>Acknowledging incident</span>
        </div>
        {state === "loading" && <p className="text-sm" style={{ color: COLORS.muted }}>Acknowledging…</p>}
        {state === "done" && (
          <>
            <CheckCircle2 size={32} color={COLORS.teal} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: COLORS.text }}>{displayId} acknowledged.</p>
            <p className="text-xs mt-1" style={{ color: COLORS.muted }}>You can close this page.</p>
          </>
        )}
        {state === "error" && (
          <>
            <AlertCircle size={32} color={COLORS.red} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: COLORS.text }}>{error}</p>
            <p className="text-xs mt-1" style={{ color: COLORS.muted }}>This link may have already been used, or someone else already acknowledged it.</p>
          </>
        )}
      </div>
    </div>
  );
}

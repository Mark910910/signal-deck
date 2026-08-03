import React, { useState, useEffect } from "react";
import { Anchor, Send, CheckCircle2 } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
};

// This page is deliberately the ONLY part of the app an unauthenticated
// visitor ever sees data from. It never imports anything that could show
// another organisation's incidents, and it never asks for or stores a name,
// email, or phone number — it only ever calls the narrow RPCs the database
// exposes to the public: portal_categories and submit_via_portal.
export default function PortalPage({ slug }) {
  const [categories, setCategories] = useState([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(null); // { display_id, track_token }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("portal_categories", { slug });
      if (error) { setError("This link doesn't look right — please check it with whoever gave it to you."); return; }
      setCategories(data || []);
      if (data?.[0]) setCategory(data[0].name);
    })();
  }, [slug]);

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true); setError("");
    const { data, error } = await supabase.rpc("submit_via_portal", {
      slug, incident_title: title, incident_notes: notes, category_name: category,
    });
    setSubmitting(false);
    if (error) { setError("Something went wrong submitting this — please try again."); return; }
    const row = Array.isArray(data) ? data[0] : data;
    setConfirmed(row);
  }

  const trackLink = confirmed ? `${window.location.origin}/track/${confirmed.track_token}` : "";
  function copyLink() {
    navigator.clipboard?.writeText(trackLink);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  if (confirmed) {
    return (
      <Centered>
        <div className="w-full max-w-sm p-6 rounded-xl text-center" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          <CheckCircle2 size={32} color={COLORS.teal} className="mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-2" style={{ color: COLORS.text }}>Thanks — it's logged</h1>
          <p className="text-sm mb-1" style={{ color: COLORS.muted }}>Reference number:</p>
          <p className="text-base font-mono mb-4" style={{ color: COLORS.amber }}>{confirmed.display_id}</p>
          <div className="p-2.5 rounded-lg mb-3" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
            <p className="text-xs mb-2" style={{ color: COLORS.muted }}>Save this link to check for updates or add a message — it's the only way back in, there's no account or password.</p>
            <div className="flex items-center gap-2">
              <input readOnly value={trackLink} className="flex-1 px-2 py-1.5 rounded text-xs" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
              <button onClick={copyLink} className="px-2.5 py-1.5 rounded text-xs font-medium" style={{ background: COLORS.amber, color: "#1A1200" }}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
          <p className="text-xs" style={{ color: COLORS.muted }}>The support team has been notified.</p>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-sm p-6 rounded-xl" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-4">
          <Anchor size={18} color={COLORS.amber} />
          <span className="text-base font-semibold" style={{ color: COLORS.text }}>Report an issue</span>
        </div>
        <p className="text-xs mb-4" style={{ color: COLORS.muted }}>No account needed. Please don't include your name, ID number, or contact details in the description below — just describe the problem.</p>

        <label className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>What's wrong?</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" className="w-full mb-3 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />

        <label className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Details (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full mb-3 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />

        <label className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full mb-4 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }}>
          {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>

        {error && <p className="text-xs mb-3" style={{ color: COLORS.red }}>{error}</p>}

        <button onClick={submit} disabled={submitting || !title.trim()} className="w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2" style={{ background: COLORS.amber, color: "#1A1200" }}>
          <Send size={14} /> {submitting ? "Submitting…" : "Submit"}
        </button>
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

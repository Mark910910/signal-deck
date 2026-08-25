import React, { useState, useEffect, useRef } from "react";
import { Anchor, Send, CheckCircle2, ThumbsUp, ThumbsDown } from "lucide-react";
import { supabase } from "./supabaseClient.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", text: "#E8ECF3", muted: "#8B96AB",
};

// This page is deliberately the ONLY part of the app an unauthenticated
// visitor ever sees data from. It never imports anything that could show
// another organisation's incidents, and it never asks for or stores a name,
// email, or phone number — it only ever calls the narrow RPCs the database
// exposes to the public: portal_categories, submit_via_portal,
// search_kb_articles, and log_kb_feedback.
//
// Deflection lives here, not on a separate help page — research found
// disconnected knowledge bases are "a repository," not deflection. As
// the customer types, relevant articles surface automatically. The
// Submit button stays visible and available throughout — self-service
// that fails should never trap someone with no way to actually get help.
export default function PortalPage({ slug }) {
  const [categories, setCategories] = useState([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(null);
  const [copied, setCopied] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [feedbackGiven, setFeedbackGiven] = useState({});
  const [terminology, setTerminology] = useState({});
  // Maps article id -> title, not just a Set of ids — later searches
  // replace `suggestions` entirely, so by the time someone actually
  // submits, an article shown a minute ago (on an earlier, since-refined
  // query) would otherwise have no title left to remember it by.
  const shownRef = useRef(new Map());

  useEffect(() => {
    (async () => {
      const [catRes, termRes] = await Promise.all([
        supabase.rpc("portal_categories", { slug }),
        supabase.rpc("portal_org_terminology", { slug }),
      ]);
      if (catRes.error) { setError("This link doesn't look right — please check it with whoever gave it to you."); return; }
      setCategories(catRes.data || []);
      setTerminology(termRes.data || {});
      // Previously auto-selected data[0].name — whatever sorted first
      // alphabetically got silently chosen for the customer, with no
      // indication a choice had even been made and no guidance on what any
      // category meant. Left blank now: category stays unset until someone
      // actively picks one, same as a required <select> with no default.
    })();
  }, [slug]);

  // Debounced search-as-you-type — waits for a pause in typing rather
  // than firing on every keystroke. Lowered from 4 to 2 characters so short
  // real-world queries ("VPN", "POS", "Wi-Fi") still get suggestions.
  useEffect(() => {
    if (!title.trim() || title.trim().length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      const { data } = await supabase.rpc("search_kb_articles", { slug, search_query: title });
      setSuggestions(data || []);
      // "Shown" is recorded here, separately from log_kb_feedback — the
      // real deflection success case is a customer reading this and simply
      // not submitting, which a feedback-click-only count could never see.
      // shownRef guards against re-counting the same article on every
      // keystroke while it stays in the results.
      (data || []).forEach((s) => {
        if (!shownRef.current.has(s.id)) {
          shownRef.current.set(s.id, s.title);
          supabase.rpc("record_kb_shown", { article_id: s.id });
        }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [title, slug]);

  async function giveFeedback(articleId, helpful) {
    await supabase.rpc("log_kb_feedback", { article_id: articleId, was_helpful: helpful });
    // Track which way they voted, not just that they voted — a 👍 should
    // read as case-closed ("Glad that helped!"), not the same "still need
    // help? submit below" copy that assumes the opposite.
    setFeedbackGiven((prev) => ({ ...prev, [articleId]: helpful ? "up" : "down" }));
  }

  async function submit() {
    if (!title.trim() || !category) return;
    setSubmitting(true); setError("");
    // Passive, staff-only context — the customer does nothing differently
    // and sees nothing new. Only articles that DIDN'T get a thumbs-up carry
    // forward (an article marked helpful isn't useful context for an agent —
    // the deflection worked, nothing to flag). This is what lets an agent
    // avoid re-suggesting the exact article the customer already read and
    // rejected minutes ago, using data record_kb_shown/log_kb_feedback
    // already capture and previously only ever rolled up into an org-wide
    // aggregate, never carried into the specific incident it resulted in.
    const shownArticles = Array.from(shownRef.current.entries())
      .filter(([id]) => feedbackGiven[id] !== "up")
      .map(([id, articleTitle]) => ({ title: articleTitle, was_helpful: feedbackGiven[id] === "down" ? false : null }));
    const { data, error } = await supabase.rpc("submit_via_portal", {
      slug, incident_title: title, incident_notes: notes, category_name: category, shown_articles: shownArticles,
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

  // The org's own vocabulary, not a hardcoded "issue" — was silently
  // generic for every template (an HR "Case" or a vendor "Vendor Issue"
  // saw the exact same copy an IT org does), while the category dropdown
  // one field below already got this right. Fallback matches what every
  // untemplated org already saw, so nothing changes for them.
  const term = terminology.incident || "issue";
  const article = /^[aeiou]/i.test(term) ? "an" : "a";
  // Customer-facing display only — the real INC-prefixed identifier is a
  // documented, stable API contract elsewhere and isn't touched here.
  const displayNum = (confirmed?.display_id || "").replace(/^[A-Za-z]+-/, "");

  if (confirmed) {
    return (
      <Centered>
        <div className="w-full max-w-sm p-6 rounded-xl text-center" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          <CheckCircle2 size={32} color={COLORS.teal} className="mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-2" style={{ color: COLORS.text }}>Thanks — it's logged</h1>
          <p className="text-sm mb-1" style={{ color: COLORS.muted }}>Reference number:</p>
          <p className="text-base font-mono mb-4" style={{ color: COLORS.amber }}>{term} #{displayNum}</p>
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
          <span className="text-base font-semibold" style={{ color: COLORS.text }}>Report {article} {term.toLowerCase()}</span>
        </div>
        <p className="text-xs mb-4" style={{ color: COLORS.muted }}>No account needed. Please don't include your name, ID number, or contact details in the description below — just describe the problem.</p>

        <label htmlFor="portal-title" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>What's wrong?</label>
        <input id="portal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" className="w-full mb-2 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />

        {suggestions.length > 0 && (
          <div className="mb-3 space-y-2">
            <p className="text-[11px]" style={{ color: COLORS.teal }}>This might already answer it:</p>
            {suggestions.map((s) => (
              <div key={s.id} className="p-2.5 rounded-lg" style={{ background: COLORS.bg, border: `1px solid ${COLORS.teal}44` }}>
                <div className="text-sm font-medium mb-1" style={{ color: COLORS.text }}>{s.title}</div>
                <p className="text-xs mb-2" style={{ color: COLORS.muted }}>{s.body}</p>
                {!feedbackGiven[s.id] ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px]" style={{ color: COLORS.muted }}>Did this help?</span>
                    <button onClick={() => giveFeedback(s.id, true)} className="p-1 rounded" style={{ background: COLORS.surfaceHi }}><ThumbsUp size={12} color={COLORS.teal} /></button>
                    <button onClick={() => giveFeedback(s.id, false)} className="p-1 rounded" style={{ background: COLORS.surfaceHi }}><ThumbsDown size={12} color={COLORS.muted} /></button>
                  </div>
                ) : feedbackGiven[s.id] === "up" ? (
                  <p className="text-[11px]" style={{ color: COLORS.teal }}>Glad that helped!</p>
                ) : (
                  <p className="text-[11px]" style={{ color: COLORS.teal }}>Thanks — still need help? Just submit below.</p>
                )}
              </div>
            ))}
          </div>
        )}

        <label htmlFor="portal-notes" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Details (optional)</label>
        <textarea id="portal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full mb-3 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />

        <label htmlFor="portal-category" className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>Category</label>
        {/* No default selection — previously silently defaulted to
            categories[0], whatever sorted first alphabetically, with no
            indication a choice had been made for the customer. Now it
            requires an explicit pick, same as any other required field. */}
        <select id="portal-category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full mb-4 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: category ? COLORS.text : COLORS.muted }}>
          <option value="">Choose a category…</option>
          {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>

        {error && <p className="text-xs mb-3" style={{ color: COLORS.red }}>{error}</p>}

        {/* Always visible, never gated behind trying self-service first —
            the research is explicit that trapping someone here is worse
            than not offering self-service at all. */}
        <button onClick={submit} disabled={submitting || !title.trim() || !category} className="w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2" style={{ background: COLORS.amber, color: "#1A1200" }}>
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

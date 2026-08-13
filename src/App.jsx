import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AlertTriangle, Clock, CheckCircle2, Radio, Search, Settings as SettingsIcon,
  Plus, ArrowLeft, Shield, ShieldCheck, Sparkles, Send, Bot, Zap, Users,
  Trash2, RefreshCw, Copy, Check, Download, UserX, ScanEye, LogOut, Anchor, Link2, Activity, Key, Webhook, TrendingUp, BarChart3, GripVertical, Bell, MessageSquare, Lock, Filter, X, Layers, Server, Truck, ChevronUp, ChevronDown
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from "recharts";
import { supabase } from "./supabaseClient.js";
import { redactPII } from "./lib/redact.js";
import { askAI } from "./lib/ai.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E", blue: "#6C8CFF",
  text: "#E8ECF3", muted: "#8B96AB", faint: "#5B6580",
};
const SEV_COLOR = { Critical: COLORS.red, High: COLORS.amber, Medium: COLORS.teal, Low: COLORS.blue };

function fmtClock(ms) {
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
// Existing orgs have no template_id (onboarding was never touched by the
// template system) — default to everything enabled, exactly current
// behavior, unless explicitly turned off. Template-assigned orgs get the
// template's defaults, further overridable either way.
function isModuleEnabled(org, moduleKey) {
  if (!org) return true;
  // null means "no gating applies at all" (Deck, Incidents, Log Incident,
  // Preventatives, Dashboards, Diagnostics, Privacy, Settings) — this has
  // to be checked before anything else, or it falls through to asking
  // whether the literal value null appears in a template's module list,
  // which it never does, hiding every core screen for any org with a
  // template assigned. Found live: the vendor template hid Log Incident
  // entirely, since that's exactly this bug.
  if (moduleKey === null) return true;
  const override = org.module_overrides?.[moduleKey];
  if (override === true) return true;
  if (override === false) return false;
  if (!org.template_id) return true;
  return (org.business_templates?.enabled_modules || []).includes(moduleKey);
}

// Org's own terminology choice always wins over the template's default —
// same layering as effective_terminology() in migration 30, computed
// client-side so the UI never needs a round trip to see it applied.
function getTerm(org, key, fallback) {
  if (!org) return fallback;
  const templateTerm = org.business_templates?.terminology?.[key];
  const orgTerm = org.terminology_overrides?.[key];
  return orgTerm || templateTerm || fallback;
}

// Incident Detail's optional panels and section defaults, admin-
// configurable per organisation — same lightweight JSON-preference
// pattern as isModuleEnabled, safe empty-object default if never set.
function isPanelHidden(org, panelKey) {
  return !!org?.incident_layout?.hiddenPanels?.includes(panelKey);
}
function sectionDefaultOpen(org, sectionKey, fallback) {
  const stored = org?.incident_layout?.sectionsOpen?.[sectionKey];
  return stored === undefined ? fallback : stored;
}

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/* =============================== ROOT APP ================================= */
export default function App({ inviteCode }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out
  const [org, setOrg] = useState(null); // { id, name, language, retention_days, identity_module_enabled, ... }
  const [checkingOrg, setCheckingOrg] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadOrg = useCallback(async () => {
    setCheckingOrg(true);
    const { data: member } = await supabase.from("org_members").select("org_id, role, resolver_group_id, user_id").maybeSingle();
    if (member) {
      const { data: orgRow } = await supabase.from("organisations").select("*, business_templates(key, name, enabled_modules, terminology)").eq("id", member.org_id).maybeSingle();
      setOrg(orgRow ? { ...orgRow, myRole: member.role, myResolverGroupId: member.resolver_group_id, myUserId: member.user_id } : null);
    } else {
      setOrg(null);
    }
    setCheckingOrg(false);
  }, []);

  useEffect(() => {
    if (session) loadOrg();
    else { setOrg(null); setCheckingOrg(false); }
  }, [session, loadOrg]);

  if (session === undefined || (session && checkingOrg)) {
    return <Centered><Anchor className="animate-spin" size={28} color={COLORS.amber} /></Centered>;
  }
  if (!session) return <AuthScreen inviteCode={inviteCode} />;
  if (!org) {
    return inviteCode
      ? <JoinScreen inviteCode={inviteCode} onJoined={loadOrg} />
      : <OnboardingScreen onCreated={loadOrg} />;
  }
  return <MainApp org={org} onOrgUpdated={setOrg} />;
}

function Centered({ children }) {
  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh" }} className="flex items-center justify-center">
      {children}
    </div>
  );
}

/* ============================== AUTH SCREEN ================================ */
function AuthScreen({ inviteCode }) {
  const [mode, setMode] = useState(inviteCode ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [invitePreview, setInvitePreview] = useState(null);

  useEffect(() => {
    if (!inviteCode) return;
    supabase.rpc("preview_invite", { invite_code: inviteCode }).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] : data;
      setInvitePreview(row || { valid: false });
    });
  }, [inviteCode]);

  async function submit() {
    setError(""); setLoading(true);
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else setSent(true);
    }
    setLoading(false);
  }

  return (
    <Centered>
      <div className="w-full max-w-sm p-6 rounded-xl" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-5">
          <Anchor size={20} color={COLORS.amber} />
          <span className="sd-display text-lg font-semibold" style={{ color: COLORS.text }}>Signal Deck</span>
        </div>
        {inviteCode && invitePreview && (
          <div className="mb-4 p-2.5 rounded-lg text-xs" style={{ background: invitePreview.valid ? COLORS.teal + "18" : COLORS.red + "18", border: `1px solid ${invitePreview.valid ? COLORS.teal : COLORS.red}44`, color: invitePreview.valid ? COLORS.teal : COLORS.red }}>
            {invitePreview.valid ? `You're joining ${invitePreview.org_name} as ${invitePreview.role}. Sign up below to accept.` : "This invite link is invalid or has expired."}
          </div>
        )}
        {sent ? (
          <p className="text-sm" style={{ color: COLORS.muted }}>Check your email to confirm your account, then come back and sign in.</p>
        ) : (
          <>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Work email" className="sd-in mb-2" />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" className="sd-in mb-3" />
            {error && <p className="text-xs mb-2" style={{ color: COLORS.red }}>{error}</p>}
            <button onClick={submit} disabled={loading || !email || !password} className="w-full py-2.5 rounded-lg font-semibold text-sm mb-3" style={{ background: COLORS.amber, color: "#1A1200" }}>
              {loading ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
            <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="w-full text-xs" style={{ color: COLORS.muted }}>
              {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
            </button>
          </>
        )}
        <style>{`.sd-in { width: 100%; background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 9px 11px; font-size: 13px; color: ${COLORS.text}; }`}</style>
      </div>
    </Centered>
  );
}

/* ============================ ONBOARDING SCREEN ============================ */
function OnboardingScreen({ onCreated }) {
  const [orgName, setOrgName] = useState("");
  const [language, setLanguage] = useState("en");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState([]);
  const [templateKey, setTemplateKey] = useState("it_full");

  // If this fetch fails for any reason, templateKey simply stays at its
  // default "it_full" — onboarding is never blocked by this, and the RPC
  // itself has the same fallback built in as a second safety net.
  useEffect(() => {
    supabase.from("business_templates").select("key, name, description").order("sort_order")
      .then(({ data }) => { if (data?.length) setTemplates(data); });
  }, []);

  async function create() {
    if (!orgName.trim()) return;
    setLoading(true); setError("");
    const { error } = await supabase.rpc("create_organisation_and_owner", { org_name: orgName, org_language: language, template_key: templateKey });
    if (error) setError(error.message);
    else await onCreated();
    setLoading(false);
  }

  return (
    <Centered>
      <div className="w-full max-w-sm p-6 rounded-xl" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <h1 className="sd-display text-lg font-semibold mb-1" style={{ color: COLORS.text }}>Set up your organisation</h1>
        <p className="text-xs mb-4" style={{ color: COLORS.muted }}>This creates your workspace with sensible defaults already in place — resolver groups, categories, statuses, and SLA timers you can change anytime in Settings.</p>
        <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Organisation name" className="sd-in mb-2" />
        <select value={language} onChange={(e) => setLanguage(e.target.value)} className="sd-in mb-3">
          <option value="en">English</option>
          <option value="zu">isiZulu</option>
          <option value="af">Afrikaans</option>
        </select>
        {templates.length > 0 && (
          <div className="mb-3">
            <label className="text-[11px] font-medium block mb-1.5" style={{ color: COLORS.muted }}>What kind of team is this for?</label>
            <div className="space-y-1.5">
              {templates.map((t) => (
                <button key={t.key} type="button" onClick={() => setTemplateKey(t.key)}
                  className="w-full text-left p-2 rounded-lg text-xs"
                  style={{ background: templateKey === t.key ? COLORS.amber + "18" : COLORS.surfaceHi, border: `1px solid ${templateKey === t.key ? COLORS.amber + "66" : COLORS.border}` }}>
                  <div style={{ color: templateKey === t.key ? COLORS.amber : COLORS.text, fontWeight: 500 }}>{t.name}</div>
                  {t.description && <div className="mt-0.5" style={{ color: COLORS.faint }}>{t.description}</div>}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-xs mb-2" style={{ color: COLORS.red }}>{error}</p>}
        <button onClick={create} disabled={loading || !orgName.trim()} className="w-full py-2.5 rounded-lg font-semibold text-sm" style={{ background: COLORS.amber, color: "#1A1200" }}>
          {loading ? "Setting up…" : "Create workspace"}
        </button>
        <button onClick={() => supabase.auth.signOut()} className="w-full text-xs mt-3" style={{ color: COLORS.muted }}>
          Not you, or landed here by mistake? Sign out
        </button>
        <style>{`.sd-in { width: 100%; background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 9px 11px; font-size: 13px; color: ${COLORS.text}; }`}</style>
      </div>
    </Centered>
  );
}

/* ============================== JOIN SCREEN (via invite) =================== */
// This is what actually closes the gap: a signed-up person with no org yet,
// arriving via an invite link, joins the org that invited them instead of
// accidentally creating a brand new one of their own.
function JoinScreen({ inviteCode, onJoined }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.rpc("preview_invite", { invite_code: inviteCode }).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] : data;
      setPreview(row || { valid: false });
    });
  }, [inviteCode]);

  async function join() {
    setLoading(true); setError("");
    const { error } = await supabase.rpc("join_via_invite", { invite_code: inviteCode });
    if (error) { setError(error.message); setLoading(false); return; }
    await onJoined();
  }

  return (
    <Centered>
      <div className="w-full max-w-sm p-6 rounded-xl text-center" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <Anchor size={20} color={COLORS.amber} className="mx-auto mb-3" />
        {!preview ? (
          <p className="text-sm" style={{ color: COLORS.muted }}>Checking invite…</p>
        ) : !preview.valid ? (
          <>
            <p className="text-sm mb-3" style={{ color: COLORS.red }}>This invite link is invalid or has expired. Ask whoever sent it for a new one.</p>
            <button onClick={() => supabase.auth.signOut()} className="w-full text-xs" style={{ color: COLORS.muted }}>Sign out</button>
          </>
        ) : (
          <>
            <h1 className="sd-display text-lg font-semibold mb-2" style={{ color: COLORS.text }}>Join {preview.org_name}</h1>
            <p className="text-sm mb-4" style={{ color: COLORS.muted }}>You'll join as {preview.role}.</p>
            {error && <p className="text-xs mb-3" style={{ color: COLORS.red }}>{error}</p>}
            <button onClick={join} disabled={loading} className="w-full py-2.5 rounded-lg font-semibold text-sm" style={{ background: COLORS.amber, color: "#1A1200" }}>
              {loading ? "Joining…" : "Join"}
            </button>
            <button onClick={() => supabase.auth.signOut()} className="w-full text-xs mt-3" style={{ color: COLORS.muted }}>Not you? Sign out</button>
          </>
        )}
      </div>
    </Centered>
  );
}

/* ================================ MAIN APP ================================= */
const NAV = [
  { key: "deck", label: "Deck", icon: Radio, module: null },
  { key: "incidents", label: "Incidents", icon: AlertTriangle, module: null, termKey: "incidents" },
  { key: "new", label: "Log Incident", icon: Plus, module: null, termKey: "incident" },
  { key: "problems", label: "Problems", icon: Layers, module: "problems" },
  { key: "assets", label: "Assets", icon: Server, module: "cmdb" },
  { key: "vendors", label: "Vendors", icon: Truck, module: "vendors" },
  { key: "preventatives", label: "Preventatives", icon: ShieldCheck, module: null },
  { key: "dashboards", label: "Dashboards", icon: BarChart3, module: null },
  { key: "diagnostics", label: "Diagnostics", icon: Activity, module: null },
  { key: "privacy", label: "Privacy", icon: Shield, module: null },
  { key: "settings", label: "Settings", icon: SettingsIcon, module: null },
];

// Deliberately just visibility, never enforcement — there's no payment
// processor integrated yet, so hard-locking access with nothing to
// actually pay their way back into would be a dead end, not a real
// upgrade path. Existing organisations (created before trial tracking
// existed) have trial_ends_at = null and correctly see nothing at all,
// not a false "expired" state. Only shown to owner/admin, since they're
// the ones who'd actually act on it.
function TrialBanner({ org }) {
  if (!org.trial_ends_at) return null;
  if (org.myRole !== "owner" && org.myRole !== "admin") return null;

  const daysLeft = Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / 86400000);
  if (daysLeft > 7) return null; // Quiet until it's actually approaching — no need to nag for three weeks straight.

  const expired = daysLeft <= 0;
  return (
    <div className="text-center py-1.5 text-xs" style={{ background: expired ? COLORS.red + "22" : COLORS.amber + "18", color: expired ? COLORS.red : COLORS.amber }}>
      {expired ? "Your trial has ended — contact us to keep using Signal Deck." : `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left in your trial.`}
    </div>
  );
}

function MainApp({ org, onOrgUpdated }) {
  const [tab, setTab] = useState("deck");
  const [lookups, setLookups] = useState(null); // resolver_groups, categories, statuses, severities, rca_categories
  const [incidents, setIncidents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [incidentListInit, setIncidentListInit] = useState(null);
  const [openProblemId, setOpenProblemId] = useState(null);
  const [toast, setToast] = useState(null);
  const [tick, setTick] = useState(0);
  const [ambientFlag, setAmbientFlag] = useState(null); // { type, incidentId, title, displayId }
  const seenFlagsRef = useRef({ breaching: new Set(), stale: new Set() });

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 3200); };

  const loadLookups = useCallback(async () => {
    const [rg, cat, st, sv, rca, cf, sc, cit, slap] = await Promise.all([
      supabase.from("resolver_groups").select("*").order("name"),
      supabase.from("categories").select("*").order("name"),
      supabase.from("statuses").select("*").order("sort_order"),
      supabase.from("severities").select("*"),
      supabase.from("rca_categories").select("*").order("sort_order"),
      supabase.from("custom_fields").select("*").order("sort_order"),
      supabase.from("service_catalog_items").select("*").eq("active", true).order("name"),
      supabase.from("ci_types").select("*").order("sort_order"),
      supabase.from("sla_policies").select("*"),
    ]);
    setLookups({
      resolverGroups: rg.data || [], categories: cat.data || [], statuses: st.data || [],
      severities: sv.data || [], rcaCategories: rca.data || [], customFields: cf.data || [], catalogItems: sc.data || [], ciTypes: cit.data || [],
      slaPolicies: slap.data || [],
    });
  }, []);

  const loadIncidents = useCallback(async () => {
    const { data, error } = await supabase
      .from("incidents")
      .select(`*, category:categories(id,name), severity:severities(id,name,sla_minutes,business_weight), status:statuses(id,name), rca_category:rca_categories(id,name),
                incident_assignments(*, resolver_groups(name, channel_slack_webhook, channel_teams_webhook)), incident_timeline(*), escalations(*), incident_identity(*), incident_custom_values(*),
                problem_incidents(problem_id, problems(display_id, title, status, workaround))`)
      .order("created_at", { ascending: false });
    if (!error) setIncidents(data || []);
  }, []);

  useEffect(() => { loadLookups(); loadIncidents(); }, [loadLookups, loadIncidents]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  // Genuinely time-based ambient detection needs incidents re-fetched
  // periodically, not just after a user action — an SLA breach can
  // happen purely because time passed, with nobody touching anything.
  useEffect(() => { const t = setInterval(() => loadIncidents(), 60000); return () => clearInterval(t); }, [loadIncidents]);

  // Option B, chosen over the header-badge alternative (Option A,
  // preserved in the session log if ever reconsidered): spontaneous,
  // cross-screen detection reusing the existing toast layer, which
  // already renders at this level regardless of which screen someone's
  // on. Detection itself is pure data comparison against SLABadge's own
  // logic — zero AI cost, zero reliability risk. AI stays one click away
  // once a flagged incident is actually opened, never firing on its own.
  useEffect(() => {
    if (!org?.id || incidents.length === 0 || ambientFlag) return;
    const now = Date.now();
    const currentBreaching = new Set();
    const currentStale = new Set();
    incidents.forEach((i) => {
      if (!i.resolved_at) {
        const deadline = new Date(i.created_at).getTime() + i.sla_minutes * 60000;
        if (now > deadline) currentBreaching.add(i.id);
        const lastActivity = (i.incident_timeline || []).reduce((max, t) => Math.max(max, new Date(t.ts).getTime()), new Date(i.created_at).getTime());
        if (now - lastActivity > 5 * 86400000) currentStale.add(i.id);
      }
    });

    const newlyBreaching = [...currentBreaching].find((id) => !seenFlagsRef.current.breaching.has(id));
    const newlyStale = !newlyBreaching ? [...currentStale].find((id) => !seenFlagsRef.current.stale.has(id)) : null;
    seenFlagsRef.current = { breaching: currentBreaching, stale: currentStale };

    const flagType = newlyBreaching ? "newly_breaching" : newlyStale ? "ready_to_close" : null;
    const flagId = newlyBreaching || newlyStale;
    if (!flagType) return;

    supabase.rpc("ambient_flag_should_fire", { target_org_id: org.id, target_flag_type: flagType }).then(({ data: shouldFire }) => {
      if (shouldFire === false) return;
      const incident = incidents.find((i) => i.id === flagId);
      if (incident) setAmbientFlag({ type: flagType, incidentId: flagId, title: incident.title, displayId: incident.display_id });
    });
  }, [incidents, org, ambientFlag]);

  async function recordFlagFeedback(action) {
    if (!ambientFlag) return;
    await supabase.from("ambient_flag_feedback").insert({
      org_id: org.id, flag_type: ambientFlag.type, incident_id: ambientFlag.incidentId, action,
    });
  }

  async function signOut() { await supabase.auth.signOut(); }

  if (!lookups) return <Centered><RefreshCw className="animate-spin" size={24} color={COLORS.amber} /></Centered>;

  const selected = incidents.find((i) => i.id === selectedId) || null;

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif", color: COLORS.text }}>
      <header className="sticky top-0 z-40" style={{ background: "rgba(10,17,32,0.95)", borderBottom: `1px solid ${COLORS.border}` }}>
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Anchor size={18} color={COLORS.amber} />
            <div>
              <div className="sd-display text-sm font-semibold">Signal Deck</div>
              <div className="text-[10px] sd-mono" style={{ color: COLORS.faint }}>{org.name}</div>
            </div>
          </div>
          <button onClick={signOut} className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.muted }}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </header>

      <TrialBanner org={org} />

      <div className="max-w-6xl mx-auto md:flex md:gap-6 px-3 md:px-4 pb-24 md:pb-10 pt-4">
        <nav className="hidden md:flex flex-col gap-1 w-52 shrink-0">
          {NAV.filter((item) => isModuleEnabled(org, item.module)).map((item) => {
            const Icon = item.icon; const active = tab === item.key;
            const label = item.termKey ? getTerm(org, item.termKey, item.label) : item.label;
            return (
              <button key={item.key} onClick={() => { setTab(item.key); setSelectedId(null); }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left"
                style={{ background: active ? COLORS.surfaceHi : "transparent", color: active ? COLORS.amber : COLORS.muted }}>
                <Icon size={16} /> {label}
              </button>
            );
          })}
        </nav>

        <main className="flex-1 min-w-0">
          {tab === "deck" && <Deck incidents={incidents} lookups={lookups} org={org} tick={tick} onOpen={(id) => { setSelectedId(id); setTab("incidents"); }}
            onNavigateIncidents={(init) => { setIncidentListInit(init); setTab("incidents"); }} />}
          {tab === "incidents" && !selected && <IncidentList incidents={incidents} lookups={lookups} org={org} tick={tick} onSelect={setSelectedId} initFilter={incidentListInit} onInitConsumed={() => setIncidentListInit(null)} />}
          {tab === "incidents" && selected && (
            <IncidentDetail incident={selected} incidents={incidents} lookups={lookups} org={org} tick={tick}
              onBack={() => setSelectedId(null)} onChanged={loadIncidents} showToast={showToast} />
          )}
          {tab === "new" && (
            <NewIncident lookups={lookups} org={org}
              onCreated={async () => { await loadIncidents(); setTab("incidents"); showToast("Incident logged"); }} />
          )}
          {tab === "diagnostics" && <Diagnostics org={org} lookups={lookups} />}
          {tab === "problems" && <ProblemsView org={org} lookups={lookups} incidents={incidents} showToast={showToast} onOpenIncident={(id) => { setSelectedId(id); setTab("incidents"); }} initialProblemId={openProblemId} onProblemOpened={() => setOpenProblemId(null)} />}
          {tab === "assets" && <AssetsView org={org} lookups={lookups} showToast={showToast} onOpenIncident={(id) => { setSelectedId(id); setTab("incidents"); }} />}
          {tab === "vendors" && <VendorsView org={org} showToast={showToast} onOpenIncident={(id) => { setSelectedId(id); setTab("incidents"); }} />}
          {tab === "preventatives" && <PreventativesTracker org={org} lookups={lookups} incidents={incidents} showToast={showToast} onOpenIncident={(id) => { setSelectedId(id); setTab("incidents"); }} onOpenProblem={(id) => { setOpenProblemId(id); setTab("problems"); }} />}
          {tab === "dashboards" && <CustomDashboards org={org} lookups={lookups} incidents={incidents} showToast={showToast} />}
          {tab === "privacy" && <PrivacyCenter org={org} onOrgUpdated={onOrgUpdated} incidents={incidents} showToast={showToast} />}
          {tab === "settings" && <Settings org={org} lookups={lookups} onOrgUpdated={onOrgUpdated} onLookupsChanged={loadLookups} showToast={showToast} />}
        </main>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden flex justify-start overflow-x-auto py-1.5 px-1" style={{ background: "rgba(10,17,32,0.97)", borderTop: `1px solid ${COLORS.border}` }}>
        {NAV.filter((item) => isModuleEnabled(org, item.module)).map((item) => {
          const Icon = item.icon; const active = tab === item.key;
          const label = item.termKey ? getTerm(org, item.termKey, item.label) : item.label;
          return (
            <button key={item.key} onClick={() => { setTab(item.key); setSelectedId(null); }} className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 shrink-0">
              <Icon size={18} color={active ? COLORS.amber : COLORS.faint} />
              <span className="text-[9px] font-medium whitespace-nowrap" style={{ color: active ? COLORS.amber : COLORS.faint }}>{label}</span>
            </button>
          );
        })}
      </nav>

      {toast && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-sm shadow-xl" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
          {toast}
        </div>
      )}

      {ambientFlag && (
        <AmbientFlagToast
          flag={ambientFlag}
          onView={async () => {
            await recordFlagFeedback("acted");
            setSelectedId(ambientFlag.incidentId); setTab("incidents"); setAmbientFlag(null);
          }}
          onDismiss={async () => { await recordFlagFeedback("dismissed"); setAmbientFlag(null); }}
        />
      )}
    </div>
  );
}

/* --------------------------------- shared bits --------------------------------- */
function SLABadge({ incident }) {
  const deadline = new Date(incident.created_at).getTime() + incident.sla_minutes * 60000 + (incident.sla_paused_minutes || 0) * 60000;
  const remaining = deadline - Date.now();
  const resolved = !!incident.resolved_at;
  const breached = resolved ? new Date(incident.resolved_at).getTime() > deadline : remaining < 0;
  let color = COLORS.teal;
  if (breached) color = COLORS.red;
  else if (!resolved && remaining < incident.sla_minutes * 60000 * 0.25) color = COLORS.amber;
  return (
    <div className="flex items-center gap-1.5 sd-mono text-[11px]" style={{ color }}>
      <Clock size={12} />
      {resolved ? (breached ? "Breached" : "Met SLA") : (breached ? `Overdue ${fmtDuration(-remaining)}` : fmtClock(remaining))}
    </div>
  );
}
function SeverityPill({ name }) {
  const c = SEV_COLOR[name] || COLORS.muted;
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full sd-mono uppercase" style={{ color: c, background: c + "22", border: `1px solid ${c}55` }}>{name}</span>;
}
function StatusPill({ name }) {
  return <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: COLORS.surfaceHi, color: COLORS.muted, border: `1px solid ${COLORS.border}` }}>{name}</span>;
}
function Panel({ title, icon: Icon, children }) {
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center gap-2 mb-3">{Icon && <Icon size={15} color={COLORS.amber} />}<h3 className="sd-display text-sm font-semibold">{title}</h3></div>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return <div className="mb-2.5"><label className="text-[11px] font-medium block mb-1" style={{ color: COLORS.muted }}>{label}</label>{children}</div>;
}

// The actual fix for Incident Detail's flat stack of up to 19 panels —
// groups by what someone is actually trying to do (work it, check
// activity, look up related things, files/approval), not by build order.
// "Work this incident" and "Activity" default open since those are the
// two things almost every visit is actually for; everything else starts
// collapsed, one click away instead of a permanent part of the scroll —
// and critically, a collapsed section doesn't reshuffle the visible
// layout just because a particular incident happens to have a vendor
// linked or custom fields filled in, unlike the old flat-panel approach
// where the page's shape changed incident to incident.
function CollapsibleSection({ title, icon: Icon, defaultOpen = false, forceOpen = false, badge, children }) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  return (
    <div className="rounded-xl mb-4 overflow-hidden" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between p-4">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} color={COLORS.amber} />}
          <h3 className="sd-display text-sm font-semibold" style={{ color: COLORS.text }}>{title}</h3>
          {badge != null && badge > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: COLORS.amber + "22", color: COLORS.amber }}>{badge}</span>
          )}
        </div>
        {open ? <ChevronUp size={16} color={COLORS.faint} /> : <ChevronDown size={16} color={COLORS.faint} />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/* ================================== DECK =================================== */
function Deck({ incidents, lookups, org, tick, onOpen, onNavigateIncidents }) {
  // Business Impact SLA: surface the highest revenue-risk open incidents
  // first, not just whatever was logged most recently.
  const open = incidents.filter((i) => !i.resolved_at)
    .sort((a, b) => (b.severity?.business_weight || 0) - (a.severity?.business_weight || 0));
  const breached = open.filter((i) => new Date(i.created_at).getTime() + i.sla_minutes * 60000 < Date.now());
  const resolvedToday = incidents.filter((i) => {
    if (!i.resolved_at) return false;
    const d = new Date(i.resolved_at); const t = new Date();
    return d.toDateString() === t.toDateString();
  });

  const rcaData = useMemo(() => {
    const counts = {};
    incidents.forEach((i) => { const n = i.rca_category?.name; if (n) counts[n] = (counts[n] || 0) + 1; });
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  }, [incidents]);

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Open" value={open.length} color={COLORS.blue}
          onClick={() => onNavigateIncidents({ filter: "open", quickFilter: null })} />
        <StatCard icon={Zap} label="Breached" value={breached.length} color={COLORS.red}
          onClick={() => onNavigateIncidents({ filter: "open", quickFilter: "overdue" })} />
        <StatCard icon={CheckCircle2} label="Resolved Today" value={resolvedToday.length} color={COLORS.teal}
          onClick={() => onNavigateIncidents({ filter: "resolved", quickFilter: null })} />
      </div>
      <Panel title="Root cause breakdown" icon={ScanEye}>
        {rcaData.length === 0 ? <p className="text-sm" style={{ color: COLORS.muted }}>No resolved incidents categorised yet.</p> : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={rcaData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={{ stroke: COLORS.border }} />
              <YAxis tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={false} />
              <Tooltip contentStyle={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, borderRadius: 8 }} />
              <Bar dataKey="count" fill={COLORS.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>
      <Panel title={`Open ${getTerm(org, "incidents", "incidents").toLowerCase()}`} icon={Radio}>
        <div className="divide-y" style={{ borderColor: COLORS.border }}>
          {open.slice(0, 8).map((inc) => (
            <button key={inc.id} onClick={() => onOpen(inc.id)} className="w-full flex items-center justify-between gap-3 py-2.5 text-left">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="sd-mono text-[11px]" style={{ color: COLORS.faint }}>{inc.display_id}</span>
                  <SeverityPill name={inc.severity?.name} />
                </div>
                <div className="text-sm truncate">{inc.title}</div>
              </div>
              <SLABadge incident={inc} />
            </button>
          ))}
          {open.length === 0 && <p className="py-6 text-center text-sm" style={{ color: COLORS.muted }}>All clear on deck.</p>}
        </div>
      </Panel>
    </div>
  );
}
function StatCard({ icon: Icon, label, value, color, onClick }) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper onClick={onClick} className="rounded-xl p-3.5 text-left w-full" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, cursor: onClick ? "pointer" : "default" }}>
      <Icon size={16} color={color} />
      <div className="sd-display text-2xl font-semibold mt-2">{value}</div>
      <div className="text-[11px]" style={{ color: COLORS.muted }}>{label}</div>
    </Wrapper>
  );
}

/* =============================== INCIDENT LIST ============================== */
// Field definitions for the condition builder — merges built-in incident
// fields with whatever custom fields this organisation has configured, so
// "include custom fields in queries" isn't a separate mode, it's just more
// entries in the same one list.
function buildFieldDefs(lookups) {
  const builtIn = [
    { key: "category", label: "Category", type: "select", options: lookups.categories.map((c) => c.name), get: (i) => i.category?.name },
    { key: "severity", label: "Severity", type: "select", options: lookups.severities.map((s) => s.name), get: (i) => i.severity?.name },
    { key: "status", label: "Status", type: "select", options: lookups.statuses.map((s) => s.name), get: (i) => i.status?.name },
    { key: "rca_category", label: "Root cause", type: "select", options: lookups.rcaCategories.map((r) => r.name), get: (i) => i.rca_category?.name },
    { key: "resolver_group", label: "Team", type: "select", options: lookups.resolverGroups.map((g) => g.name), get: (i) => (i.incident_assignments || []).map((a) => a.resolver_groups?.name).join(", ") },
    { key: "source", label: "Source", type: "select", options: ["agent", "chatbot", "portal", "api"], get: (i) => i.source },
    { key: "resolution_class", label: "Resolution", type: "select", options: ["Permanent Fix", "Temporary Fix", "Workaround", "Escalated (No Fix)"], get: (i) => i.resolution_class },
    { key: "record_type", label: "Type", type: "select", options: ["incident", "service_request"], get: (i) => i.record_type },
    { key: "approval_status", label: "Approval status", type: "select", options: ["not_required", "pending", "approved", "rejected"], get: (i) => i.approval_status },
    { key: "created_at", label: "Created", type: "date", get: (i) => i.created_at },
  ];
  const custom = (lookups.customFields || []).map((f) => ({
    key: `custom:${f.id}`, label: f.label, type: f.field_type === "select" ? "select" : f.field_type === "checkbox" ? "checkbox" : f.field_type,
    options: f.options || [],
    get: (i) => (i.incident_custom_values || []).find((v) => v.custom_field_id === f.id)?.value,
  }));
  return [...builtIn, ...custom];
}

function evaluateCondition(incident, condition, fieldDefs) {
  const def = fieldDefs.find((f) => f.key === condition.field);
  if (!def) return true;
  const actual = def.get(incident);

  if (def.type === "date") {
    if (!actual) return false;
    const days = { "7": 7, "30": 30, "90": 90 }[condition.value];
    if (condition.operator === "last_n_days") return new Date(actual).getTime() >= Date.now() - days * 86400000;
    return true;
  }
  if (def.type === "checkbox") {
    const isChecked = actual === "true";
    return condition.operator === "checked" ? isChecked : !isChecked;
  }
  if (def.type === "number") {
    const n = parseFloat(actual);
    const v = parseFloat(condition.value);
    if (isNaN(n)) return false;
    if (condition.operator === "eq") return n === v;
    if (condition.operator === "gt") return n > v;
    if (condition.operator === "lt") return n < v;
  }
  // text / select
  if (condition.operator === "is_empty") return !actual;
  if (!actual) return false;
  if (condition.operator === "is") return actual === condition.value;
  if (condition.operator === "is_not") return actual !== condition.value;
  if (condition.operator === "contains") return actual.toLowerCase().includes((condition.value || "").toLowerCase());
  return true;
}

function IncidentList({ incidents, lookups, org, tick, onSelect, initFilter, onInitConsumed }) {
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("all");
  // Defaults to the signed-in member's own team queue if they belong to
  // one — a smart default, not a hard wall. Anyone can switch to "All" in
  // one click. This is the direct fix for "no visibility into workload...
  // hard to see who's working on what" without recreating Jira/ServiceNow's
  // notification sprawl where everyone gets CC'd on everything regardless.
  const [scope, setScope] = useState(org?.myResolverGroupId ? "mine" : "all");
  const [quickFilter, setQuickFilter] = useState(null); // 'mine' | 'unassigned' | 'overdue' | null
  const [conditions, setConditions] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [savedViews, setSavedViews] = useState([]);
  const [viewName, setViewName] = useState("");

  // Arrived here from a Deck stat-card click (e.g. "Resolved Today") — this
  // is the direct fix for resolved incidents having no click-through path
  // back from the dashboard at all.
  useEffect(() => {
    if (initFilter) {
      setFilter(initFilter.filter);
      setQuickFilter(initFilter.quickFilter);
      onInitConsumed?.();
    }
  }, [initFilter, onInitConsumed]);

  const fieldDefs = useMemo(() => buildFieldDefs(lookups), [lookups]);

  const loadViews = useCallback(async () => {
    const { data } = await supabase.from("saved_views").select("*").order("created_at", { ascending: false });
    setSavedViews(data || []);
  }, []);
  useEffect(() => { loadViews(); }, [loadViews]);

  let list = incidents;
  if (filter === "open") list = list.filter((i) => !i.resolved_at);
  if (filter === "resolved") list = list.filter((i) => i.resolved_at);

  if (scope === "mine" && org?.myResolverGroupId) {
    list = list.filter((i) => (i.incident_assignments || []).some((a) => a.resolver_group_id === org.myResolverGroupId));
  }

  // Quick filters — the "based on role" cases covered with one click,
  // mirroring Jira's most popular JQL pattern (assignee = currentUser())
  // without needing to know any query syntax at all.
  if (quickFilter === "mine" && org?.myUserId) {
    list = list.filter((i) => (i.incident_assignments || []).some((a) => a.assigned_user_id === org.myUserId));
  }
  if (quickFilter === "unassigned") {
    list = list.filter((i) => !(i.incident_assignments || []).some((a) => a.assigned_user_id));
  }
  if (quickFilter === "overdue") {
    list = list.filter((i) => !i.resolved_at && new Date(i.created_at).getTime() + i.sla_minutes * 60000 < Date.now());
  }

  if (range !== "all") {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[range];
    const cutoff = Date.now() - days * 86400000;
    list = list.filter((i) => new Date(i.created_at).getTime() >= cutoff);
  }

  // Every condition is combined with AND only — deliberately. A decade of
  // ServiceNow forum threads (2014-2024) shows even experienced admins
  // getting tripped up by AND/OR precedence in their Condition Builder,
  // including a March 2026 "Known Error" where it silently drops what was
  // just filtered. Flat AND avoids that entire category of confusion.
  conditions.forEach((c) => { list = list.filter((i) => evaluateCondition(i, c, fieldDefs)); });

  // One search box searching everything a person would actually remember
  // about a past incident — title, notes, reference number, category,
  // severity, and root cause — rather than a multi-field query builder.
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    list = list.filter((i) =>
      i.title?.toLowerCase().includes(q) ||
      i.notes?.toLowerCase().includes(q) ||
      i.display_id?.toLowerCase().includes(q) ||
      i.category?.name?.toLowerCase().includes(q) ||
      i.severity?.name?.toLowerCase().includes(q) ||
      i.rca_category?.name?.toLowerCase().includes(q) ||
      i.resolution_class?.toLowerCase().includes(q) ||
      (i.incident_custom_values || []).some((v) => v.value?.toLowerCase().includes(q))
    );
  }

  function addCondition() {
    const first = fieldDefs[0];
    setConditions((prev) => [...prev, { field: first.key, operator: first.type === "date" ? "last_n_days" : "is", value: first.type === "date" ? "30" : (first.options?.[0] || "") }]);
  }
  function updateCondition(idx, patch) {
    setConditions((prev) => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  }
  function removeCondition(idx) {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function saveView() {
    if (!viewName.trim()) return;
    await supabase.from("saved_views").insert({ org_id: org.id, name: viewName, filter_json: { filter, scope, quickFilter, conditions } });
    setViewName("");
    await loadViews();
  }
  function applyView(v) {
    const f = v.filter_json;
    setFilter(f.filter ?? "open"); setScope(f.scope ?? "all"); setQuickFilter(f.quickFilter ?? null); setConditions(f.conditions ?? []);
  }
  async function deleteView(id) {
    await supabase.from("saved_views").delete().eq("id", id);
    await loadViews();
  }

  return (
    <div>
      <div className="relative mb-3">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" color={COLORS.faint} />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, notes, reference number, category, root cause…"
          className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
      </div>
      {org?.myResolverGroupId && (
        <div className="flex gap-1.5 mb-3">
          {[["mine", "My Group"], ["all", "All Groups"]].map(([val, label]) => (
            <button key={val} onClick={() => setScope(val)} className="px-3 py-1.5 rounded-full text-xs font-medium"
              style={{ background: scope === val ? COLORS.teal + "22" : COLORS.surface, color: scope === val ? COLORS.teal : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Quick filters — one click, no query-building knowledge needed at all */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {[["mine", "Assigned to me"], ["unassigned", "Unassigned"], ["overdue", "Overdue"]].map(([val, label]) => (
          <button key={val} onClick={() => setQuickFilter(quickFilter === val ? null : val)} className="px-3 py-1.5 rounded-full text-xs font-medium"
            style={{ background: quickFilter === val ? COLORS.amber + "22" : COLORS.surface, color: quickFilter === val ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
            {label}
          </button>
        ))}
        <button onClick={() => setShowBuilder((s) => !s)} className="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1"
          style={{ background: conditions.length ? COLORS.teal + "22" : COLORS.surface, color: conditions.length ? COLORS.teal : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
          <Filter size={12} /> {conditions.length ? `${conditions.length} filter${conditions.length > 1 ? "s" : ""}` : "More filters"}
        </button>
      </div>

      {savedViews.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {savedViews.map((v) => (
            <div key={v.id} className="flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.muted }}>
              <button onClick={() => applyView(v)}>{v.name}</button>
              <button onClick={() => deleteView(v.id)} className="p-0.5"><X size={11} color={COLORS.faint} /></button>
            </div>
          ))}
        </div>
      )}

      {showBuilder && (
        <div className="rounded-xl p-3 mb-3" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          <p className="text-[11px] mb-2" style={{ color: COLORS.faint }}>All conditions must match — no AND/OR mixing, so there's nothing to get wrong.</p>
          {conditions.map((c, idx) => {
            const def = fieldDefs.find((f) => f.key === c.field);
            return (
              <div key={idx} className="flex items-center gap-1.5 mb-2 flex-wrap">
                <select value={c.field} onChange={(e) => {
                  const nd = fieldDefs.find((f) => f.key === e.target.value);
                  updateCondition(idx, { field: e.target.value, operator: nd.type === "date" ? "last_n_days" : "is", value: nd.type === "date" ? "30" : (nd.options?.[0] || "") });
                }} className="sd-in6">
                  {fieldDefs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>

                {def?.type === "date" ? (
                  <>
                    <span className="text-xs" style={{ color: COLORS.faint }}>in the last</span>
                    <select value={c.value} onChange={(e) => updateCondition(idx, { value: e.target.value })} className="sd-in6" style={{ width: 90 }}>
                      <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
                    </select>
                  </>
                ) : def?.type === "checkbox" ? (
                  <select value={c.operator} onChange={(e) => updateCondition(idx, { operator: e.target.value })} className="sd-in6">
                    <option value="checked">is checked</option><option value="unchecked">is unchecked</option>
                  </select>
                ) : (
                  <>
                    <select value={c.operator} onChange={(e) => updateCondition(idx, { operator: e.target.value })} className="sd-in6" style={{ width: 100 }}>
                      <option value="is">is</option><option value="is_not">is not</option>
                      {def?.type === "text" && <option value="contains">contains</option>}
                      <option value="is_empty">is empty</option>
                    </select>
                    {c.operator !== "is_empty" && (
                      def?.options?.length > 0 ? (
                        <select value={c.value} onChange={(e) => updateCondition(idx, { value: e.target.value })} className="sd-in6">
                          {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input value={c.value} onChange={(e) => updateCondition(idx, { value: e.target.value })} className="sd-in6" style={{ width: 120 }} />
                      )
                    )}
                  </>
                )}
                <button onClick={() => removeCondition(idx)}><X size={13} color={COLORS.faint} /></button>
              </div>
            );
          })}
          <button onClick={addCondition} className="text-xs mb-3" style={{ color: COLORS.amber }}>+ Add condition</button>
          {conditions.length > 0 && (
            <div className="flex items-center gap-2 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
              <input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Save this as a view…" className="sd-in6 flex-1" />
              <button onClick={saveView} className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: COLORS.amber, color: "#1A1200" }}>Save</button>
            </div>
          )}
          <style>{`.sd-in6 { background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 6px 8px; font-size: 12px; color: ${COLORS.text}; }`}</style>
        </div>
      )}

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-1.5">
          {["open", "resolved", "all"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="px-3 py-1.5 rounded-full text-xs font-medium capitalize"
              style={{ background: filter === f ? COLORS.amber + "22" : COLORS.surface, color: filter === f ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {f}
            </button>
          ))}
        </div>
        <select value={range} onChange={(e) => setRange(e.target.value)} className="text-xs px-2.5 py-1.5 rounded-full"
          style={{ background: COLORS.surface, color: COLORS.muted, border: `1px solid ${COLORS.border}` }}>
          <option value="all">All time</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </select>
      </div>
      <div className="rounded-xl divide-y" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        {list.map((inc) => (
          <button key={inc.id} onClick={() => onSelect(inc.id)} className="w-full text-left p-3.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="sd-mono text-[11px]" style={{ color: COLORS.faint }}>{inc.display_id}</span>
                {inc.record_type === "service_request" && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: COLORS.blue, background: COLORS.blue + "22" }}>REQUEST</span>
                )}
                <SeverityPill name={inc.severity?.name} /><StatusPill name={inc.status?.name} />
                {inc.approval_status === "pending" && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: COLORS.amber, background: COLORS.amber + "22" }}>AWAITING APPROVAL</span>
                )}
              </div>
              <div className="text-sm font-medium truncate">{inc.title}</div>
              <div className="text-[11px] mt-0.5" style={{ color: COLORS.muted }}>{inc.category?.name} · via {inc.source}{inc.rca_category?.name ? ` · ${inc.rca_category.name}` : ""}</div>
            </div>
            <SLABadge incident={inc} />
          </button>
        ))}
        {list.length === 0 && <div className="p-8 text-center text-sm" style={{ color: COLORS.muted }}>No {getTerm(org, "incidents", "incidents").toLowerCase()} match.</div>}
      </div>
    </div>
  );
}

/* ============================== NEW INCIDENT ================================ */
function NewIncident({ lookups, org, onCreated }) {
  const [mode, setMode] = useState("form");
  return (
    <div>
      <div className="flex gap-1.5 mb-4">
        <button onClick={() => setMode("form")} className="px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: mode === "form" ? COLORS.amber + "22" : COLORS.surface, color: mode === "form" ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>Form</button>
        <button onClick={() => setMode("chat")} className="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1" style={{ background: mode === "chat" ? COLORS.amber + "22" : COLORS.surface, color: mode === "chat" ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}><Bot size={13} /> Assistant</button>
      </div>
      {mode === "form" ? <IncidentForm lookups={lookups} org={org} onCreated={onCreated} /> : <ChatIntake lookups={lookups} org={org} onCreated={onCreated} />}
    </div>
  );
}

async function insertIncident({ title, notes, categoryId, severityId, slaMinutes, resolverGroupIds, org, identity, customValues, recordType, requiresApproval }) {
  const prefix = recordType === "service_request" ? "REQ" : "INC";
  const displayId = `${prefix}-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const { data: statusRow } = await supabase.from("statuses").select("id").eq("org_id", org.id).order("sort_order").limit(1).maybeSingle();

  const { data: inc, error } = await supabase.from("incidents").insert({
    org_id: org.id, display_id: displayId, title: redactPII(title), notes: redactPII(notes),
    category_id: categoryId, severity_id: severityId, status_id: statusRow?.id, sla_minutes: slaMinutes,
    record_type: recordType || "incident", approval_status: requiresApproval ? "pending" : "not_required",
  }).select().single();
  if (error) throw error;

  const assignments = resolverGroupIds.map((gid, idx) => ({
    incident_id: inc.id, org_id: org.id, resolver_group_id: gid,
    mode: resolverGroupIds.length > 1 ? "parallel" : "parallel", sequence_order: idx, sla_minutes: slaMinutes,
  }));
  if (assignments.length) await supabase.from("incident_assignments").insert(assignments);

  await supabase.from("incident_timeline").insert({ incident_id: inc.id, org_id: org.id, status_id: statusRow?.id, note: "Incident logged" });

  if (identity && org.identity_module_enabled && (identity.customerName || identity.customerContact)) {
    await supabase.from("incident_identity").insert({
      incident_id: inc.id, org_id: org.id, customer_name: identity.customerName, customer_contact: identity.customerContact,
      consent_given: identity.consent, consent_ts: identity.consent ? new Date().toISOString() : null,
    });
  }

  if (customValues && Object.keys(customValues).length > 0) {
    const rows = Object.entries(customValues).filter(([, v]) => v !== "" && v != null).map(([fieldId, value]) => ({
      incident_id: inc.id, custom_field_id: fieldId, org_id: org.id,
      // Same redaction applied to every other free-text field in the app —
      // a custom field is not an exception to the metadata-safety rule.
      value: redactPII(String(value)),
    }));
    if (rows.length) await supabase.from("incident_custom_values").insert(rows);
  }

  return inc;
}

function IncidentForm({ lookups, org, onCreated }) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryId, setCategoryId] = useState(lookups.categories[0]?.id || "");
  const [severityId, setSeverityId] = useState(lookups.severities[0]?.id || "");
  const [resolverGroupIds, setResolverGroupIds] = useState(lookups.resolverGroups[0] ? [lookups.resolverGroups[0].id] : []);
  const [groupManuallySet, setGroupManuallySet] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warn, setWarn] = useState(false);
  const [customValues, setCustomValues] = useState({});
  const [recordType, setRecordType] = useState("incident");
  const [catalogItemId, setCatalogItemId] = useState("");
  const [vendors, setVendors] = useState([]);
  const [vendorId, setVendorId] = useState("");

  // Only fetched/shown for orgs that actually use Vendors — no point
  // cluttering the form for anyone who doesn't. This is the direct fix
  // for a real gap found live: there was no way to pick a vendor when
  // creating an incident at all, only afterward via a separate panel on
  // the detail page — a genuinely awkward two-step process for a business
  // whose primary workflow IS vendor issues (the Vendor template).
  useEffect(() => {
    if (!isModuleEnabled(org, "vendors")) return;
    supabase.from("vendors").select("id, name").eq("status", "active").order("name").then(({ data }) => setVendors(data || []));
  }, [org]);

  const hasContact = customerName.trim() || customerContact.trim();

  function applyCatalogItem(itemId) {
    setCatalogItemId(itemId);
    const item = (lookups.catalogItems || []).find((c) => c.id === itemId);
    if (item) {
      setTitle(item.name);
      if (item.category_id) setCategoryId(item.category_id);
      if (item.default_resolver_group_id) { setResolverGroupIds([item.default_resolver_group_id]); setGroupManuallySet(true); }
    }
  }

  // Routes to the category's configured default team automatically — this
  // field existed in the database since the schema was first built but was
  // never actually connected to anything until now. Stops the moment
  // someone manually changes the group themselves, so it never fights a
  // deliberate choice (the "assignment pinball" failure mode the research
  // specifically flagged in Jira automation setups).
  useEffect(() => {
    if (groupManuallySet) return;
    const cat = lookups.categories.find((c) => c.id === categoryId);
    if (cat?.default_resolver_group_id) {
      setResolverGroupIds([cat.default_resolver_group_id]);
    }
  }, [categoryId, groupManuallySet, lookups.categories]);

  function toggleGroup(id) {
    setGroupManuallySet(true);
    setResolverGroupIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function setCustomValue(fieldId, value) {
    setCustomValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  async function submit() {
    if (!title.trim() || !categoryId || !severityId) return;
    if (org.identity_module_enabled && hasContact && !consent) { setWarn(true); return; }
    const missingRequired = (lookups.customFields || []).find((f) => f.required && !customValues[f.id]);
    if (missingRequired) { setWarn(false); return; }
    setSaving(true);
    const sev = lookups.severities.find((s) => s.id === severityId);
    try {
      const catalogItem = (lookups.catalogItems || []).find((c) => c.id === catalogItemId);
      const inc = await insertIncident({
        title, notes, categoryId, severityId, slaMinutes: sev.sla_minutes, resolverGroupIds, org,
        identity: { customerName, customerContact, consent }, customValues,
        recordType, requiresApproval: recordType === "service_request" && catalogItem?.requires_approval,
      });
      if (vendorId) {
        await supabase.from("incident_vendors").insert({ incident_id: inc.id, vendor_id: vendorId, org_id: org.id });
      }
      await onCreated();
    } finally { setSaving(false); }
  }

  return (
    <Panel title={`Log a new ${getTerm(org, "incident", "incident").toLowerCase()}`} icon={Plus}>
      <div className="flex gap-1.5 mb-3">
        {[["incident", `${getTerm(org, "incident", "Incident")} — something's broken`], ["service_request", "Request — something's needed"]].map(([val, label]) => (
          <button key={val} type="button" onClick={() => setRecordType(val)} className="text-xs px-2.5 py-1.5 rounded-full"
            style={{ background: recordType === val ? COLORS.amber + "22" : COLORS.surfaceHi, color: recordType === val ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
            {label}
          </button>
        ))}
      </div>
      {vendors.length > 0 && (
        <Field label="Related vendor (optional)">
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="sd-in">
            <option value="">None</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
      )}
      {recordType === "service_request" && (lookups.catalogItems || []).length > 0 && (
        <Field label="From the catalog (optional)">
          <select value={catalogItemId} onChange={(e) => applyCatalogItem(e.target.value)} className="sd-in">
            <option value="">Custom request — not from the catalog</option>
            {lookups.catalogItems.map((c) => <option key={c.id} value={c.id}>{c.name}{c.requires_approval ? " (needs approval)" : ""}</option>)}
          </select>
        </Field>
      )}
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className="sd-in" placeholder="Short summary" /></Field>
      <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="sd-in" placeholder="Technical detail — avoid names, numbers, ID numbers" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="sd-in">
            {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Severity">
          <select value={severityId} onChange={(e) => setSeverityId(e.target.value)} className="sd-in">
            {lookups.severities.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.sla_minutes}m)</option>)}
          </select>
        </Field>
      </div>
      <Field label="Resolver group(s) — select one or more">
        <div className="flex flex-wrap gap-1.5">
          {lookups.resolverGroups.map((g) => (
            <button key={g.id} type="button" onClick={() => toggleGroup(g.id)} className="text-xs px-2.5 py-1 rounded-full"
              style={{ background: resolverGroupIds.includes(g.id) ? COLORS.amber + "22" : COLORS.surfaceHi, color: resolverGroupIds.includes(g.id) ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {g.name}
            </button>
          ))}
        </div>
        {!groupManuallySet && lookups.categories.find((c) => c.id === categoryId)?.default_resolver_group_id && (
          <p className="text-[11px] mt-1.5" style={{ color: COLORS.faint }}>Auto-routed from category — click a group above to override.</p>
        )}
      </Field>
      {org.identity_module_enabled && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer name (optional)"><input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="sd-in" /></Field>
            <Field label="Contact (optional)"><input value={customerContact} onChange={(e) => setCustomerContact(e.target.value)} className="sd-in" placeholder="WhatsApp / email" /></Field>
          </div>
          {hasContact && (
            <label className="flex items-start gap-2 text-[11px] p-2.5 rounded-lg mb-2" style={{ background: COLORS.surfaceHi, border: `1px solid ${warn && !consent ? COLORS.red : COLORS.border}` }}>
              <input type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); setWarn(false); }} className="mt-0.5" />
              <span>I have this person's consent to store their name and contact details for resolving this incident, and to send them automatic email updates on this incident's progress if they gave an email address.</span>
            </label>
          )}
        </>
      )}
      {!org.identity_module_enabled && (
        <p className="text-[11px] mb-2" style={{ color: COLORS.faint }}>Identity Module is off — this incident will be logged as metadata only, with no name or contact details. Turn it on in Settings if you need to capture that.</p>
      )}
      {(lookups.customFields || []).length > 0 && (
        <div className="mb-1">
          {lookups.customFields.map((f) => (
            <CustomFieldInput key={f.id} field={f} value={customValues[f.id] || ""} onChange={(v) => setCustomValue(f.id, v)} />
          ))}
        </div>
      )}
      <button onClick={submit} disabled={saving || !title.trim()} className="w-full py-2.5 rounded-lg font-semibold text-sm mt-1" style={{ background: COLORS.amber, color: "#1A1200" }}>
        {saving ? "Logging…" : `Log ${getTerm(org, "incident", "Incident")}`}
      </button>
      <style>{`.sd-in { width: 100%; background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 8px 10px; font-size: 13px; color: ${COLORS.text}; margin-bottom: 2px; }`}</style>
    </Panel>
  );
}

function ChatIntake({ lookups, org, onCreated }) {
  const [messages, setMessages] = useState([{ role: "assistant", text: "Tell me what's going wrong and I'll log it for you." }]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const userMsg = input;
    setMessages((m) => [...m, { role: "user", text: userMsg }]);
    setInput(""); setLoading(true);
    const sys = `You are an ITSM intake assistant. Categories: ${lookups.categories.map((c) => c.name).join(", ")}. Severities: Critical, High, Medium, Low. Do not include names, phone numbers, emails, or ID numbers in your output. Respond ONLY with JSON: {"title":"...","notes":"...","category":"...","severity":"...","reply":"one short sentence"}`;
    const result = await askAI(sys, redactPII(userMsg), true);
    setLoading(false);
    if (result?.title) {
      setDraft(result);
      setMessages((m) => [...m, { role: "assistant", text: result.reply || "Review the details below and confirm." }]);
    } else {
      setMessages((m) => [...m, { role: "assistant", text: "Could you describe the problem in a sentence or two?" }]);
    }
  }

  async function confirm() {
    const cat = lookups.categories.find((c) => c.name === draft.category) || lookups.categories[0];
    const sevName = ["Critical", "High", "Medium", "Low"].includes(draft.severity) ? draft.severity : "Medium";
    const sev = lookups.severities.find((s) => s.name === sevName) || lookups.severities[0];
    const defaultGroup = lookups.resolverGroups[0];
    await insertIncident({
      title: draft.title, notes: draft.notes, categoryId: cat.id, severityId: sev.id, slaMinutes: sev.sla_minutes,
      resolverGroupIds: defaultGroup ? [defaultGroup.id] : [], org, identity: null,
    });
    await onCreated();
  }

  return (
    <div className="rounded-xl flex flex-col" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, height: 440 }}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[80%] text-sm px-3 py-2 rounded-2xl" style={{ background: m.role === "user" ? COLORS.amber : COLORS.surfaceHi, color: m.role === "user" ? "#1A1200" : COLORS.text }}>{m.text}</div>
          </div>
        ))}
        {loading && <p className="text-xs" style={{ color: COLORS.faint }}>Thinking…</p>}
        {draft && (
          <div className="rounded-lg p-3 text-xs space-y-1.5" style={{ background: COLORS.bg }}>
            <div className="font-semibold">{draft.title}</div>
            <div style={{ color: COLORS.muted }}>{draft.notes}</div>
            <button onClick={confirm} className="mt-1 w-full py-1.5 rounded-lg font-semibold" style={{ background: COLORS.amber, color: "#1A1200" }}>Confirm & log incident</button>
          </div>
        )}
      </div>
      <div className="p-3 flex gap-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Describe the problem…" className="flex-1 px-3 py-2 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
        <button onClick={send} className="px-3 rounded-lg" style={{ background: COLORS.amber }}><Send size={15} color="#1A1200" /></button>
      </div>
    </div>
  );
}

/* ============================== INCIDENT DETAIL ============================= */
function IncidentDetail({ incident, incidents, lookups, org, onBack, onChanged, showToast }) {
  const [rcaCategoryId, setRcaCategoryId] = useState(incident.rca_category?.id || "");
  const [resolutionClass, setResolutionClass] = useState(incident.resolution_class || "");
  const [aiLoading, setAiLoading] = useState("");

  async function changeStatus(statusId) {
    await supabase.from("incidents").update({ status_id: statusId }).eq("id", incident.id);
    await supabase.from("incident_timeline").insert({ incident_id: incident.id, org_id: org.id, status_id: statusId, note: "Status changed" });
    onChanged();
  }

  async function suggestMitigation() {
    setAiLoading("mitigation");
    const res = await askAI("You are an ITSM assistant. Suggest up to 4 concise mitigation steps, numbered, no preamble.",
      `Category: ${incident.category?.name}\nSeverity: ${incident.severity?.name}\nTitle: ${redactPII(incident.title)}\nNotes: ${redactPII(incident.notes || "")}`);
    await supabase.from("incidents").update({ ai_mitigation: res }).eq("id", incident.id);
    setAiLoading(""); onChanged();
  }

  async function suggestRCA() {
    setAiLoading("rca");
    const names = lookups.rcaCategories.map((r) => r.name).join(", ");
    const res = await askAI(`You are an ITSM assistant. Pick the single best-fitting root cause category from this exact list: ${names}. Respond with ONLY the category name, nothing else.`,
      `Title: ${redactPII(incident.title)}\nNotes: ${redactPII(incident.notes || "")}`);
    const match = lookups.rcaCategories.find((r) => res && res.trim().toLowerCase().includes(r.name.toLowerCase()));
    if (match) setRcaCategoryId(match.id);
    setAiLoading("");
  }

  async function resolve() {
    if (!resolutionClass) { showToast("Choose a resolution classification first"); return; }
    const resolvedStatus = lookups.statuses.find((s) => s.name === "Resolved") || lookups.statuses[lookups.statuses.length - 1];
    await supabase.from("incidents").update({
      resolved_at: new Date().toISOString(), rca_category_id: rcaCategoryId || null, resolution_class: resolutionClass, status_id: resolvedStatus.id,
    }).eq("id", incident.id);
    await supabase.from("incident_timeline").insert({ incident_id: incident.id, org_id: org.id, status_id: resolvedStatus.id, note: "Incident resolved" });
    showToast("Incident resolved"); onChanged();
  }

  async function acknowledge() {
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("incidents").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: session?.user?.id || null }).eq("id", incident.id);
    await supabase.from("incident_timeline").insert({ incident_id: incident.id, org_id: org.id, note: "Acknowledged" });
    showToast("Acknowledged"); onChanged();
  }

  async function escalate(channel) {
    const assignment = incident.incident_assignments?.[0];
    const groupId = assignment?.resolver_group_id;
    const groupWebhook = channel === "Slack" ? assignment?.resolver_groups?.channel_slack_webhook : channel === "Teams" ? assignment?.resolver_groups?.channel_teams_webhook : null;
    const orgWebhook = channel === "Slack" ? org.slack_webhook : channel === "Teams" ? org.teams_webhook : null;
    // The specific team's own saved webhook wins if they have one — this is
    // the real fix for every resolver group's alerts landing in the same
    // place, using an actual foreign key rather than matching names between
    // systems the way the ServiceNow<->Jira team sync does.
    const url = groupWebhook || orgWebhook;
    let delivered = "simulated";
    if (url) { try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Escalation: ${incident.display_id} — ${incident.title}` }) }); delivered = groupWebhook ? "sent to team channel" : "sent to org channel"; } catch { delivered = "simulated (blocked)"; } }
    await supabase.from("escalations").insert({ incident_id: incident.id, org_id: org.id, resolver_group_id: groupId, channel, kind: "escalation", delivered });
    showToast(`${channel} escalation logged (${delivered})`); onChanged();
  }

  async function warRoom() {
    const assignment = incident.incident_assignments?.[0];
    const url = assignment?.resolver_groups?.channel_slack_webhook || assignment?.resolver_groups?.channel_teams_webhook || org.slack_webhook || org.teams_webhook;
    if (url) fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `🚨 War room: ${incident.display_id} — ${incident.title}` }) }).catch(() => {});
    await supabase.from("escalations").insert({ incident_id: incident.id, org_id: org.id, resolver_group_id: incident.incident_assignments?.[0]?.resolver_group_id, channel: url ? "Slack/Teams" : "Internal", kind: "war_room", delivered: url ? "sent" : "simulated" });
    showToast("War room opened"); onChanged();
  }

  const identity = incident.incident_identity?.[0];

  const [preventatives, setPreventatives] = useState([]);
  const [preventDesc, setPreventDesc] = useState("");
  const [preventGroupId, setPreventGroupId] = useState("");
  const [preventDue, setPreventDue] = useState("");

  const loadPreventatives = useCallback(async () => {
    const { data } = await supabase.from("preventative_actions").select("*, resolver_groups(name)").eq("incident_id", incident.id).order("created_at", { ascending: false });
    setPreventatives(data || []);
  }, [incident.id]);
  useEffect(() => { loadPreventatives(); }, [loadPreventatives]);

  async function addPreventative() {
    if (!preventDesc.trim()) { showToast("Describe the preventative action first"); return; }
    const { error } = await supabase.from("preventative_actions").insert({
      org_id: org.id, incident_id: incident.id, rca_category_id: rcaCategoryId || incident.rca_category?.id || null,
      description: preventDesc, resolver_group_id: preventGroupId || null, due_date: preventDue || null,
    });
    if (error) { showToast(error.message); return; }
    setPreventDesc(""); setPreventGroupId(""); setPreventDue("");
    showToast("Preventative action added");
    await loadPreventatives();
  }

  async function setPreventativeStatus(id, status) {
    await supabase.from("preventative_actions").update({ status, closed_at: status === "done" ? new Date().toISOString() : null }).eq("id", id);
    await loadPreventatives();
  }

  return (
    <div className="pb-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back</button>
      <Panel title={incident.title} icon={AlertTriangle}>
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="sd-mono text-xs" style={{ color: COLORS.faint }}>{incident.display_id}</span>
          <SeverityPill name={incident.severity?.name} /><StatusPill name={incident.status?.name} />
        </div>
        <p className="text-sm" style={{ color: COLORS.muted }}>{incident.notes}</p>

        {/* SLA status — its own visually separated block, not stacked
            directly under the description with no breathing room. */}
        <div className="mt-3 pt-3 flex flex-col gap-1" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <SLABadge incident={incident} />
          <FirstResponseBadge incident={incident} lookups={lookups} />
        </div>

        {/* Actions — Acknowledge and War Room grouped together as their
            own block, separated from the SLA info above rather than
            just tacked on directly after it. */}
        {(!incident.resolved_at) && (
          <div className="mt-3 pt-3 space-y-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
            {incident.acknowledged_at ? (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.teal }}>
                <Check size={13} /> Acknowledged {new Date(incident.acknowledged_at).toLocaleString()}
              </div>
            ) : (
              <button onClick={acknowledge} className="w-full py-2 rounded-lg text-sm font-medium" style={{ background: COLORS.teal + "1c", color: COLORS.teal, border: `1px solid ${COLORS.teal}55` }}>
                Acknowledge
              </button>
            )}
            {incident.severity?.name === "Critical" && (
              <button onClick={warRoom} className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium" style={{ background: COLORS.red + "1c", color: COLORS.red, border: `1px solid ${COLORS.red}55` }}>
                <Zap size={14} /> Open War Room
              </button>
            )}
          </div>
        )}

        {!incident.resolved_at && <CommandSummaryPanel incident={incident} incidents={incidents} lookups={lookups} />}
      </Panel>

      {/* Two-column on desktop (same md: breakpoint already used for the
          sidebar vs mobile bottom nav elsewhere in the app), single
          column on mobile — the side column just renders after the main
          one in DOM order on mobile, a reasonable fallback rather than
          a second layout to maintain. Right column holds the things
          someone glances at or occasionally updates (status, assignee,
          related assets/vendor/fields, time logged); left column holds
          the things someone is actively working through. */}
      {/* Escalate gets its own prominent, always-open section right after
          the header — previously buried three levels deep inside a
          collapsed "Files & approval" section, genuinely poor placement
          for something time-sensitive. */}
      <Panel title="Escalate" icon={Send}>
        <div className="flex flex-wrap gap-2">
          {["WhatsApp", "Email", "SMS", "Slack", "Teams"].map((ch) => (
            <button key={ch} onClick={() => escalate(ch)} className="sd-btn-g">{ch}</button>
          ))}
        </div>
        <div className="mt-3 space-y-1.5 max-h-40 overflow-y-auto">
          {(incident.escalations || []).map((e) => (
            <div key={e.id} className="text-xs" style={{ color: COLORS.muted }}>{new Date(e.ts).toLocaleString()} — {e.channel} ({e.delivered})</div>
          ))}
        </div>
      </Panel>

      <div className="md:flex md:gap-4 md:items-start">
        <div className="md:flex-1 md:min-w-0">
          <CollapsibleSection title="Work this incident" icon={ShieldCheck} defaultOpen={sectionDefaultOpen(org, "workThisIncident", true)}>
            <Panel title="AI mitigation suggestion" icon={Sparkles}>
              <p className="text-sm mb-2 whitespace-pre-wrap">{incident.ai_mitigation || "No suggestion yet."}</p>
              <button onClick={suggestMitigation} disabled={aiLoading === "mitigation"} className="sd-btn-g">{aiLoading === "mitigation" ? "Thinking…" : "Ask AI"}</button>
            </Panel>

            <RCAAnalysisPanel incident={incident} org={org} lookups={lookups} onCategorySuggested={setRcaCategoryId} showToast={showToast} />

            <RiskSignalsPanel incident={incident} />
          </CollapsibleSection>

          <CollapsibleSection title="Activity" icon={MessageSquare} defaultOpen={sectionDefaultOpen(org, "activity", true)}>
            <CommentsPanel incident={incident} org={org} onChanged={onChanged} />
            <Panel title="Timeline" icon={Clock}>
              {(incident.incident_timeline || []).sort((a, b) => new Date(a.ts) - new Date(b.ts)).map((t) => (
                <div key={t.id} className="text-xs mb-2" style={{ color: COLORS.muted }}>
                  <span className="sd-mono" style={{ color: COLORS.faint }}>{new Date(t.ts).toLocaleString()}</span> — {t.note}
                </div>
              ))}
            </Panel>
          </CollapsibleSection>

          <CollapsibleSection title="Files & approval" icon={CheckCircle2} defaultOpen={sectionDefaultOpen(org, "filesApproval", false)}
            forceOpen={incident.record_type === "service_request" && incident.approval_status === "pending"}>
            {incident.record_type === "service_request" && incident.approval_status === "pending" && (
              <ApprovalPanel incident={incident} org={org} onChanged={onChanged} showToast={showToast} />
            )}
            <AttachmentsPanel incident={incident} org={org} showToast={showToast} />
            {org.identity_module_enabled && (
              <Panel title="Customer contact" icon={Users}>
                {identity ? (
                  <div className="text-sm">{identity.customer_name || "—"} · {identity.customer_contact || "—"}</div>
                ) : <p className="text-sm" style={{ color: COLORS.muted }}>No contact details captured for this incident.</p>}
              </Panel>
            )}
          </CollapsibleSection>
        </div>

        <div className="md:w-72 md:shrink-0">
          {/* Lifecycle control cluster — current state, who's on it, how
              it ends, read top to bottom as a natural progression. */}
          <Panel title="Status" icon={Activity}>
            <select value={incident.status?.id || ""} onChange={(e) => changeStatus(e.target.value)} className="sd-in3">
              {lookups.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Panel>
          <AssigneePanel incident={incident} incidents={incidents} onChanged={onChanged} showToast={showToast} />
          {!incident.resolved_at && (
            <Panel title="Resolve" icon={CheckCircle2}>
              <Field label="Root cause category">
                <select value={rcaCategoryId} onChange={(e) => setRcaCategoryId(e.target.value)} className="sd-in3">
                  <option value="">Choose…</option>
                  {lookups.rcaCategories.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </Field>
              <button onClick={suggestRCA} disabled={aiLoading === "rca"} className="sd-btn-g mb-3">{aiLoading === "rca" ? "Thinking…" : "AI: suggest category"}</button>
              <Field label="Resolution classification">
                <select value={resolutionClass} onChange={(e) => setResolutionClass(e.target.value)} className="sd-in3">
                  <option value="">Choose…</option>
                  <option>Permanent Fix</option><option>Temporary Fix</option><option>Workaround</option><option>Escalated (No Fix)</option>
                </select>
              </Field>
              <button onClick={resolve} className="sd-btn-p">Resolve {getTerm(org, "incident", "Incident")}</button>
            </Panel>
          )}

          {/* Tracking/reference cluster — a checklist and related
              lookups, not active in-the-moment work. */}
          <Panel title="Preventative actions — what stops this recurring" icon={ShieldCheck}>
            <div className="space-y-2 mb-4">
              {preventatives.map((p) => (
                <div key={p.id} className="text-sm p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, opacity: p.status === "done" || p.status === "wont_fix" ? 0.55 : 1 }}>
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ color: COLORS.text }}>{p.description}</span>
                    <select value={p.status} onChange={(e) => setPreventativeStatus(p.id, e.target.value)} className="text-[11px] px-1.5 py-1 rounded"
                      style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: p.status === "done" ? COLORS.teal : p.status === "wont_fix" ? COLORS.faint : COLORS.amber }}>
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="done">Done</option>
                      <option value="wont_fix">Won't fix</option>
                    </select>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: COLORS.faint }}>
                    {p.resolver_groups?.name || "Unassigned"}{p.due_date ? ` · due ${new Date(p.due_date).toLocaleDateString()}` : ""}
                    {p.status === "open" && p.due_date && new Date(p.due_date) < new Date() ? <span style={{ color: COLORS.red }}> · overdue</span> : ""}
                  </div>
                </div>
              ))}
              {preventatives.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No preventative actions logged for this incident yet.</p>}
            </div>
            <Field label="Describe the preventative action"><textarea value={preventDesc} onChange={(e) => setPreventDesc(e.target.value)} rows={2} className="sd-in3" placeholder="e.g. Add a 4G failover router as backup uplink" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner (optional)">
                <select value={preventGroupId} onChange={(e) => setPreventGroupId(e.target.value)} className="sd-in3">
                  <option value="">Unassigned</option>
                  {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
              <Field label="Due date (optional)"><input type="date" value={preventDue} onChange={(e) => setPreventDue(e.target.value)} className="sd-in3" /></Field>
            </div>
            <button onClick={addPreventative} className="sd-btn-g">Add preventative action</button>
          </Panel>
          {!isPanelHidden(org, "affectedAssets") && <AffectedCIsPanel incident={incident} org={org} onChanged={onChanged} showToast={showToast} />}
          {!isPanelHidden(org, "vendor") && <VendorLinkPanel incident={incident} org={org} onChanged={onChanged} showToast={showToast} />}
          {!isPanelHidden(org, "problemLink") && <ProblemLinkPanel incident={incident} lookups={lookups} org={org} onChanged={onChanged} showToast={showToast} />}
          {!isPanelHidden(org, "customFields") && <CustomFieldsValuesPanel incident={incident} lookups={lookups} org={org} onChanged={onChanged} />}
          {!isPanelHidden(org, "timeSpent") && <TimeSpentPanel incident={incident} lookups={lookups} org={org} showToast={showToast} />}
        </div>
      </div>
      <style>{`.sd-in3 { width: 100%; background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 8px 10px; font-size: 13px; color: ${COLORS.text}; }
        .sd-btn-p { background: ${COLORS.amber}; color: #1A1200; font-weight: 600; font-size: 13px; padding: 9px 16px; border-radius: 8px; }
        .sd-btn-g { background: transparent; border: 1px solid ${COLORS.border}; color: ${COLORS.amber}; font-size: 12px; font-weight: 500; padding: 7px 12px; border-radius: 8px; }`}</style>
    </div>
  );
}

/* ================================ PRIVACY CENTER ============================= */
function PrivacyCenter({ org, onOrgUpdated, incidents, showToast }) {
  const [auditLog, setAuditLog] = useState([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [confirmAction, setConfirmAction] = useState(null);

  useEffect(() => { (async () => {
    const { data } = await supabase.from("audit_log").select("*").order("ts", { ascending: false }).limit(100);
    setAuditLog(data || []);
  })(); }, []);

  async function toggleIdentityModule(enabled) {
    const { error } = await supabase.rpc("set_identity_module", { enabled });
    if (error) { showToast(error.message); return; }
    onOrgUpdated({ ...org, identity_module_enabled: enabled });
    showToast(enabled ? "Identity Module enabled" : "Identity Module disabled");
  }

  async function purgeOverdue() {
    const cutoff = Date.now() - org.retention_days * 86400000;
    const overdue = incidents.filter((i) => i.resolved_at && new Date(i.resolved_at).getTime() < cutoff);
    if (overdue.length === 0) { showToast("Nothing overdue"); return; }
    await supabase.from("incidents").delete().in("id", overdue.map((i) => i.id));
    await supabase.from("audit_log").insert({ org_id: org.id, action: "data_purged", detail: `${overdue.length} incident(s) purged` });
    showToast(`${overdue.length} record(s) purged`);
  }

  async function searchIdentity() {
    const { data } = await supabase.from("incident_identity").select("*, incidents(display_id, title)").ilike("customer_name", `%${query}%`);
    setMatches(data || []);
  }

  async function redact(ids) {
    await supabase.from("incident_identity").update({ customer_name: "[redacted]", customer_contact: "[redacted]" }).in("incident_id", ids);
    await supabase.from("audit_log").insert({ org_id: org.id, action: "data_redacted", detail: `${ids.length} record(s)` });
    setConfirmAction(null); setMatches([]); showToast("Redacted");
  }
  async function eraseAll(ids) {
    await supabase.from("incident_identity").delete().in("incident_id", ids);
    await supabase.from("audit_log").insert({ org_id: org.id, action: "data_deleted", detail: `${ids.length} identity record(s)` });
    setConfirmAction(null); setMatches([]); showToast("Deleted");
  }

  return (
    <div>
      <Panel title="Identity Module" icon={ShieldCheck}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          {org.identity_module_enabled
            ? "On — incidents can capture customer name and contact details, with consent. When a customer gives an email and consents, they'll also get automatic email updates when their incident's status changes, gets a reply, or is resolved."
            : "Off — incidents are metadata-only. No names, emails, or phone numbers are stored anywhere, and no automatic emails are ever sent to customers."}
        </p>
        <button onClick={() => toggleIdentityModule(!org.identity_module_enabled)} className="sd-btn-p">
          {org.identity_module_enabled ? "Turn off Identity Module" : "Turn on Identity Module"}
        </button>
      </Panel>

      <Panel title="Data retention" icon={Clock}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Retention period: {org.retention_days} days after resolution.</p>
        <button onClick={purgeOverdue} className="sd-btn-g">Purge overdue records now</button>
      </Panel>

      {org.identity_module_enabled && (
        <Panel title="Data subject requests" icon={UserX}>
          <div className="flex gap-2 mb-3">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Customer name…" className="sd-in4 flex-1" />
            <button onClick={searchIdentity} className="sd-btn-p">Search</button>
          </div>
          {matches.map((m) => (
            <div key={m.incident_id} className="text-xs p-2 mb-2 rounded-lg" style={{ background: COLORS.surfaceHi }}>
              <div>{m.incidents?.display_id} — {m.customer_name} / {m.customer_contact}</div>
              <div className="flex gap-2 mt-1">
                <button onClick={() => setConfirmAction({ type: "redact", ids: [m.incident_id] })} className="sd-btn-g">Redact</button>
                <button onClick={() => setConfirmAction({ type: "delete", ids: [m.incident_id] })} className="sd-btn-g" style={{ color: COLORS.red }}>Delete</button>
              </div>
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Audit log" icon={ScanEye}>
        {auditLog.map((a) => (
          <div key={a.id} className="text-xs mb-1.5" style={{ color: COLORS.muted }}>
            <span className="sd-mono" style={{ color: COLORS.faint }}>{new Date(a.ts).toLocaleString()}</span> {a.action} — {a.detail}
          </div>
        ))}
        {auditLog.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No events yet.</p>}
      </Panel>

      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(5,8,16,0.85)" }}>
          <div className="w-full max-w-sm rounded-xl p-5" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <p className="text-sm mb-4">This can't be undone. Continue?</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmAction(null)} className="flex-1 sd-btn-g">Cancel</button>
              <button onClick={() => confirmAction.type === "delete" ? eraseAll(confirmAction.ids) : redact(confirmAction.ids)} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: COLORS.red, color: "#fff" }}>Confirm</button>
            </div>
          </div>
        </div>
      )}
      <style>{`.sd-in4 { background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 8px 10px; font-size: 13px; color: ${COLORS.text}; }
        .sd-btn-p { background: ${COLORS.amber}; color: #1A1200; font-weight: 600; font-size: 12.5px; padding: 8px 14px; border-radius: 8px; }
        .sd-btn-g { background: transparent; border: 1px solid ${COLORS.border}; color: ${COLORS.text}; font-size: 12.5px; padding: 7px 13px; border-radius: 8px; }`}</style>
    </div>
  );
}

/* =================================== SETTINGS ================================ */
function Settings({ org, lookups, onOrgUpdated, onLookupsChanged, showToast }) {
  const [orgName, setOrgName] = useState(org.name);
  const [ioName, setIoName] = useState(org.information_officer_name || "");
  const [ioEmail, setIoEmail] = useState(org.information_officer_email || "");
  const [emailSenderName, setEmailSenderName] = useState(org.email_sender_name || "");
  const [slack, setSlack] = useState(org.slack_webhook || "");
  const [teams, setTeams] = useState(org.teams_webhook || "");
  const [newGroup, setNewGroup] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newRca, setNewRca] = useState("");

  async function saveOrg() {
    const { data } = await supabase.from("organisations").update({
      name: orgName, information_officer_name: ioName, information_officer_email: ioEmail,
      slack_webhook: slack, teams_webhook: teams, email_sender_name: emailSenderName || null,
    }).eq("id", org.id).select().single();
    onOrgUpdated({ ...org, ...data });
    showToast("Saved");
  }

  async function addGroup() { if (!newGroup.trim()) return; await supabase.from("resolver_groups").insert({ org_id: org.id, name: newGroup }); setNewGroup(""); onLookupsChanged(); }
  async function addCategory() { if (!newCategory.trim()) return; await supabase.from("categories").insert({ org_id: org.id, name: newCategory }); setNewCategory(""); onLookupsChanged(); }
  async function addRca() { if (!newRca.trim()) return; await supabase.from("rca_categories").insert({ org_id: org.id, name: newRca, sort_order: lookups.rcaCategories.length }); setNewRca(""); onLookupsChanged(); }
  async function removeItem(table, id) { await supabase.from(table).delete().eq("id", id); onLookupsChanged(); }
  async function updateSla(id, minutes) { await supabase.from("severities").update({ sla_minutes: minutes }).eq("id", id); onLookupsChanged(); }
  async function updateWeight(id, weight) { await supabase.from("severities").update({ business_weight: weight }).eq("id", id); onLookupsChanged(); }

  const [copied, setCopied] = useState(false);
  const portalUrl = `${window.location.origin}/portal/${org.portal_slug}`;
  function copyPortalLink() {
    navigator.clipboard?.writeText(portalUrl);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }
  async function rotateLink() {
    const { data, error } = await supabase.rpc("rotate_portal_slug");
    if (error) { showToast(error.message); return; }
    onOrgUpdated({ ...org, portal_slug: data });
    showToast("Portal link rotated — the old link no longer works");
  }

  async function exportSlaReport() {
    const { data, error } = await supabase.from("incident_sla_report").select("*");
    if (error) { showToast("Export failed: " + error.message); return; }
    if (!data || data.length === 0) { showToast("No incidents to export yet"); return; }
    const headers = Object.keys(data[0]);
    const rows = data.map((row) => headers.map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sla-report-${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Real security boundary is the RLS policies (migration 45) — this is
  // purely about not showing an agent a page full of forms that would
  // fail the moment they're submitted. An honest message beats a
  // confusing partial page.
  if (org.myRole !== "owner" && org.myRole !== "admin") {
    return (
      <div className="pb-6 text-center py-12">
        <SettingsIcon size={28} color={COLORS.faint} className="mx-auto mb-3" />
        <p className="text-sm" style={{ color: COLORS.muted }}>Settings are managed by your organisation's owner or admin.</p>
        <p className="text-xs mt-1" style={{ color: COLORS.faint }}>Ask them if something here needs to change.</p>
      </div>
    );
  }

  return (
    <div className="pb-6">
      <CollapsibleSection title="Organisation & branding" icon={Anchor} defaultOpen={true}>
        <Panel title="Organisation" icon={Anchor}>
          <Field label="Name"><input value={orgName} onChange={(e) => setOrgName(e.target.value)} className="sd-in5" /></Field>
          <Field label="Email sender name — shown as the 'From' name on every outbound email, instead of 'Signal Deck'">
            <input value={emailSenderName} onChange={(e) => setEmailSenderName(e.target.value)} placeholder={orgName || "Signal Deck"} className="sd-in5" />
          </Field>
          <Field label="Information Officer name"><input value={ioName} onChange={(e) => setIoName(e.target.value)} className="sd-in5" /></Field>
          <Field label="Information Officer email"><input value={ioEmail} onChange={(e) => setIoEmail(e.target.value)} className="sd-in5" /></Field>
          <Field label="Slack webhook"><input value={slack} onChange={(e) => setSlack(e.target.value)} className="sd-in5" placeholder="https://hooks.slack.com/…" /></Field>
          <Field label="Teams webhook"><input value={teams} onChange={(e) => setTeams(e.target.value)} className="sd-in5" placeholder="https://…webhook.office.com/…" /></Field>
          <button onClick={saveOrg} className="sd-btn-p6">Save</button>
        </Panel>

        <Panel title="Self-service customer portal" icon={Link2}>
          <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Share this link with customers so they can log an issue without an account or login. Submissions are metadata-only — no name or contact details are ever captured here, even if the Identity Module is on.</p>
          <div className="flex items-center gap-2 mb-2">
            <input readOnly value={portalUrl} className="sd-in5 flex-1 sd-mono" style={{ fontSize: 11.5 }} />
            <button onClick={copyPortalLink} className="sd-btn-p6 flex items-center gap-1.5">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
          </div>
          <button onClick={rotateLink} className="text-xs" style={{ color: COLORS.muted }}>Rotate link (invalidates the one above)</button>
        </Panel>

        <TemplateSettingsPanel org={org} onOrgUpdated={onOrgUpdated} showToast={showToast} />

        <IncidentLayoutPanel org={org} onOrgUpdated={onOrgUpdated} showToast={showToast} />
      </CollapsibleSection>

      <CollapsibleSection title="People" icon={Users} defaultOpen={false}>
        <Panel title="Resolver groups" icon={Users}>
          {lookups.resolverGroups.map((g) => (
            <div key={g.id} className="flex items-center justify-between text-sm py-1">{g.name}<button onClick={() => removeItem("resolver_groups", g.id)}><Trash2 size={13} color={COLORS.faint} /></button></div>
          ))}
          <div className="flex gap-2 mt-2"><input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} className="sd-in5 flex-1" placeholder="New group" /><button onClick={addGroup} className="sd-btn-p6">Add</button></div>
        </Panel>

        <InvitePanel org={org} lookups={lookups} showToast={showToast} />

        <TeamAssignmentPanel org={org} lookups={lookups} showToast={showToast} />

        {isModuleEnabled(org, "on_call") && <OnCallPanel org={org} lookups={lookups} showToast={showToast} />}
      </CollapsibleSection>

      <CollapsibleSection title="Ticket setup" icon={ScanEye} defaultOpen={false}>
        <Panel title="Categories" icon={ScanEye}>
          {lookups.categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between text-sm py-1">{c.name}<button onClick={() => removeItem("categories", c.id)}><Trash2 size={13} color={COLORS.faint} /></button></div>
          ))}
          <div className="flex gap-2 mt-2"><input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="sd-in5 flex-1" placeholder="New category" /><button onClick={addCategory} className="sd-btn-p6">Add</button></div>
        </Panel>

        <Panel title="Root cause taxonomy" icon={ScanEye}>
          {lookups.rcaCategories.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm py-1">{r.name}<button onClick={() => removeItem("rca_categories", r.id)}><Trash2 size={13} color={COLORS.faint} /></button></div>
          ))}
          <div className="flex gap-2 mt-2"><input value={newRca} onChange={(e) => setNewRca(e.target.value)} className="sd-in5 flex-1" placeholder="New RCA category" /><button onClick={addRca} className="sd-btn-p6">Add</button></div>
        </Panel>

        <Panel title="Severity, SLA & business impact" icon={Clock}>
          <div className="grid grid-cols-[auto_1fr_1fr] gap-2 mb-1.5 text-[10px]" style={{ color: COLORS.faint }}>
            <span></span><span>SLA (minutes)</span><span>Business weight (1-5)</span>
          </div>
          {lookups.severities.map((s) => (
            <div key={s.id} className="grid grid-cols-[auto_1fr_1fr] gap-2 items-center mb-2">
              <SeverityPill name={s.name} />
              <input type="number" defaultValue={s.sla_minutes} onBlur={(e) => updateSla(s.id, +e.target.value)} className="sd-in5" />
              <input type="number" min="1" max="5" defaultValue={s.business_weight} onBlur={(e) => updateWeight(s.id, +e.target.value)} className="sd-in5" />
            </div>
          ))}
          <p className="text-[11px] mt-1" style={{ color: COLORS.faint }}>Business weight doesn't change the SLA clock — it's used to sort the dashboard by revenue risk, not just severity label.</p>
        </Panel>

        {isModuleEnabled(org, "sla_policies") && <SLAPoliciesPanel org={org} lookups={lookups} onLookupsChanged={onLookupsChanged} showToast={showToast} />}

        <CustomFieldsPanel org={org} lookups={lookups} onLookupsChanged={onLookupsChanged} showToast={showToast} />

        {isModuleEnabled(org, "service_catalog") && <ServiceCatalogPanel org={org} lookups={lookups} onLookupsChanged={onLookupsChanged} showToast={showToast} />}

        {isModuleEnabled(org, "cmdb") && <CITypesPanel org={org} lookups={lookups} onLookupsChanged={onLookupsChanged} showToast={showToast} />}
      </CollapsibleSection>

      <CollapsibleSection title="Automation & knowledge" icon={Zap} defaultOpen={false}>
        <AutomationRulesPanel org={org} lookups={lookups} showToast={showToast} />

        <AutomationTrustPanel org={org} showToast={showToast} />

        <KBArticlesPanel org={org} showToast={showToast} />
      </CollapsibleSection>

      <CollapsibleSection title="Vendors" icon={Truck} defaultOpen={false}>
        <VendorSettingsPanel org={org} onOrgUpdated={onOrgUpdated} showToast={showToast} />
      </CollapsibleSection>

      <CollapsibleSection title="Data & integrations" icon={Download} defaultOpen={false}>
        <Panel title="Reporting" icon={Download}>
          <p className="text-sm mb-3" style={{ color: COLORS.muted }}>One-click export of every incident's SLA status, category, and root cause — no manual filtering.</p>
          <button onClick={exportSlaReport} className="sd-btn-p6 flex items-center gap-1.5"><Download size={13} /> Export SLA report (CSV)</button>
        </Panel>

        <IntegrationsPanel org={org} showToast={showToast} />
      </CollapsibleSection>

      <style>{`.sd-in5 { width: 100%; background: ${COLORS.surfaceHi}; border: 1px solid ${COLORS.border}; border-radius: 8px; padding: 7px 10px; font-size: 13px; color: ${COLORS.text}; }
        .sd-btn-p6 { background: ${COLORS.amber}; color: #1A1200; font-weight: 600; font-size: 12.5px; padding: 7px 14px; border-radius: 8px; }`}</style>
    </div>
  );
}

/* ================================= DIAGNOSTICS =============================== */
// A "cannot fail" self-check: instead of staring at a broken screen and not
// knowing why, click one button and get a plain-language pass/fail list.
// Every check here uses the app's own live connection — nothing simulated.
function Diagnostics({ org, lookups }) {
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);

  async function runChecks() {
    setRunning(true);
    const checks = [];

    checks.push({ label: "Signed in", ok: true, detail: "Session active" });
    checks.push({ label: "Organisation loaded", ok: !!org?.id, detail: org?.name || "No organisation found" });
    checks.push({ label: "Resolver groups configured", ok: lookups.resolverGroups.length > 0, detail: `${lookups.resolverGroups.length} group(s)` });
    checks.push({ label: "Categories configured", ok: lookups.categories.length > 0, detail: `${lookups.categories.length} categor${lookups.categories.length === 1 ? "y" : "ies"}` });
    checks.push({ label: "Statuses configured", ok: lookups.statuses.length > 0, detail: `${lookups.statuses.length} status(es)` });
    checks.push({ label: "Severities & SLA configured", ok: lookups.severities.length > 0, detail: `${lookups.severities.length} severity level(s)` });
    checks.push({ label: "Root cause taxonomy configured", ok: lookups.rcaCategories.length > 0, detail: `${lookups.rcaCategories.length} categor${lookups.rcaCategories.length === 1 ? "y" : "ies"}` });

    try {
      const probe = await supabase.from("audit_log").insert({ org_id: org.id, action: "health_check", detail: "Diagnostics panel run" }).select().single();
      checks.push({ label: "Database write path", ok: !probe.error, detail: probe.error ? probe.error.message : "Write succeeded and was correctly tagged to your organisation" });
    } catch (e) {
      checks.push({ label: "Database write path", ok: false, detail: String(e) });
    }

    try {
      const { data, error } = await supabase.rpc("portal_categories", { slug: org.portal_slug });
      checks.push({ label: "Self-service portal reachable", ok: !error && Array.isArray(data) && data.length > 0, detail: error ? error.message : `Portal returns ${data?.length || 0} categor${data?.length === 1 ? "y" : "ies"}` });
    } catch (e) {
      checks.push({ label: "Self-service portal reachable", ok: false, detail: String(e) });
    }

    try {
      const { data, error } = await supabase.functions.invoke("groq-proxy", { body: { system: "Reply with exactly one word.", user: "Say: pong" } });
      const ok = !error && data?.text && !data.error;
      checks.push({ label: "AI (Groq) proxy responding", ok, detail: error ? error.message : (data?.error || data?.text || "No response") });
    } catch (e) {
      checks.push({ label: "AI (Groq) proxy responding", ok: false, detail: String(e) });
    }

    setResults(checks);
    setRunning(false);
  }

  const allOk = results && results.every((c) => c.ok);
  const anyFail = results && results.some((c) => !c.ok);

  return (
    <div className="pb-6">
      <Panel title="Health check" icon={Activity}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          Runs a live check of every moving part — database, self-service portal, and AI — using your actual connection. Safe to run any time; it never affects real incidents.
        </p>
        <button onClick={runChecks} disabled={running} className="w-full py-2.5 rounded-lg font-semibold text-sm mb-4" style={{ background: COLORS.amber, color: "#1A1200" }}>
          {running ? "Running checks…" : "Run health check"}
        </button>

        {results && (
          <div>
            {allOk && (
              <div className="rounded-lg p-3 mb-3 text-sm" style={{ background: COLORS.teal + "1c", border: `1px solid ${COLORS.teal}55`, color: COLORS.teal }}>
                ✓ Everything checked out. Signal Deck is fully wired up.
              </div>
            )}
            {anyFail && (
              <div className="rounded-lg p-3 mb-3 text-sm" style={{ background: COLORS.red + "1c", border: `1px solid ${COLORS.red}55`, color: COLORS.red }}>
                One or more checks failed below — the detail line tells you exactly what to fix, or send it to me and I'll tell you.
              </div>
            )}
            <div className="space-y-2">
              {results.map((c, i) => (
                <div key={i} className="flex items-start gap-2.5 text-sm py-1.5" style={{ borderBottom: i < results.length - 1 ? `1px solid ${COLORS.border}` : "none" }}>
                  {c.ok ? <Check size={15} color={COLORS.teal} className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} color={COLORS.red} className="mt-0.5 shrink-0" />}
                  <div>
                    <div style={{ color: c.ok ? COLORS.text : COLORS.red }}>{c.label}</div>
                    <div className="text-xs" style={{ color: COLORS.muted }}>{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ============================== INTEGRATIONS PANEL ============================ */
// Lets a customer's own bespoke systems connect to Signal Deck: API keys for
// their system to call in, webhooks for Signal Deck to call out. Every key
// is shown exactly once at creation — Signal Deck never stores or displays
// the raw value again, only its hash, the same way a bank shows a new PIN
// once.
function IntegrationsPanel({ org, showToast }) {
  const [keys, setKeys] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState(["create_incidents"]);
  const [revealedKey, setRevealedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  const [whLabel, setWhLabel] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [whEvents, setWhEvents] = useState(["incident.created", "incident.resolved"]);

  const load = useCallback(async () => {
    const { data: k } = await supabase.from("api_keys").select("*").order("created_at", { ascending: false });
    setKeys(k || []);
    const { data: w } = await supabase.from("integration_webhooks").select("*").order("created_at", { ascending: false });
    setWebhooks(w || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleScope(scope) {
    setNewKeyScopes((s) => s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]);
  }
  function toggleEvent(evt) {
    setWhEvents((s) => s.includes(evt) ? s.filter((x) => x !== evt) : [...s, evt]);
  }

  async function createKey() {
    if (!newKeyLabel.trim() || newKeyScopes.length === 0) { showToast("Give the key a label and at least one scope"); return; }
    const { data, error } = await supabase.rpc("create_api_key", { label: newKeyLabel, scopes: newKeyScopes });
    if (error) { showToast(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    setRevealedKey(row.raw_key);
    setNewKeyLabel("");
    await load();
  }

  async function revokeKey(id) {
    const { error } = await supabase.rpc("revoke_api_key", { target_key_id: id });
    if (error) { showToast(error.message); return; }
    showToast("Key revoked — it stops working immediately");
    await load();
  }

  async function createWebhook() {
    if (!whUrl.trim() || !whSecret.trim() || whEvents.length === 0) { showToast("URL, secret, and at least one event are required"); return; }
    const { error } = await supabase.from("integration_webhooks").insert({
      org_id: org.id, label: whLabel || "Webhook", url: whUrl, secret: whSecret, event_types: whEvents,
    });
    if (error) { showToast(error.message); return; }
    setWhLabel(""); setWhUrl(""); setWhSecret("");
    showToast("Webhook added");
    await load();
  }

  async function toggleWebhookActive(hook) {
    await supabase.from("integration_webhooks").update({ active: !hook.active }).eq("id", hook.id);
    await load();
  }
  async function deleteWebhook(id) {
    await supabase.from("integration_webhooks").delete().eq("id", id);
    await load();
  }

  function copyRevealed() {
    navigator.clipboard?.writeText(revealedKey);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  return (
    <>
      <Panel title="Connecting other systems" icon={Key}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          Most customers connect other tools (a Google Sheet, email, Slack) using a free Zapier or Make account — no developer needed. See <b>NO-CODE-INTEGRATIONS-GUIDE.md</b> for click-by-click recipes. The API key below is only needed for that no-code path, or for a customer who happens to have their own developer and prefers to call the API directly (see API-DOCS.md).
        </p>
        <div className="space-y-2 mb-4">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, opacity: k.revoked_at ? 0.5 : 1 }}>
              <div>
                <div style={{ color: COLORS.text }}>{k.label} {k.revoked_at && <span style={{ color: COLORS.red }}>(revoked)</span>}</div>
                <div className="text-xs sd-mono" style={{ color: COLORS.faint }}>{k.key_prefix} · {k.scopes.join(", ")}{k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : " · never used"}</div>
              </div>
              {!k.revoked_at && <button onClick={() => revokeKey(k.id)} className="text-xs" style={{ color: COLORS.red }}>Revoke</button>}
            </div>
          ))}
          {keys.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No API keys yet.</p>}
        </div>

        <Field label="New key label"><input value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder="e.g. Warehouse stock system" className="sd-in5" /></Field>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {["create_incidents", "read_incidents", "update_incidents"].map((s) => (
            <button key={s} onClick={() => toggleScope(s)} className="text-[11px] px-2.5 py-1 rounded-full"
              style={{ background: newKeyScopes.includes(s) ? COLORS.amber + "22" : COLORS.surfaceHi, color: newKeyScopes.includes(s) ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
        <button onClick={createKey} className="sd-btn-p6">Create API key</button>
      </Panel>

      <Panel title="Webhooks — for Signal Deck to notify a customer's system" icon={Webhook}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Signal Deck will POST a signed payload to this URL the moment a matching event happens — no polling needed on their side.</p>
        <div className="space-y-2 mb-4">
          {webhooks.map((w) => (
            <div key={w.id} className="text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.text }}>{w.label}</span>
                <div className="flex gap-2">
                  <button onClick={() => toggleWebhookActive(w)} className="text-xs" style={{ color: w.active ? COLORS.teal : COLORS.faint }}>{w.active ? "Active" : "Paused"}</button>
                  <button onClick={() => deleteWebhook(w.id)}><Trash2 size={13} color={COLORS.faint} /></button>
                </div>
              </div>
              <div className="text-xs sd-mono mt-1" style={{ color: COLORS.faint }}>{w.url}</div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.muted }}>{w.event_types.join(", ")}{w.last_triggered_at ? ` · last fired ${new Date(w.last_triggered_at).toLocaleString()}` : " · never fired yet"}</div>
            </div>
          ))}
          {webhooks.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No webhooks yet.</p>}
        </div>
        <Field label="Label"><input value={whLabel} onChange={(e) => setWhLabel(e.target.value)} placeholder="e.g. Warehouse dashboard" className="sd-in5" /></Field>
        <Field label="URL"><input value={whUrl} onChange={(e) => setWhUrl(e.target.value)} placeholder="https://their-system.example.com/webhook" className="sd-in5" /></Field>
        <Field label="Shared secret (they'll use this to verify the signature)"><input value={whSecret} onChange={(e) => setWhSecret(e.target.value)} placeholder="a random string you both agree on" className="sd-in5" /></Field>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {["incident.created", "incident.resolved", "incident.status_changed"].map((evt) => (
            <button key={evt} onClick={() => toggleEvent(evt)} className="text-[11px] px-2.5 py-1 rounded-full"
              style={{ background: whEvents.includes(evt) ? COLORS.amber + "22" : COLORS.surfaceHi, color: whEvents.includes(evt) ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {evt}
            </button>
          ))}
        </div>
        <button onClick={createWebhook} className="sd-btn-p6">Add webhook</button>
      </Panel>

      {revealedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(5,8,16,0.9)" }}>
          <div className="w-full max-w-sm rounded-xl p-5" style={{ background: COLORS.surface, border: `1px solid ${COLORS.amber}55` }}>
            <h3 className="sd-display text-sm font-semibold mb-2" style={{ color: COLORS.amber }}>Copy this key now</h3>
            <p className="text-xs mb-3" style={{ color: COLORS.muted }}>This is the only time it will ever be shown. Send it to whoever is building the integration, then close this — Signal Deck doesn't keep a copy.</p>
            <div className="p-2.5 rounded-lg sd-mono text-xs mb-3 break-all" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.teal }}>{revealedKey}</div>
            <div className="flex gap-2">
              <button onClick={copyRevealed} className="flex-1 sd-btn-p6 flex items-center justify-center gap-1.5">{copied ? <Check size={13} /> : <Copy size={13} />} Copy</button>
              <button onClick={() => setRevealedKey(null)} className="flex-1 py-1.5 rounded-lg text-xs" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.muted }}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================ AUTOMATION RULES PANEL =========================== */
// Fully native "when X happens, email Y" automation. No external account,
// no third-party sign-up, ever — this is the primary way a customer
// connects Signal Deck to how they already work, with zero developer and
// zero sign-up anywhere else. Point-and-click only.
function AutomationRulesPanel({ org, lookups, showToast }) {
  const [rules, setRules] = useState([]);
  const [label, setLabel] = useState("");
  const [eventType, setEventType] = useState("incident.created");
  const [categoryId, setCategoryId] = useState("");
  const [severityId, setSeverityId] = useState("");
  const [resolverGroupId, setResolverGroupId] = useState("");
  const [actionType, setActionType] = useState("email");
  const [emailTo, setEmailTo] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("automation_rules").select("*").order("created_at", { ascending: false });
    setRules(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createRule() {
    if (!label.trim()) { showToast("Give the rule a name"); return; }
    if (actionType === "email" && !emailTo.trim()) { showToast("Add an email address for this rule"); return; }
    const { error } = await supabase.from("automation_rules").insert({
      org_id: org.id, label, event_type: eventType,
      filter_category_id: categoryId || null, filter_severity_id: severityId || null,
      filter_resolver_group_id: resolverGroupId || null,
      action_type: actionType, action_email_to: actionType === "email" ? emailTo : null,
    });
    if (error) { showToast(error.message); return; }
    setLabel(""); setEmailTo(""); setCategoryId(""); setSeverityId(""); setResolverGroupId("");
    showToast("Automation rule created");
    await load();
  }

  async function toggleActive(rule) {
    await supabase.from("automation_rules").update({ active: !rule.active }).eq("id", rule.id);
    await load();
  }
  async function deleteRule(id) {
    await supabase.from("automation_rules").delete().eq("id", id);
    await load();
  }

  function describeRule(r) {
    const cat = lookups.categories.find((c) => c.id === r.filter_category_id);
    const sev = lookups.severities.find((s) => s.id === r.filter_severity_id);
    const grp = lookups.resolverGroups.find((g) => g.id === r.filter_resolver_group_id);
    let desc = `When ${r.event_type.replace("incident.", "")}`;
    if (cat) desc += `, category = ${cat.name}`;
    if (sev) desc += `, severity = ${sev.name}`;
    if (grp) desc += `, assigned to ${grp.name}`;
    if (r.action_type === "email") desc += ` → email ${r.action_email_to}`;
    else desc += ` → ${r.action_type === "slack" ? "Slack" : "Teams"}${grp ? ` (${grp.name}'s channel)` : " (org channel)"}`;
    return desc;
  }

  return (
    <Panel title="Automation rules — no account, no sign-up, ever" icon={Zap}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        The recommended way to connect Signal Deck to how you already work. One trigger, one action, one target — deliberately simple, not a watcher list everyone gets added to.
      </p>
      <div className="space-y-2 mb-4">
        {rules.map((r) => (
          <div key={r.id} className="text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <span style={{ color: COLORS.text }}>{r.label}</span>
              <div className="flex gap-2">
                <button onClick={() => toggleActive(r)} className="text-xs" style={{ color: r.active ? COLORS.teal : COLORS.faint }}>{r.active ? "Active" : "Paused"}</button>
                <button onClick={() => deleteRule(r.id)}><Trash2 size={13} color={COLORS.faint} /></button>
              </div>
            </div>
            <div className="text-xs mt-0.5" style={{ color: COLORS.muted }}>{describeRule(r)}</div>
            {r.last_triggered_at && <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>Last fired {new Date(r.last_triggered_at).toLocaleString()}</div>}
          </div>
        ))}
        {rules.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No automation rules yet.</p>}
      </div>

      <Field label="Rule name"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Alert Network team on Critical incidents" className="sd-in5" /></Field>
      <Field label="When">
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="sd-in5">
          <option value="incident.created">An incident is created</option>
          <option value="incident.resolved">An incident is resolved</option>
          <option value="incident.status_changed">An incident's status changes</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Only this category (optional)">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="sd-in5">
            <option value="">Any category</option>
            {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Only this severity (optional)">
          <select value={severityId} onChange={(e) => setSeverityId(e.target.value)} className="sd-in5">
            <option value="">Any severity</option>
            {lookups.severities.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Only assigned to this team (optional)">
        <select value={resolverGroupId} onChange={(e) => setResolverGroupId(e.target.value)} className="sd-in5">
          <option value="">Any team</option>
          {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Then">
        <select value={actionType} onChange={(e) => setActionType(e.target.value)} className="sd-in5">
          <option value="email">Send an email</option>
          <option value="slack">Post to Slack</option>
          <option value="teams">Post to Teams</option>
        </select>
      </Field>
      {actionType === "email" ? (
        <Field label="Send email to"><input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="you@yourcompany.co.za" className="sd-in5" /></Field>
      ) : (
        <p className="text-[11px] mb-3" style={{ color: COLORS.faint }}>
          Posts to the team's own {actionType === "slack" ? "Slack" : "Teams"} webhook if you picked a team above and it has one configured (Settings → Resolver Groups); otherwise falls back to the organisation-wide webhook.
        </p>
      )}
      <button onClick={createRule} className="sd-btn-p6">Create rule</button>
    </Panel>
  );
}

function TeamAssignmentPanel({ org, lookups, showToast }) {
  const [members, setMembers] = useState([]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_org_members");
    if (!error) setMembers(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function assign(userId, groupId) {
    const { error } = await supabase.rpc("set_member_resolver_group", { target_user_id: userId, target_group_id: groupId || null });
    if (error) { showToast(error.message); return; }
    showToast("Team updated");
    await load();
  }

  async function setWhatsapp(userId, number) {
    const { error } = await supabase.rpc("set_member_whatsapp_number", { target_user_id: userId, number: number || null });
    if (error) { showToast(error.message); return; }
    await load();
  }

  return (
    <Panel title="Team assignment" icon={Users}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Which resolver group each person is on, and their WhatsApp number for escalation (optional — only needed if a WhatsApp escalation policy is used, and each per-message send has a small real cost, disclosed where policies are configured).
      </p>
      <div className="space-y-2">
        {members.map((m) => (
          <div key={m.user_id} className="text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="min-w-0">
                <div className="truncate" style={{ color: COLORS.text }}>{m.email}</div>
                <div className="text-[11px]" style={{ color: COLORS.faint }}>{m.role}</div>
              </div>
              <select value={m.resolver_group_id || ""} onChange={(e) => assign(m.user_id, e.target.value)} className="sd-in5" style={{ width: 140 }}>
                <option value="">No team</option>
                {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <input defaultValue={m.whatsapp_number || ""} onBlur={(e) => setWhatsapp(m.user_id, e.target.value)}
              placeholder="WhatsApp number, e.g. +27821234567" className="sd-in5 w-full" />
          </div>
        ))}
        {members.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No team members found.</p>}
      </div>
    </Panel>
  );
}

/* ============================ PREVENTATIVES TRACKER ============================ */
// This is the actual answer to "how do we track and close preventatives out
// of RCAs" — every preventative action, across every incident, in one
// place, with overdue ones surfaced instead of buried inside individual
// tickets nobody reopens to check.
function PreventativesTracker({ org, lookups, incidents, showToast, onOpenIncident, onOpenProblem }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("open");
  const WINDOW_DAYS = 30;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("preventative_actions")
      .select("*, incidents(display_id, title), resolver_groups(name), rca_categories(id, name), problems(display_id, title)")
      .order("due_date", { ascending: true, nullsFirst: false });
    setItems(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setStatus(id, status) {
    await supabase.from("preventative_actions").update({ status, closed_at: status === "done" ? new Date().toISOString() : null }).eq("id", id);
    showToast(status === "done" ? "Marked done" : "Updated");
    await load();
  }

  const now = Date.now();
  const isOverdue = (p) => p.status === "open" && p.due_date && new Date(p.due_date).getTime() < now;

  // The actual "did this work" measurement: incidents of the same root-cause
  // category, in the window before this action was closed, versus the same
  // window after. Rates (per day) rather than raw counts, since the "after"
  // window is often shorter than 30 days if the fix was closed recently.
  function computeEffectiveness(p) {
    if (!p.closed_at || !p.rca_categories?.id) return null;
    const closedTime = new Date(p.closed_at).getTime();
    const beforeStart = closedTime - WINDOW_DAYS * 86400000;
    const daysElapsedAfter = Math.min(WINDOW_DAYS, Math.floor((now - closedTime) / 86400000));

    const beforeCount = incidents.filter((i) =>
      i.rca_category?.id === p.rca_categories.id &&
      new Date(i.created_at).getTime() >= beforeStart && new Date(i.created_at).getTime() < closedTime
    ).length;
    const afterCount = daysElapsedAfter > 0 ? incidents.filter((i) =>
      i.rca_category?.id === p.rca_categories.id &&
      new Date(i.created_at).getTime() >= closedTime && new Date(i.created_at).getTime() <= closedTime + daysElapsedAfter * 86400000
    ).length : 0;

    const beforeRate = beforeCount / WINDOW_DAYS;
    const afterRate = daysElapsedAfter > 0 ? afterCount / daysElapsedAfter : null;
    const pctChange = (afterRate !== null && beforeRate > 0) ? Math.round(((beforeRate - afterRate) / beforeRate) * 100) : null;

    return { beforeCount, afterCount, daysElapsedAfter, pctChange, tooEarly: daysElapsedAfter < 7 };
  }

  let list = items;
  if (filter === "open") list = items.filter((p) => p.status === "open" || p.status === "in_progress");
  if (filter === "overdue") list = items.filter(isOverdue);
  if (filter === "done") list = items.filter((p) => p.status === "done" || p.status === "wont_fix");
  if (filter === "effectiveness") list = items.filter((p) => p.status === "done" && p.rca_categories?.id);

  const openCount = items.filter((p) => p.status === "open" || p.status === "in_progress").length;
  const overdueCount = items.filter(isOverdue).length;
  const doneCount = items.filter((p) => p.status === "done").length;

  const effectivenessSummary = useMemo(() => {
    const measured = items.filter((p) => p.status === "done" && p.rca_categories?.id).map(computeEffectiveness).filter((e) => e && !e.tooEarly && e.pctChange !== null);
    const worked = measured.filter((e) => e.pctChange >= 20).length;
    const noChange = measured.filter((e) => e.pctChange < 20 && e.pctChange > -20).length;
    const worse = measured.filter((e) => e.pctChange <= -20).length;
    return { worked, noChange, worse, total: measured.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, incidents]);

  return (
    <div className="pb-6">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={ShieldCheck} label="Open" value={openCount} color={COLORS.blue} />
        <StatCard icon={AlertTriangle} label="Overdue" value={overdueCount} color={COLORS.red} />
        <StatCard icon={CheckCircle2} label="Closed out" value={doneCount} color={COLORS.teal} />
      </div>

      <Panel title="Are our preventatives actually working?" icon={TrendingUp}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          Compares incidents in the same root-cause category for {WINDOW_DAYS} days before a fix was closed versus the days since. Based on {effectivenessSummary.total} closed action{effectivenessSummary.total !== 1 ? "s" : ""} with enough time elapsed to measure.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-2.5 rounded-lg" style={{ background: COLORS.teal + "1c", border: `1px solid ${COLORS.teal}44` }}>
            <div className="sd-display text-xl font-semibold" style={{ color: COLORS.teal }}>{effectivenessSummary.worked}</div>
            <div className="text-[11px]" style={{ color: COLORS.muted }}>Confirmed working</div>
          </div>
          <div className="text-center p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="sd-display text-xl font-semibold" style={{ color: COLORS.muted }}>{effectivenessSummary.noChange}</div>
            <div className="text-[11px]" style={{ color: COLORS.muted }}>No real change</div>
          </div>
          <div className="text-center p-2.5 rounded-lg" style={{ background: COLORS.red + "1c", border: `1px solid ${COLORS.red}44` }}>
            <div className="sd-display text-xl font-semibold" style={{ color: COLORS.red }}>{effectivenessSummary.worse}</div>
            <div className="text-[11px]" style={{ color: COLORS.muted }}>Got worse</div>
          </div>
        </div>
      </Panel>

      <CSITrendsPanel org={org} lookups={lookups} />

      <div className="flex gap-1.5 mb-3 flex-wrap">
        {["open", "overdue", "done", "effectiveness", "all"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="px-3 py-1.5 rounded-full text-xs font-medium capitalize"
            style={{ background: filter === f ? COLORS.amber + "22" : COLORS.surface, color: filter === f ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
            {f}
          </button>
        ))}
      </div>

      <div className="rounded-xl divide-y" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        {list.map((p) => {
          const eff = filter === "effectiveness" || p.status === "done" ? computeEffectiveness(p) : null;
          return (
            <div key={p.id} className="p-3.5" style={{ opacity: p.status === "done" || p.status === "wont_fix" ? 0.85 : 1 }}>
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <span className="text-sm" style={{ color: COLORS.text }}>{p.description}</span>
                <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} className="text-[11px] px-1.5 py-1 rounded shrink-0"
                  style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, color: p.status === "done" ? COLORS.teal : isOverdue(p) ? COLORS.red : COLORS.amber }}>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                  <option value="wont_fix">Won't fix</option>
                </select>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[11px] mb-2" style={{ color: COLORS.faint }}>
                {p.incidents && (
                  <button onClick={() => onOpenIncident(p.incident_id)} className="sd-mono underline" style={{ color: COLORS.muted }}>
                    {p.incidents.display_id}
                  </button>
                )}
                {p.problems && (
                  <button onClick={() => onOpenProblem?.(p.problem_id)} className="sd-mono underline" style={{ color: COLORS.blue }}>from Problem {p.problems.display_id}</button>
                )}
                {p.rca_categories?.name && <span>· {p.rca_categories.name}</span>}
                {p.resolver_groups?.name && <span>· {p.resolver_groups.name}</span>}
                {p.due_date && <span style={{ color: isOverdue(p) ? COLORS.red : COLORS.faint }}>· due {new Date(p.due_date).toLocaleDateString()}{isOverdue(p) ? " (overdue)" : ""}</span>}
              </div>

              {eff && (
                <div className="rounded-lg p-2.5" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
                  {!p.rca_categories?.id ? (
                    <p className="text-[11px]" style={{ color: COLORS.faint }}>No root-cause category linked — can't measure effectiveness for this one.</p>
                  ) : eff.tooEarly ? (
                    <p className="text-[11px]" style={{ color: COLORS.faint }}>Closed {eff.daysElapsedAfter} day{eff.daysElapsedAfter !== 1 ? "s" : ""} ago — too early to tell yet. Check back after a week.</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px]" style={{ color: COLORS.muted }}>
                          {eff.beforeCount} incident{eff.beforeCount !== 1 ? "s" : ""} in the {WINDOW_DAYS} days before → {eff.afterCount} in the {eff.daysElapsedAfter} days since
                        </span>
                        {eff.pctChange !== null && (
                          <span className="text-xs font-semibold" style={{ color: eff.pctChange >= 20 ? COLORS.teal : eff.pctChange <= -20 ? COLORS.red : COLORS.amber }}>
                            {eff.pctChange > 0 ? "↓" : eff.pctChange < 0 ? "↑" : "→"} {Math.abs(eff.pctChange)}%
                          </span>
                        )}
                      </div>
                      <ResponsiveContainer width="100%" height={60}>
                        <BarChart data={[{ name: "Before", count: eff.beforeCount }, { name: "After", count: eff.afterCount }]} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                          <XAxis type="number" hide />
                          <YAxis type="category" dataKey="name" tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={45} />
                          <Bar dataKey="count" fill={eff.pctChange >= 20 ? COLORS.teal : eff.pctChange <= -20 ? COLORS.red : COLORS.amber} radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {list.length === 0 && <div className="p-8 text-center text-sm" style={{ color: COLORS.muted }}>Nothing here.</div>}
      </div>
    </div>
  );
}

/* ============================== CUSTOM DASHBOARDS ============================= */
// Self-service reporting: pick a metric, a way to group it, optional
// filters, a chart type — save it — arrange saved charts into as many named
// dashboards as wanted. Deliberately not a fixed gadget catalog.

const CHART_COLORS = [COLORS.amber, COLORS.teal, COLORS.blue, COLORS.red, "#B57EDC", "#4FC3F7", "#FFB74D"];

function groupKeyFor(incident, groupBy) {
  switch (groupBy) {
    case "category": return incident.category?.name || "Uncategorised";
    case "severity": return incident.severity?.name || "Unknown";
    case "status": return incident.status?.name || "Unknown";
    case "rca_category": return incident.rca_category?.name || "Not yet assigned";
    case "resolver_group": return incident.incident_assignments?.[0]?.resolver_groups?.name || "Unassigned";
    case "source": return incident.source;
    case "month": return new Date(incident.created_at).toLocaleDateString("en-ZA", { year: "numeric", month: "short" });
    case "week": {
      const d = new Date(incident.created_at);
      const firstDay = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil((((d - firstDay) / 86400000) + firstDay.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${weekNum}`;
    }
    default: return "All";
  }
}

function computeChartData(chart, incidents) {
  let data = incidents;
  if (chart.filter_status === "open") data = data.filter((i) => !i.resolved_at);
  if (chart.filter_status === "resolved") data = data.filter((i) => i.resolved_at);
  if (chart.filter_range_days) {
    const cutoff = Date.now() - chart.filter_range_days * 86400000;
    data = data.filter((i) => new Date(i.created_at).getTime() >= cutoff);
  }
  if (chart.filter_category_id) data = data.filter((i) => i.category?.id === chart.filter_category_id);
  if (chart.filter_severity_id) data = data.filter((i) => i.severity?.id === chart.filter_severity_id);
  if (chart.filter_resolver_group_id) data = data.filter((i) => (i.incident_assignments || []).some((a) => a.resolver_group_id === chart.filter_resolver_group_id));

  const groups = {};
  data.forEach((i) => {
    const key = groupKeyFor(i, chart.group_by);
    if (!groups[key]) groups[key] = [];
    groups[key].push(i);
  });

  let rows = Object.entries(groups).map(([name, items]) => {
    let value = 0;
    if (chart.metric === "count") {
      value = items.length;
    } else if (chart.metric === "avg_resolution_hours") {
      const resolved = items.filter((i) => i.resolved_at);
      value = resolved.length
        ? Math.round((resolved.reduce((sum, i) => sum + (new Date(i.resolved_at) - new Date(i.created_at)), 0) / resolved.length / 3600000) * 10) / 10
        : 0;
    } else if (chart.metric === "breach_rate") {
      const breached = items.filter((i) => {
        const deadline = new Date(i.created_at).getTime() + i.sla_minutes * 60000;
        const end = i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now();
        return end > deadline;
      });
      value = items.length ? Math.round((breached.length / items.length) * 100) : 0;
    }
    return { name, value };
  });

  if (chart.group_by === "month" || chart.group_by === "week") {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => b.value - a.value);
  }
  return rows;
}

const METRIC_LABELS = { count: "Number of incidents", avg_resolution_hours: "Average resolution time (hours)", breach_rate: "SLA breach rate (%)" };
const GROUP_LABELS = { category: "Category", severity: "Severity", status: "Status", rca_category: "Root cause", resolver_group: "Resolver group", source: "Source", month: "Month", week: "Week" };

function ChartRenderer({ chart, incidents, height = 220 }) {
  const data = useMemo(() => computeChartData(chart, incidents), [chart, incidents]);
  if (data.length === 0) return <p className="text-sm py-8 text-center" style={{ color: COLORS.muted }}>No data matches this chart's filters yet.</p>;

  if (chart.chart_type === "pie") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={height * 0.18} outerRadius={height * 0.36} paddingAngle={2}>
            {data.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (chart.chart_type === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
          <XAxis dataKey="name" tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={{ stroke: COLORS.border }} />
          <YAxis tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={false} />
          <Tooltip contentStyle={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12 }} />
          <Line type="monotone" dataKey="value" stroke={COLORS.amber} strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
        <XAxis dataKey="name" tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={{ stroke: COLORS.border }} />
        <YAxis tick={{ fill: COLORS.faint, fontSize: 10 }} axisLine={false} />
        <Tooltip contentStyle={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12 }} />
        <Bar dataKey="value" fill={COLORS.amber} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartBuilderForm({ org, lookups, incidents, onSaved, onCancel, editingChart }) {
  const [name, setName] = useState(editingChart?.name || "");
  const [chartType, setChartType] = useState(editingChart?.chart_type || "bar");
  const [metric, setMetric] = useState(editingChart?.metric || "count");
  const [groupBy, setGroupBy] = useState(editingChart?.group_by || "category");
  const [filterStatus, setFilterStatus] = useState(editingChart?.filter_status || "");
  const [filterRange, setFilterRange] = useState(editingChart?.filter_range_days || "");
  const [filterCategoryId, setFilterCategoryId] = useState(editingChart?.filter_category_id || "");
  const [filterSeverityId, setFilterSeverityId] = useState(editingChart?.filter_severity_id || "");
  const [filterResolverGroupId, setFilterResolverGroupId] = useState(editingChart?.filter_resolver_group_id || "");

  const previewChart = {
    chart_type: chartType, metric, group_by: groupBy,
    filter_status: filterStatus || null, filter_range_days: filterRange ? +filterRange : null,
    filter_category_id: filterCategoryId || null, filter_severity_id: filterSeverityId || null,
    filter_resolver_group_id: filterResolverGroupId || null,
  };

  async function save() {
    if (!name.trim()) return;
    const payload = {
      org_id: org.id, name, chart_type: chartType, metric, group_by: groupBy,
      filter_status: filterStatus || null, filter_range_days: filterRange ? +filterRange : null,
      filter_category_id: filterCategoryId || null, filter_severity_id: filterSeverityId || null,
      filter_resolver_group_id: filterResolverGroupId || null,
    };
    if (editingChart) {
      await supabase.from("custom_charts").update(payload).eq("id", editingChart.id);
    } else {
      await supabase.from("custom_charts").insert(payload);
    }
    onSaved();
  }

  return (
    <div className="rounded-lg p-3 mb-3" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
      <Field label="Chart name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Incidents by category, last 90 days" className="sd-in5" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Chart type">
          <select value={chartType} onChange={(e) => setChartType(e.target.value)} className="sd-in5">
            <option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option>
          </select>
        </Field>
        <Field label="Measure">
          <select value={metric} onChange={(e) => setMetric(e.target.value)} className="sd-in5">
            {Object.entries(METRIC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Group by">
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="sd-in5">
          {Object.entries(GROUP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Only (optional)">
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="sd-in5">
            <option value="">Open + resolved</option><option value="open">Open only</option><option value="resolved">Resolved only</option>
          </select>
        </Field>
        <Field label="Time range">
          <select value={filterRange} onChange={(e) => setFilterRange(e.target.value)} className="sd-in5">
            <option value="">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category filter (optional)">
          <select value={filterCategoryId} onChange={(e) => setFilterCategoryId(e.target.value)} className="sd-in5">
            <option value="">Any</option>
            {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Severity filter (optional)">
          <select value={filterSeverityId} onChange={(e) => setFilterSeverityId(e.target.value)} className="sd-in5">
            <option value="">Any</option>
            {lookups.severities.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Team filter (optional)">
        <select value={filterResolverGroupId} onChange={(e) => setFilterResolverGroupId(e.target.value)} className="sd-in5">
          <option value="">Any team</option>
          {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Field>

      <p className="text-[11px] mb-1.5" style={{ color: COLORS.faint }}>Live preview</p>
      <div className="mb-3 rounded-lg p-2" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <ChartRenderer chart={previewChart} incidents={incidents} height={160} />
      </div>

      <div className="flex gap-2">
        <button onClick={save} disabled={!name.trim()} className="sd-btn-p6">{editingChart ? "Save changes" : "Save chart"}</button>
        <button onClick={onCancel} className="sd-btn-g">Cancel</button>
      </div>
    </div>
  );
}

function CustomDashboards({ org, lookups, incidents, showToast }) {
  const [charts, setCharts] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [activeDashboardId, setActiveDashboardId] = useState(null);
  const [dashboardCharts, setDashboardCharts] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingChart, setEditingChart] = useState(null);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [addChartId, setAddChartId] = useState("");
  const [addWidth, setAddWidth] = useState("half");

  const loadCharts = useCallback(async () => {
    const { data } = await supabase.from("custom_charts").select("*").order("created_at", { ascending: false });
    setCharts(data || []);
  }, []);
  const loadDashboards = useCallback(async () => {
    const { data } = await supabase.from("custom_dashboards").select("*").order("sort_order");
    setDashboards(data || []);
    if (data && data.length && !activeDashboardId) setActiveDashboardId(data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadDashboardCharts = useCallback(async () => {
    if (!activeDashboardId) { setDashboardCharts([]); return; }
    const { data } = await supabase.from("custom_dashboard_charts").select("*, custom_charts(*)").eq("dashboard_id", activeDashboardId).order("sort_order");
    setDashboardCharts(data || []);
  }, [activeDashboardId]);

  useEffect(() => { loadCharts(); loadDashboards(); }, [loadCharts, loadDashboards]);
  useEffect(() => { loadDashboardCharts(); }, [loadDashboardCharts]);

  async function createDashboard() {
    if (!newDashboardName.trim()) return;
    const { data, error } = await supabase.from("custom_dashboards").insert({ org_id: org.id, name: newDashboardName, sort_order: dashboards.length }).select().single();
    if (error) { showToast(error.message); return; }
    setNewDashboardName("");
    await loadDashboards();
    setActiveDashboardId(data.id);
  }

  async function deleteDashboard(id) {
    await supabase.from("custom_dashboards").delete().eq("id", id);
    setActiveDashboardId(null);
    await loadDashboards();
  }

  async function deleteChart(id) {
    await supabase.from("custom_charts").delete().eq("id", id);
    await loadCharts();
    await loadDashboardCharts();
  }

  async function addChartToDashboard() {
    if (!addChartId || !activeDashboardId) return;
    await supabase.from("custom_dashboard_charts").insert({
      org_id: org.id, dashboard_id: activeDashboardId, chart_id: addChartId, width: addWidth, sort_order: dashboardCharts.length,
    });
    setAddChartId("");
    await loadDashboardCharts();
  }

  async function removeFromDashboard(id) {
    await supabase.from("custom_dashboard_charts").delete().eq("id", id);
    await loadDashboardCharts();
  }

  async function move(entry, direction) {
    const idx = dashboardCharts.findIndex((d) => d.id === entry.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= dashboardCharts.length) return;
    const a = dashboardCharts[idx], b = dashboardCharts[swapIdx];
    await supabase.from("custom_dashboard_charts").update({ sort_order: swapIdx }).eq("id", a.id);
    await supabase.from("custom_dashboard_charts").update({ sort_order: idx }).eq("id", b.id);
    await loadDashboardCharts();
  }

  async function toggleWidth(entry) {
    await supabase.from("custom_dashboard_charts").update({ width: entry.width === "half" ? "full" : "half" }).eq("id", entry.id);
    await loadDashboardCharts();
  }

  const chartsNotOnDashboard = charts.filter((c) => !dashboardCharts.some((dc) => dc.chart_id === c.id));

  return (
    <div className="pb-6">
      <Panel title="Your dashboards" icon={BarChart3}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {dashboards.map((d) => (
            <button key={d.id} onClick={() => setActiveDashboardId(d.id)} className="px-3 py-1.5 rounded-full text-xs font-medium"
              style={{ background: activeDashboardId === d.id ? COLORS.amber + "22" : COLORS.surfaceHi, color: activeDashboardId === d.id ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
              {d.name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newDashboardName} onChange={(e) => setNewDashboardName(e.target.value)} placeholder="New dashboard name" className="sd-in5 flex-1" />
          <button onClick={createDashboard} className="sd-btn-p6">Create</button>
          {activeDashboardId && <button onClick={() => deleteDashboard(activeDashboardId)} className="sd-btn-g" style={{ color: COLORS.red }}>Delete this one</button>}
        </div>
      </Panel>

      {activeDashboardId && (
        <>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            {dashboardCharts.map((entry, idx) => (
              <div key={entry.id} className={entry.width === "full" ? "md:col-span-2" : ""}>
                <Panel title={entry.custom_charts.name} icon={BarChart3}>
                  <ChartRenderer chart={entry.custom_charts} incidents={incidents} />
                  <div className="flex items-center gap-3 mt-2 text-[11px]" style={{ color: COLORS.faint }}>
                    <button onClick={() => move(entry, -1)} disabled={idx === 0}>↑ Move up</button>
                    <button onClick={() => move(entry, 1)} disabled={idx === dashboardCharts.length - 1}>↓ Move down</button>
                    <button onClick={() => toggleWidth(entry)}>{entry.width === "half" ? "Widen" : "Narrow"}</button>
                    <button onClick={() => removeFromDashboard(entry.id)} style={{ color: COLORS.red }}>Remove</button>
                  </div>
                </Panel>
              </div>
            ))}
          </div>
          {dashboardCharts.length === 0 && <p className="text-sm mb-4" style={{ color: COLORS.muted }}>No charts on this dashboard yet — add one below.</p>}

          <Panel title="Add a chart to this dashboard" icon={Plus}>
            <div className="flex gap-2 flex-wrap items-center">
              <select value={addChartId} onChange={(e) => setAddChartId(e.target.value)} className="sd-in5 flex-1" style={{ minWidth: 160 }}>
                <option value="">Choose a saved chart…</option>
                {chartsNotOnDashboard.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={addWidth} onChange={(e) => setAddWidth(e.target.value)} className="sd-in5" style={{ width: 100 }}>
                <option value="half">Half width</option><option value="full">Full width</option>
              </select>
              <button onClick={addChartToDashboard} disabled={!addChartId} className="sd-btn-p6">Add</button>
            </div>
          </Panel>
        </>
      )}

      <Panel title="Chart library" icon={GripVertical}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Every chart you've built, reusable across any dashboard.</p>
        <div className="space-y-2 mb-3">
          {charts.map((c) => (
            <div key={c.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div>
                <div style={{ color: COLORS.text }}>{c.name}</div>
                <div className="text-[11px]" style={{ color: COLORS.faint }}>{c.chart_type} · {METRIC_LABELS[c.metric]} by {GROUP_LABELS[c.group_by]}</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setEditingChart(c); setShowBuilder(true); }} className="text-xs" style={{ color: COLORS.amber }}>Edit</button>
                <button onClick={() => deleteChart(c.id)}><Trash2 size={13} color={COLORS.faint} /></button>
              </div>
            </div>
          ))}
          {charts.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No charts yet — build your first one below.</p>}
        </div>

        {showBuilder ? (
          <ChartBuilderForm org={org} lookups={lookups} incidents={incidents} editingChart={editingChart}
            onSaved={async () => { setShowBuilder(false); setEditingChart(null); await loadCharts(); await loadDashboardCharts(); showToast("Chart saved"); }}
            onCancel={() => { setShowBuilder(false); setEditingChart(null); }} />
        ) : (
          <button onClick={() => setShowBuilder(true)} className="sd-btn-p6">+ Build a new chart</button>
        )}
      </Panel>
    </div>
  );
}

/* ================================= ON-CALL PANEL =============================== */
// The free alternative to PagerDuty: who's on call for each team, and one
// escalation tier if nobody acknowledges in time. Explicit date ranges
// instead of a recurrence engine — kept understandable at a glance.
function OnCallPanel({ org, lookups, showToast }) {
  const [members, setMembers] = useState([]);
  const [rotations, setRotations] = useState([]);
  const [policies, setPolicies] = useState([]);

  const [rotGroupId, setRotGroupId] = useState("");
  const [rotUserId, setRotUserId] = useState("");
  const [rotStart, setRotStart] = useState("");
  const [rotEnd, setRotEnd] = useState("");

  const [polGroupId, setPolGroupId] = useState("");
  const [polSeverityId, setPolSeverityId] = useState("");
  const [polMinutes, setPolMinutes] = useState(15);
  const [polEscalateGroupId, setPolEscalateGroupId] = useState("");
  const [polEscalateEmail, setPolEscalateEmail] = useState("");
  const [polChannel, setPolChannel] = useState("email");
  const [polEscalateWhatsapp, setPolEscalateWhatsapp] = useState("");

  const load = useCallback(async () => {
    const [m, r, p] = await Promise.all([
      supabase.rpc("list_org_members"),
      supabase.from("on_call_rotations").select("*, resolver_groups(name)").order("starts_at", { ascending: false }),
      supabase.from("escalation_policies").select("*, resolver_groups!escalation_policies_resolver_group_id_fkey(name), severities(name)").order("created_at", { ascending: false }),
    ]);
    setMembers(m.data || []);
    setRotations(r.data || []);
    setPolicies(p.data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addRotation() {
    if (!rotGroupId || !rotUserId || !rotStart || !rotEnd) { showToast("Fill in team, person, and both dates"); return; }
    const { error } = await supabase.from("on_call_rotations").insert({
      org_id: org.id, resolver_group_id: rotGroupId, user_id: rotUserId,
      starts_at: new Date(rotStart).toISOString(), ends_at: new Date(rotEnd).toISOString(),
    });
    if (error) { showToast(error.message); return; }
    setRotGroupId(""); setRotUserId(""); setRotStart(""); setRotEnd("");
    showToast("On-call shift added");
    await load();
  }
  async function deleteRotation(id) {
    await supabase.from("on_call_rotations").delete().eq("id", id);
    await load();
  }

  async function addPolicy() {
    if (!polGroupId) { showToast("Choose which team this policy watches"); return; }
    if (!polEscalateGroupId && polChannel === "email" && !polEscalateEmail.trim()) { showToast("Choose an escalation target — a team or an email"); return; }
    if (!polEscalateGroupId && polChannel === "whatsapp" && !polEscalateWhatsapp.trim()) { showToast("Choose an escalation target — a team or a WhatsApp number"); return; }
    const { error } = await supabase.from("escalation_policies").insert({
      org_id: org.id, resolver_group_id: polGroupId, severity_id: polSeverityId || null,
      minutes_before_escalation: +polMinutes, notify_channel: polChannel,
      escalate_to_resolver_group_id: polEscalateGroupId || null,
      escalate_to_email: (!polEscalateGroupId && polChannel === "email") ? polEscalateEmail : null,
      escalate_to_whatsapp_number: (!polEscalateGroupId && polChannel === "whatsapp") ? polEscalateWhatsapp : null,
    });
    if (error) { showToast(error.message); return; }
    setPolGroupId(""); setPolSeverityId(""); setPolMinutes(15); setPolEscalateGroupId(""); setPolEscalateEmail(""); setPolEscalateWhatsapp("");
    showToast("Escalation policy created");
    await load();
  }
  async function togglePolicy(p) {
    await supabase.from("escalation_policies").update({ active: !p.active }).eq("id", p.id);
    await load();
  }
  async function deletePolicy(id) {
    await supabase.from("escalation_policies").delete().eq("id", id);
    await load();
  }

  return (
    <>
      <Panel title="On-call schedule" icon={Bell}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Who's on call for each team, and when. No recurrence rules to learn — just add shifts as date ranges.</p>
        <div className="space-y-2 mb-4">
          {rotations.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div>
                <span style={{ color: COLORS.text }}>{r.resolver_groups?.name}</span>
                <span className="text-xs ml-2" style={{ color: COLORS.faint }}>{new Date(r.starts_at).toLocaleString()} → {new Date(r.ends_at).toLocaleString()}</span>
              </div>
              <button onClick={() => deleteRotation(r.id)}><Trash2 size={13} color={COLORS.faint} /></button>
            </div>
          ))}
          {rotations.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No on-call shifts scheduled yet.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Team">
            <select value={rotGroupId} onChange={(e) => setRotGroupId(e.target.value)} className="sd-in5">
              <option value="">Choose…</option>
              {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="Person">
            <select value={rotUserId} onChange={(e) => setRotUserId(e.target.value)} className="sd-in5">
              <option value="">Choose…</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts"><input type="datetime-local" value={rotStart} onChange={(e) => setRotStart(e.target.value)} className="sd-in5" /></Field>
          <Field label="Ends"><input type="datetime-local" value={rotEnd} onChange={(e) => setRotEnd(e.target.value)} className="sd-in5" /></Field>
        </div>
        <button onClick={addRotation} className="sd-btn-p6">Add shift</button>
      </Panel>

      <Panel title="Escalation policies" icon={AlertTriangle}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          If an incident for a team isn't acknowledged in time, escalate once — to another team's on-call person, or a fixed email. Free (email/Slack/Teams), no per-message cost, unlike SMS/voice paging.
        </p>
        <div className="space-y-2 mb-4">
          {policies.map((p) => (
            <div key={p.id} className="text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.text }}>{p.resolver_groups?.name}{p.severities?.name ? ` · ${p.severities.name}` : ""}</span>
                <div className="flex gap-2">
                  <button onClick={() => togglePolicy(p)} className="text-xs" style={{ color: p.active ? COLORS.teal : COLORS.faint }}>{p.active ? "Active" : "Paused"}</button>
                  <button onClick={() => deletePolicy(p.id)}><Trash2 size={13} color={COLORS.faint} /></button>
                </div>
              </div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.muted }}>
                Unacknowledged after {p.minutes_before_escalation} min → {p.notify_channel === "whatsapp" ? "WhatsApp" : "Email"} to {p.escalate_to_email || p.escalate_to_whatsapp_number || "on-call for " + (lookups.resolverGroups.find((g) => g.id === p.escalate_to_resolver_group_id)?.name || "—")}
              </div>
            </div>
          ))}
          {policies.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No escalation policies yet.</p>}
        </div>
        <Field label="Watch this team">
          <select value={polGroupId} onChange={(e) => setPolGroupId(e.target.value)} className="sd-in5">
            <option value="">Choose…</option>
            {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Only this severity (optional)">
            <select value={polSeverityId} onChange={(e) => setPolSeverityId(e.target.value)} className="sd-in5">
              <option value="">Any severity</option>
              {lookups.severities.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Minutes before escalating">
            <input type="number" min="1" value={polMinutes} onChange={(e) => setPolMinutes(e.target.value)} className="sd-in5" />
          </Field>
        </div>
        <Field label="Notify by">
          <select value={polChannel} onChange={(e) => setPolChannel(e.target.value)} className="sd-in5">
            <option value="email">Email (free)</option>
            <option value="whatsapp">WhatsApp (small real cost per message — see below)</option>
          </select>
        </Field>
        {polChannel === "whatsapp" && (
          <div className="text-[11px] mb-3 p-2 rounded-lg" style={{ background: COLORS.amber + "18", border: `1px solid ${COLORS.amber}44`, color: COLORS.amber }}>
            Each WhatsApp escalation costs a small real amount charged to your Meta account — this isn't free the way email is. Requires WhatsApp set up in Settings (see setup guide) and each person's WhatsApp number saved under Team assignment.
          </div>
        )}
        <Field label="Escalate to this team's on-call (or set a fixed target below)">
          <select value={polEscalateGroupId} onChange={(e) => setPolEscalateGroupId(e.target.value)} className="sd-in5">
            <option value="">— use a fixed target below —</option>
            {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        {!polEscalateGroupId && polChannel === "email" && (
          <Field label="Escalate to this email"><input value={polEscalateEmail} onChange={(e) => setPolEscalateEmail(e.target.value)} placeholder="manager@yourcompany.co.za" className="sd-in5" /></Field>
        )}
        {!polEscalateGroupId && polChannel === "whatsapp" && (
          <Field label="Escalate to this WhatsApp number"><input value={polEscalateWhatsapp} onChange={(e) => setPolEscalateWhatsapp(e.target.value)} placeholder="+27821234567" className="sd-in5" /></Field>
        )}
        <button onClick={addPolicy} className="sd-btn-p6">Create escalation policy</button>
      </Panel>
    </>
  );
}

/* ============================== CUSTOM FIELD INPUT ============================ */
// Shared rendering for a custom field, used both at incident creation and in
// the incident detail view — one place that knows how to render each type.
function CustomFieldInput({ field, value, onChange }) {
  return (
    <Field label={field.label + (field.required ? " *" : "")}>
      {field.field_type === "text" && <input value={value} onChange={(e) => onChange(e.target.value)} className="sd-in" />}
      {field.field_type === "number" && <input type="number" value={value} onChange={(e) => onChange(e.target.value)} className="sd-in" />}
      {field.field_type === "date" && <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="sd-in" />}
      {field.field_type === "checkbox" && (
        <input type="checkbox" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
      )}
      {field.field_type === "select" && (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="sd-in">
          <option value="">Choose…</option>
          {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
    </Field>
  );
}

/* ============================== CUSTOM FIELDS PANEL (Settings) ============================ */
function CustomFieldsPanel({ org, lookups, onLookupsChanged, showToast }) {
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [nlRequest, setNlRequest] = useState("");
  const [proposing, setProposing] = useState(false);

  // Translates a plain-language request into the SAME form fields below —
  // never inserts anything itself. The human still reviews and clicks Add,
  // the exact same confirmation step as filling the form in by hand.
  async function proposeFromText() {
    if (!nlRequest.trim()) return;
    setProposing(true);
    const { data, error } = await supabase.functions.invoke("propose-config", { body: { request_text: nlRequest } });
    setProposing(false);
    if (error || !data?.proposal) { showToast("Couldn't work that out — try filling in the form directly"); return; }
    const p = data.proposal;
    setLabel(p.label || "");
    setFieldType(["text", "number", "date", "select", "checkbox"].includes(p.field_type) ? p.field_type : "text");
    setOptionsText((p.options || []).join(", "));
    setNlRequest("");
    showToast("Proposed below — review, then click Add");
  }

  async function addField() {
    if (!label.trim()) { showToast("Give the field a name"); return; }
    const options = fieldType === "select" ? optionsText.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const { error } = await supabase.from("custom_fields").insert({
      org_id: org.id, label, field_type: fieldType, options, required,
      sort_order: (lookups.customFields || []).length,
    });
    if (error) { showToast(error.message); return; }
    setLabel(""); setFieldType("text"); setOptionsText(""); setRequired(false);
    showToast("Custom field added");
    await onLookupsChanged();
  }
  async function deleteField(id) {
    await supabase.from("custom_fields").delete().eq("id", id);
    await onLookupsChanged();
  }

  return (
    <Panel title="Custom fields" icon={ScanEye}>
      <p className="text-sm mb-2" style={{ color: COLORS.muted }}>
        Add your own fields to incidents — asset tag, cost centre, client reference, whatever your business needs. No code, no developer.
      </p>
      <div className="flex gap-2 mb-3">
        <input value={nlRequest} onChange={(e) => setNlRequest(e.target.value)} placeholder="Or describe it — e.g. 'a dropdown for which supplier this affects'" className="sd-in5 flex-1" />
        <button onClick={proposeFromText} disabled={proposing} className="sd-btn-g text-xs">{proposing ? "…" : "Propose"}</button>
      </div>

      <div className="text-[11px] mb-3 p-2 rounded-lg" style={{ background: COLORS.red + "18", border: `1px solid ${COLORS.red}44`, color: COLORS.red }}>
        Don't use custom fields to store names, phone numbers, ID numbers, or other personal information — they're visible the same way every other incident field is. Turn on the Identity Module (Privacy tab) for that instead, which has proper consent tracking. Text entered here is automatically screened for common personal-identifier patterns, but that's a safety net, not a substitute for using the right field for the job.
      </div>
      <div className="space-y-2 mb-4">
        {(lookups.customFields || []).map((f) => (
          <div key={f.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div>
              <span style={{ color: COLORS.text }}>{f.label}</span>
              <span className="text-[11px] ml-2" style={{ color: COLORS.faint }}>{f.field_type}{f.required ? " · required" : ""}</span>
            </div>
            <button onClick={() => deleteField(f.id)}><Trash2 size={13} color={COLORS.faint} /></button>
          </div>
        ))}
        {(lookups.customFields || []).length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No custom fields yet.</p>}
      </div>
      <Field label="Field name"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Asset Tag" className="sd-in5" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select value={fieldType} onChange={(e) => setFieldType(e.target.value)} className="sd-in5">
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Dropdown</option>
            <option value="checkbox">Checkbox</option>
          </select>
        </Field>
        <Field label="Required?">
          <select value={required ? "yes" : "no"} onChange={(e) => setRequired(e.target.value === "yes")} className="sd-in5">
            <option value="no">Optional</option>
            <option value="yes">Required</option>
          </select>
        </Field>
      </div>
      {fieldType === "select" && (
        <Field label="Options (comma-separated)"><input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="Option A, Option B, Option C" className="sd-in5" /></Field>
      )}
      <button onClick={addField} className="sd-btn-p6">Add field</button>
    </Panel>
  );
}

/* ======================= CUSTOM FIELDS VALUES PANEL (incident detail) ======================= */
function CustomFieldsValuesPanel({ incident, lookups, org, onChanged }) {
  const fields = lookups.customFields || [];
  const existingValues = incident.incident_custom_values || [];
  const [edits, setEdits] = useState({});

  if (fields.length === 0) return null;

  function valueFor(fieldId) {
    if (fieldId in edits) return edits[fieldId];
    return existingValues.find((v) => v.custom_field_id === fieldId)?.value ?? "";
  }

  async function save(fieldId) {
    const raw = edits[fieldId];
    if (raw === undefined) return;
    const value = redactPII(String(raw));
    await supabase.from("incident_custom_values").upsert(
      { incident_id: incident.id, custom_field_id: fieldId, org_id: org.id, value },
      { onConflict: "incident_id,custom_field_id" }
    );
    onChanged();
  }

  return (
    <Panel title="Custom fields" icon={ScanEye}>
      {fields.map((f) => (
        <div key={f.id} className="mb-1">
          <CustomFieldInput field={f} value={valueFor(f.id)} onChange={(v) => setEdits((prev) => ({ ...prev, [f.id]: v }))} />
          <button onClick={() => save(f.id)} className="text-[11px] mb-2" style={{ color: COLORS.amber }}>Save</button>
        </div>
      ))}
    </Panel>
  );
}

/* ================================= INVITE PANEL =============================== */
// Generates the link that closes the gap found during tonight's testing —
// without this, a new sign-up always creates their own organisation, never
// joins yours.
function InvitePanel({ org, lookups, showToast }) {
  const [invites, setInvites] = useState([]);
  const [role, setRole] = useState("agent");
  const [groupId, setGroupId] = useState("");
  const [lastLink, setLastLink] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("org_invites").select("*, resolver_groups(name)").order("created_at", { ascending: false });
    setInvites(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createInvite() {
    const { data, error } = await supabase.rpc("create_invite", { invite_role: role, target_group_id: groupId || null });
    if (error) { showToast(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    setLastLink(`${window.location.origin}/join/${row.code}`);
    await load();
  }
  async function revoke(id) {
    await supabase.rpc("revoke_invite", { target_invite_id: id });
    showToast("Invite revoked");
    await load();
  }
  function copyLink() {
    navigator.clipboard?.writeText(lastLink);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Panel title="Invite a team member" icon={Users}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        A sign-up always creates its own new organisation unless it comes through a link like this — this is how a second person actually joins yours.
      </p>
      {lastLink && (
        <div className="mb-4 p-2.5 rounded-lg" style={{ background: COLORS.teal + "18", border: `1px solid ${COLORS.teal}44` }}>
          <div className="flex items-center gap-2">
            <input readOnly value={lastLink} className="sd-in5 flex-1 sd-mono" style={{ fontSize: 11 }} />
            <button onClick={copyLink} className="sd-btn-p6 flex items-center gap-1">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
          </div>
          <p className="text-[11px] mt-1.5" style={{ color: COLORS.teal }}>Send this to the person you're inviting. Works once, expires in 14 days.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)} className="sd-in5">
            <option value="agent">Agent</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
        <Field label="Starting team (optional)">
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="sd-in5">
            <option value="">No team yet</option>
            {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </div>
      <button onClick={createInvite} className="sd-btn-p6 mb-4">Generate invite link</button>

      <div className="space-y-2">
        {invites.map((i) => {
          const expired = !i.used_at && new Date(i.expires_at) < new Date();
          return (
            <div key={i.id} className="flex items-center justify-between text-xs p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.muted }}>
                {i.role}{i.resolver_groups?.name ? ` · ${i.resolver_groups.name}` : ""} · {i.used_at ? "used" : expired ? "expired" : "pending"}
              </span>
              {!i.used_at && !expired && <button onClick={() => revoke(i.id)} className="text-[11px]" style={{ color: COLORS.red }}>Revoke</button>}
            </div>
          );
        })}
        {invites.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No invites yet.</p>}
      </div>
    </Panel>
  );
}

/* ================================= COMMENTS PANEL ============================== */
// Two threads, kept visibly separate so nobody accidentally posts something
// internal into the customer-visible one: internal notes for staff-to-staff
// context, and a customer thread that's the other end of the portal's
// tracking link.
function CommentsPanel({ incident, org, onChanged }) {
  const [comments, setComments] = useState([]);
  const [tab, setTab] = useState("internal");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("incident_comments").select("*").eq("incident_id", incident.id).order("created_at", { ascending: true });
    setComments(data || []);
  }, [incident.id]);
  useEffect(() => { load(); }, [load]);

  async function post() {
    if (!draft.trim()) return;
    setSending(true);
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("incident_comments").insert({
      incident_id: incident.id, org_id: org.id, author_type: "staff", author_user_id: session?.user?.id || null,
      visibility: tab, body: redactPII(draft),
    });
    setDraft(""); setSending(false);
    await load(); onChanged();
  }

  const filtered = comments.filter((c) => c.visibility === tab);
  const tabMeta = {
    internal: { label: "Internal notes", color: COLORS.amber },
    customer: { label: "Customer-visible", color: COLORS.teal },
    vendor: { label: "Vendor-visible", color: COLORS.blue },
  };
  // Deliberately not just a color on the tab pill — ServiceNow/Jira forum
  // threads show experienced admins getting confused about audience months
  // in, and the most-documented failure ("work note bleed") happens exactly
  // at the point someone types into the wrong box. So the audience is
  // restated at the compose box itself, not just the tab above it. The
  // same discipline extends to the third audience, not relaxed for it.
  const accent = tabMeta[tab].color;

  return (
    <Panel title="Comments" icon={MessageSquare}>
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {Object.entries(tabMeta).map(([key, meta]) => (
          <button key={key} onClick={() => setTab(key)} className="px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: tab === key ? meta.color + "22" : COLORS.surface, color: tab === key ? meta.color : COLORS.muted, border: `1px solid ${COLORS.border}` }}>{meta.label}</button>
        ))}
      </div>

      <div className="space-y-2 mb-3 max-h-56 overflow-y-auto">
        {filtered.map((c) => (
          <div key={c.id} className="text-xs p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="mb-1" style={{ color: c.author_type === "system" ? COLORS.blue : COLORS.faint }}>
              {c.author_type === "customer" ? "Customer" : c.author_type === "vendor" ? "Vendor" : c.author_type === "system" ? "⚙ System (dependency check)" : "Staff"} · {new Date(c.created_at).toLocaleString()}
            </div>
            <div style={{ color: COLORS.text }}>{c.body}</div>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No {tabMeta[tab].label.toLowerCase()} yet.</p>}
      </div>

      <div className="rounded-lg p-2.5" style={{ background: accent + "0f", border: `1px solid ${accent}55` }}>
        <div className="flex items-center gap-1.5 mb-2 text-[11px] font-medium" style={{ color: accent }}>
          {tab === "internal" ? <><Lock size={12} /> Only your team can see this</> :
           tab === "customer" ? <><Users size={12} /> The customer can see this and reply</> :
           <><Truck size={12} /> The vendor can see this and reply</>}
        </div>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className="sd-in3" style={{ borderColor: accent + "55" }}
          placeholder={tab === "internal" ? "Note for other staff…" : tab === "customer" ? "Message the customer will see…" : "Message the vendor will see…"} />
        <button onClick={post} disabled={sending || !draft.trim()} className="mt-2 py-1.5 px-3 rounded-lg text-xs font-semibold" style={{ background: accent, color: "#0A1120" }}>
          {sending ? "Posting…" : tab === "internal" ? "Post internal note" : `Post — ${tab} will see this`}
        </button>
      </div>
    </Panel>
  );
}

/* ================================= ASSIGNEE PANEL ============================== */
// The free equivalent of ServiceNow's Advanced Work Assignment module (a
// separately licensed add-on for suggesting who in a group should take a
// ticket) and something Jira doesn't have natively at all for assignment
// groups. Computed client-side from data already loaded — no extra module,
// no extra cost, just counting who on the team currently has the fewest
// open incidents.
function AssigneePanel({ incident, incidents, onChanged, showToast }) {
  const [members, setMembers] = useState([]);
  const assignment = incident.incident_assignments?.[0];
  const groupId = assignment?.resolver_group_id;

  const load = useCallback(async () => {
    if (!groupId) { setMembers([]); return; }
    const { data } = await supabase.rpc("list_org_members");
    setMembers((data || []).filter((m) => m.resolver_group_id === groupId));
  }, [groupId]);
  useEffect(() => { load(); }, [load]);

  if (!groupId) return null;

  // Open-incident count per member, from data already sitting in memory —
  // no extra query needed.
  const workload = members.map((m) => {
    const openCount = incidents.filter((i) =>
      !i.resolved_at && (i.incident_assignments || []).some((a) => a.assigned_user_id === m.user_id)
    ).length;
    return { ...m, openCount };
  }).sort((a, b) => a.openCount - b.openCount);

  const suggested = workload[0];
  const currentlyAssigned = members.find((m) => m.user_id === assignment.assigned_user_id);

  async function assignTo(userId) {
    await supabase.from("incident_assignments").update({ assigned_user_id: userId || null }).eq("id", assignment.id);
    showToast(userId ? "Assigned" : "Unassigned");
    await onChanged();
  }

  return (
    <Panel title="Assigned to" icon={Users}>
      {members.length === 0 ? (
        <p className="text-xs" style={{ color: COLORS.faint }}>Nobody is on the assigned team yet — add people in Settings → Team assignment.</p>
      ) : (
        <>
          <select value={assignment.assigned_user_id || ""} onChange={(e) => assignTo(e.target.value)} className="sd-in3 mb-2">
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}
          </select>
          {suggested && suggested.user_id !== assignment.assigned_user_id && (
            <button onClick={() => assignTo(suggested.user_id)} className="sd-btn-g text-[11px]">
              Suggest: {suggested.email} (currently {suggested.openCount} open)
            </button>
          )}
          {currentlyAssigned && (
            <p className="text-[11px] mt-1.5" style={{ color: COLORS.faint }}>{currentlyAssigned.email} currently has {workload.find((w) => w.user_id === currentlyAssigned.user_id)?.openCount} open incident(s).</p>
          )}
        </>
      )}
    </Panel>
  );
}

/* ================================= PROBLEMS VIEW ============================== */
// Problem Management, deliberately not gated behind a special role and not
// restricted to only-after-resolution — both real ServiceNow limitations
// found in research. Any staff member can flag "this looks like a pattern"
// the moment they suspect it, from an incident in any status.
function ProblemsView({ org, lookups, incidents, showToast, onOpenIncident, initialProblemId, onProblemOpened }) {
  const [problems, setProblems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rcaCategoryId, setRcaCategoryId] = useState("");
  const [linkedPreventative, setLinkedPreventative] = useState(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("problems").select("*, rca_categories(name), problem_incidents(incident_id, incidents(display_id, title))").order("created_at", { ascending: false });
    setProblems(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Jumped here from Preventatives via a "from Problem" reference — open
  // that specific problem once it's loaded, the same navigation pattern
  // already used for incident references.
  useEffect(() => {
    if (initialProblemId && problems.length > 0) {
      const match = problems.find((p) => p.id === initialProblemId);
      if (match) { setSelected(match); onProblemOpened?.(); }
    }
  }, [initialProblemId, problems, onProblemOpened]);

  useEffect(() => {
    if (!selected) return;
    supabase.from("preventative_actions").select("id").eq("problem_id", selected.id).maybeSingle().then(({ data }) => setLinkedPreventative(data));
  }, [selected]);

  async function createProblem() {
    if (!title.trim()) { showToast("Give the problem a title"); return; }
    const displayId = `PRB-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("problems").insert({
      org_id: org.id, display_id: displayId, title: redactPII(title), description: redactPII(description), rca_category_id: rcaCategoryId || null, created_by: session?.user?.id || null,
    });
    setTitle(""); setDescription(""); setRcaCategoryId("");
    showToast("Problem created");
    await load();
  }

  async function setStatus(id, status) {
    await supabase.from("problems").update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null }).eq("id", id);
    await load();
    if (selected?.id === id) setSelected((s) => ({ ...s, status }));
  }
  async function setWorkaround(id, workaround) {
    const redacted = redactPII(workaround);
    await supabase.from("problems").update({ workaround: redacted, status: "known_error" }).eq("id", id);
    await load();
    if (selected?.id === id) setSelected((s) => ({ ...s, workaround: redacted, status: "known_error" }));
  }
  async function unlink(problemId, incidentId) {
    await supabase.from("problem_incidents").delete().eq("problem_id", problemId).eq("incident_id", incidentId);
    await load();
  }

  // Visible, not silent: this is a button the person clicks, not something
  // that happens automatically the moment a status changes. The gap this
  // closes — resolving a Problem previously had zero connection to
  // Preventative Action effectiveness tracking, so the fix that resolved a
  // recurring pattern never got measured the way every other fix does.
  async function createPreventativeFromProblem(problem) {
    const { error } = await supabase.from("preventative_actions").insert({
      org_id: org.id, problem_id: problem.id, rca_category_id: problem.rca_category_id,
      description: problem.workaround || problem.title,
      status: "done", closed_at: problem.resolved_at || new Date().toISOString(),
    });
    if (error) { showToast(error.message); return; }
    showToast("Logged as a preventative action — check the Preventatives tab");
    setLinkedPreventative({ id: "new" });
  }

  const statusColor = { investigating: COLORS.amber, known_error: COLORS.blue, resolved: COLORS.teal, closed: COLORS.faint };

  if (selected) {
    const p = problems.find((x) => x.id === selected.id) || selected;
    return (
      <div className="pb-6">
        <button onClick={() => setSelected(null)} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to problems</button>
        <Panel title={p.title} icon={Layers}>
          <div className="flex items-center gap-2 mb-2">
            <span className="sd-mono text-xs" style={{ color: COLORS.faint }}>{p.display_id}</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase" style={{ color: statusColor[p.status], background: statusColor[p.status] + "22" }}>{p.status.replace("_", " ")}</span>
          </div>
          <p className="text-sm mb-3" style={{ color: COLORS.muted }}>{p.description}</p>
          <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} className="sd-in3 mb-3">
            <option value="investigating">Investigating</option>
            <option value="known_error">Known error (workaround available)</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <Field label="Workaround — shown on every linked incident while it's being worked, not just after">
            <textarea defaultValue={p.workaround || ""} onBlur={(e) => setWorkaround(p.id, e.target.value)} rows={2} className="sd-in3" placeholder="What can an agent do right now, before this is fully fixed?" />
          </Field>
          {p.status === "resolved" && !linkedPreventative && (
            <div className="rounded-lg p-2.5 mt-2" style={{ background: COLORS.teal + "18", border: `1px solid ${COLORS.teal}44` }}>
              <p className="text-xs mb-2" style={{ color: COLORS.teal }}>This problem is resolved — want to track whether the fix actually reduces recurrence, the same way every other preventative action is measured?</p>
              <button onClick={() => createPreventativeFromProblem(p)} className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: COLORS.teal, color: "#0A1120" }}>Log as a preventative action</button>
            </div>
          )}
          {linkedPreventative && (
            <p className="text-[11px] mt-2" style={{ color: COLORS.faint }}>Logged as a preventative action — its effectiveness will show in the Preventatives tab.</p>
          )}
        </Panel>

        <RCAAnalysisPanel problemId={p.id} org={org} lookups={lookups} showToast={showToast} />

        <Panel title="Linked incidents" icon={AlertTriangle}>
          {(p.problem_incidents || []).map((pi) => (
            <div key={pi.incident_id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              <button onClick={() => onOpenIncident(pi.incident_id)} className="sd-mono text-xs underline" style={{ color: COLORS.muted }}>{pi.incidents?.display_id} — {pi.incidents?.title}</button>
              <button onClick={() => unlink(p.id, pi.incident_id)}><X size={13} color={COLORS.faint} /></button>
            </div>
          ))}
          {(p.problem_incidents || []).length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No incidents linked yet — link one from its detail page.</p>}
        </Panel>
      </div>
    );
  }

  return (
    <div className="pb-6">
      <Panel title="New problem" icon={Layers}>
        <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
          Anyone can create one, from an incident in any status — not gated to a special role, not restricted to only after something's resolved.
        </p>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's the underlying pattern?" className="sd-in3" /></Field>
        <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="sd-in3" /></Field>
        <Field label="Root cause category (optional)">
          <select value={rcaCategoryId} onChange={(e) => setRcaCategoryId(e.target.value)} className="sd-in3">
            <option value="">Choose…</option>
            {lookups.rcaCategories.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <button onClick={createProblem} className="sd-btn-g">Create problem</button>
      </Panel>

      <Panel title="All problems" icon={Layers}>
        <div className="space-y-2">
          {problems.map((p) => (
            <button key={p.id} onClick={() => setSelected(p)} className="w-full text-left p-2.5 rounded-lg text-sm" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.text }}>{p.title}</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase" style={{ color: statusColor[p.status], background: statusColor[p.status] + "22" }}>{p.status.replace("_", " ")}</span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>{p.display_id} · {(p.problem_incidents || []).length} linked incident(s)</div>
            </button>
          ))}
          {problems.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No problems logged yet.</p>}
        </div>
      </Panel>
    </div>
  );
}

/* ========================= PROBLEM LINK PANEL (incident detail) ============== */
// The actual win over ServiceNow: the workaround shows right here, while
// the incident is being worked — not only in a lessons-learned document
// someone reads after the fact.
function ProblemLinkPanel({ incident, lookups, org, onChanged, showToast }) {
  const [problems, setProblems] = useState([]);
  const [pickId, setPickId] = useState("");
  const linked = incident.problem_incidents?.[0];

  const load = useCallback(async () => {
    const { data } = await supabase.from("problems").select("*").order("created_at", { ascending: false });
    setProblems(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function linkExisting() {
    if (!pickId) return;
    await supabase.from("problem_incidents").insert({ problem_id: pickId, incident_id: incident.id, org_id: org.id });
    showToast("Linked to problem");
    setPickId("");
    await onChanged();
  }

  async function createAndLink() {
    const displayId = `PRB-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data: { session } } = await supabase.auth.getSession();
    const { data: prob } = await supabase.from("problems").insert({
      org_id: org.id, display_id: displayId, title: redactPII(incident.title), rca_category_id: incident.rca_category?.id || null, created_by: session?.user?.id || null,
    }).select().single();
    if (prob) await supabase.from("problem_incidents").insert({ problem_id: prob.id, incident_id: incident.id, org_id: org.id });
    showToast("Problem created and linked");
    await onChanged();
  }

  async function unlink() {
    await supabase.from("problem_incidents").delete().eq("problem_id", linked.problem_id).eq("incident_id", incident.id);
    showToast("Unlinked");
    await onChanged();
  }

  const linkedProblem = linked ? problems.find((p) => p.id === linked.problem_id) || linked.problems : null;

  return (
    <Panel title="Problem" icon={Layers}>
      {linkedProblem ? (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm" style={{ color: COLORS.text }}>{linkedProblem.title || linkedProblem.display_id}</span>
            <button onClick={unlink} className="text-[11px]" style={{ color: COLORS.red }}>Unlink</button>
          </div>
          {linkedProblem.status === "known_error" && linkedProblem.workaround && (
            <div className="rounded-lg p-2.5" style={{ background: COLORS.blue + "18", border: `1px solid ${COLORS.blue}44` }}>
              <div className="text-[11px] font-semibold mb-1" style={{ color: COLORS.blue }}>Known workaround</div>
              <p className="text-sm" style={{ color: COLORS.text }}>{linkedProblem.workaround}</p>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-sm mb-3" style={{ color: COLORS.muted }}>Think this might be part of a recurring pattern? Link it now — doesn't need to wait until this is resolved.</p>
          <div className="flex gap-2 mb-2">
            <select value={pickId} onChange={(e) => setPickId(e.target.value)} className="sd-in3 flex-1">
              <option value="">Choose an existing problem…</option>
              {problems.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <button onClick={linkExisting} disabled={!pickId} className="sd-btn-g">Link</button>
          </div>
          <button onClick={createAndLink} className="sd-btn-g">Create new problem from this incident</button>
        </>
      )}
    </Panel>
  );
}

/* ============================ APPROVAL PANEL (service requests) ============= */
// Fixes a documented ServiceNow bug: rejecting an approval does NOT
// automatically close the request there, leaving it stuck. Here, one
// decision handles both — approve moves it into the normal resolver
// queue, reject closes it in the same transaction, every time.
function ApprovalPanel({ incident, org, onChanged, showToast }) {
  const [loading, setLoading] = useState(false);
  const canApprove = org.myRole === "owner" || org.myRole === "admin";

  async function decide(decision) {
    setLoading(true);
    const { error } = await supabase.rpc("set_request_approval", { target_incident_id: incident.id, decision });
    setLoading(false);
    if (error) { showToast(error.message); return; }
    showToast(`Request ${decision}`);
    await onChanged();
  }

  return (
    <Panel title="Awaiting approval" icon={ShieldCheck}>
      {canApprove ? (
        <>
          <p className="text-sm mb-3" style={{ color: COLORS.muted }}>This service request needs approval before it moves to the resolver queue.</p>
          <div className="flex gap-2">
            <button onClick={() => decide("approved")} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: COLORS.teal, color: "#0A1120" }}>Approve</button>
            <button onClick={() => decide("rejected")} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: COLORS.red, color: "#fff" }}>Reject</button>
          </div>
        </>
      ) : (
        <p className="text-sm" style={{ color: COLORS.muted }}>Waiting on an owner or admin to approve this request.</p>
      )}
    </Panel>
  );
}

/* ============================== SERVICE CATALOG PANEL (Settings) ============= */
function ServiceCatalogPanel({ org, lookups, onLookupsChanged, showToast }) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  async function addItem() {
    if (!name.trim()) { showToast("Give the request type a name"); return; }
    await supabase.from("service_catalog_items").insert({
      org_id: org.id, name, category_id: categoryId || null, default_resolver_group_id: groupId || null, requires_approval: requiresApproval,
    });
    setName(""); setCategoryId(""); setGroupId(""); setRequiresApproval(false);
    showToast("Added to catalog");
    await onLookupsChanged();
  }
  async function removeItem(id) {
    await supabase.from("service_catalog_items").delete().eq("id", id);
    await onLookupsChanged();
  }

  return (
    <Panel title="Service catalog" icon={Layers}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Predefined request types staff can pick from when logging a "Request" instead of an "Incident" — e.g. new laptop, software access, password reset.
      </p>
      <div className="space-y-2 mb-4">
        {(lookups.catalogItems || []).map((c) => (
          <div key={c.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <span style={{ color: COLORS.text }}>{c.name}{c.requires_approval ? " · needs approval" : ""}</span>
            <button onClick={() => removeItem(c.id)}><Trash2 size={13} color={COLORS.faint} /></button>
          </div>
        ))}
        {(lookups.catalogItems || []).length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No catalog items yet — requests can still be logged freeform without one.</p>}
      </div>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New laptop" className="sd-in5" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default category (optional)">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="sd-in5">
            <option value="">None</option>
            {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Default team (optional)">
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="sd-in5">
            <option value="">None</option>
            {lookups.resolverGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs mb-3" style={{ color: COLORS.muted }}>
        <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
        Requires owner/admin approval before work begins
      </label>
      <button onClick={addItem} className="sd-btn-p6">Add to catalog</button>
    </Panel>
  );
}

/* ================================= ASSETS / CMDB VIEW ============================== */
// Configuration Management, deliberately single-source-of-truth — no
// automated discovery, no multi-source reconciliation. That's not a
// missing feature; it's what avoids the ~75% CMDB failure rate Gartner
// data attributes almost entirely to duplicate/stale records from
// multiple unreconciled discovery sources. One person enters what they
// actually know, and "last reviewed" is a manual confirmation, not a
// background job silently trusting or retiring records on its own.
function AssetsView({ org, lookups, showToast, onOpenIncident }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filterType, setFilterType] = useState("");
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [attrRows, setAttrRows] = useState([{ key: "", value: "" }]);

  const load = useCallback(async () => {
    const { data } = await supabase.from("configuration_items").select("*, ci_types(name, is_service), resolver_groups(name)").order("name");
    setItems(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createItem() {
    if (!name.trim()) { showToast("Give it a name"); return; }
    const displayId = `CI-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const attributes = Object.fromEntries(attrRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), redactPII(r.value)]));
    await supabase.from("configuration_items").insert({ org_id: org.id, display_id: displayId, name, ci_type_id: typeId || null, attributes });
    setName(""); setTypeId(""); setAttrRows([{ key: "", value: "" }]);
    showToast("Added");
    await load();
  }

  async function markReviewed(id) {
    await supabase.from("configuration_items").update({ last_reviewed_at: new Date().toISOString() }).eq("id", id);
    showToast("Marked reviewed");
    await load();
  }
  async function setItemStatus(id, status) {
    await supabase.from("configuration_items").update({ status }).eq("id", id);
    await load();
  }

  const isStale = (ci) => new Date(ci.last_reviewed_at).getTime() < Date.now() - 90 * 86400000;
  const filtered = filterType ? items.filter((i) => i.ci_type_id === filterType) : items;
  const isExpiringSoon = (ci) => {
    const soon = Date.now() + 30 * 86400000;
    return (ci.warranty_expiry && new Date(ci.warranty_expiry).getTime() < soon) ||
           (ci.license_expiry && new Date(ci.license_expiry).getTime() < soon);
  };

  if (selected) {
    return <AssetDetail item={selected} org={org} lookups={lookups} items={items} onBack={() => setSelected(null)} onChanged={load} onOpenIncident={onOpenIncident} showToast={showToast} />;
  }

  return (
    <div className="pb-6">
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard icon={Server} label="Total" value={items.length} color={COLORS.blue} />
        <StatCard icon={Clock} label="Needs review" value={items.filter(isStale).length} color={COLORS.amber} />
        <StatCard icon={CheckCircle2} label="Active" value={items.filter((i) => i.status === "active").length} color={COLORS.teal} />
        <StatCard icon={AlertTriangle} label="Expiring soon" value={items.filter(isExpiringSoon).length} color={COLORS.red} />
      </div>

      <Panel title="Add configuration item" icon={Server}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Primary file server, Accounting app" className="sd-in3" /></Field>
        <Field label="Type">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="sd-in3">
            <option value="">Choose…</option>
            {(lookups.ciTypes || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Attributes (optional — serial number, IP, location, whatever matters)">
          {attrRows.map((row, idx) => (
            <div key={idx} className="flex gap-1.5 mb-1.5">
              <input value={row.key} onChange={(e) => setAttrRows((prev) => prev.map((r, i) => i === idx ? { ...r, key: e.target.value } : r))} placeholder="Field" className="sd-in3" style={{ flex: 1 }} />
              <input value={row.value} onChange={(e) => setAttrRows((prev) => prev.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))} placeholder="Value" className="sd-in3" style={{ flex: 1 }} />
            </div>
          ))}
          <button onClick={() => setAttrRows((prev) => [...prev, { key: "", value: "" }])} className="text-xs" style={{ color: COLORS.amber }}>+ Add attribute</button>
        </Field>
        <button onClick={createItem} className="sd-btn-g">Add</button>
      </Panel>

      <Panel title="Configuration items" icon={Layers}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button onClick={() => setFilterType("")} className="px-2.5 py-1 rounded-full text-xs" style={{ background: !filterType ? COLORS.amber + "22" : COLORS.surfaceHi, color: !filterType ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>All</button>
          {(lookups.ciTypes || []).map((t) => (
            <button key={t.id} onClick={() => setFilterType(t.id)} className="px-2.5 py-1 rounded-full text-xs" style={{ background: filterType === t.id ? COLORS.amber + "22" : COLORS.surfaceHi, color: filterType === t.id ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>{t.name}</button>
          ))}
        </div>
        <div className="space-y-2">
          {filtered.map((ci) => (
            <div key={ci.id} className="p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, opacity: ci.status === "retired" ? 0.55 : 1 }}>
              <button onClick={() => setSelected(ci)} className="w-full text-left">
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: COLORS.text }}>{ci.name}</span>
                  <div className="flex gap-1">
                    {isExpiringSoon(ci) && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: COLORS.red, background: COLORS.red + "22" }}>EXPIRING SOON</span>}
                    {isStale(ci) && ci.status === "active" && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: COLORS.amber, background: COLORS.amber + "22" }}>NEEDS REVIEW</span>}
                  </div>
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>{ci.display_id} · {ci.ci_types?.name || "Unclassified"}{ci.resolver_groups?.name ? ` · ${ci.resolver_groups.name}` : ""}</div>
              </button>
            </div>
          ))}
          {filtered.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No configuration items yet.</p>}
        </div>
      </Panel>
    </div>
  );
}

function AssetDetail({ item, org, lookups, items, onBack, onChanged, onOpenIncident, showToast }) {
  const [relatedIncidents, setRelatedIncidents] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [pickRelated, setPickRelated] = useState("");
  const [vendors, setVendors] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [lifecycleStatus, setLifecycleStatus] = useState(item.lifecycle_status || "deployed");
  const [warrantyExpiry, setWarrantyExpiry] = useState(item.warranty_expiry || "");
  const [licenseExpiry, setLicenseExpiry] = useState(item.license_expiry || "");
  const [vendorId, setVendorId] = useState(item.purchase_vendor_id || "");
  const [purchaseId, setPurchaseId] = useState(item.purchase_id || "");

  const load = useCallback(async () => {
    const [ic, rel, v] = await Promise.all([
      supabase.from("incident_cis").select("incident_id, incidents(display_id, title, resolved_at)").eq("ci_id", item.id),
      supabase.from("ci_relationships").select("*, parent:configuration_items!ci_relationships_parent_ci_id_fkey(name), child:configuration_items!ci_relationships_child_ci_id_fkey(name)").or(`parent_ci_id.eq.${item.id},child_ci_id.eq.${item.id}`),
      supabase.from("vendors").select("id, name").eq("status", "active").order("name"),
    ]);
    setRelatedIncidents(ic.data || []);
    setRelationships(rel.data || []);
    setVendors(v.data || []);
  }, [item.id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!vendorId) { setPurchases([]); return; }
    supabase.from("vendor_purchases").select("id, description, agreed_price").eq("vendor_id", vendorId).then(({ data }) => setPurchases(data || []));
  }, [vendorId]);

  async function saveLifecycle() {
    await supabase.from("configuration_items").update({
      lifecycle_status: lifecycleStatus, warranty_expiry: warrantyExpiry || null, license_expiry: licenseExpiry || null,
      purchase_vendor_id: vendorId || null, purchase_id: purchaseId || null,
    }).eq("id", item.id);
    showToast("Saved");
    await onChanged();
  }

  async function addRelationship() {
    if (!pickRelated) return;
    await supabase.from("ci_relationships").insert({ org_id: org.id, parent_ci_id: item.id, child_ci_id: pickRelated, relationship_type: "depends_on" });
    setPickRelated("");
    await load();
  }
  async function removeRelationship(id) {
    await supabase.from("ci_relationships").delete().eq("id", id);
    await load();
  }
  async function markReviewed() {
    await supabase.from("configuration_items").update({ last_reviewed_at: new Date().toISOString() }).eq("id", item.id);
    showToast("Marked reviewed");
    await onChanged();
  }
  async function retire() {
    await supabase.from("configuration_items").update({ status: "retired" }).eq("id", item.id);
    showToast("Retired");
    await onChanged();
  }

  return (
    <div className="pb-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to assets</button>
      <Panel title={item.name} icon={Server}>
        <div className="flex items-center justify-between mb-2">
          <span className="sd-mono text-xs" style={{ color: COLORS.faint }}>{item.display_id}</span>
          {item.status === "active" ? (
            <button onClick={retire} className="text-[11px]" style={{ color: COLORS.red }}>Retire</button>
          ) : (
            <span className="text-[11px]" style={{ color: COLORS.faint }}>Retired</span>
          )}
        </div>
        <div className="text-xs mb-3" style={{ color: COLORS.muted }}>Last reviewed {new Date(item.last_reviewed_at).toLocaleDateString()}</div>
        <button onClick={markReviewed} className="sd-btn-g mb-3">Mark reviewed today</button>
        {Object.keys(item.attributes || {}).length > 0 && (
          <div className="space-y-1">
            {Object.entries(item.attributes).map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs"><span style={{ color: COLORS.faint }}>{k}</span><span style={{ color: COLORS.text }}>{v}</span></div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Lifecycle & cost" icon={Clock}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stage">
            <select value={lifecycleStatus} onChange={(e) => setLifecycleStatus(e.target.value)} className="sd-in3">
              <option value="procured">Procured</option>
              <option value="deployed">Deployed</option>
              <option value="in_maintenance">In maintenance</option>
              <option value="disposed">Disposed</option>
            </select>
          </Field>
          <Field label="Warranty expiry"><input type="date" value={warrantyExpiry} onChange={(e) => setWarrantyExpiry(e.target.value)} className="sd-in3" /></Field>
        </div>
        <Field label="License expiry (for software)"><input type="date" value={licenseExpiry} onChange={(e) => setLicenseExpiry(e.target.value)} className="sd-in3" /></Field>
        <p className="text-[11px] mb-1.5" style={{ color: COLORS.faint }}>Link to what you actually paid, instead of re-entering the cost — reuses the purchase record from Vendors.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor (optional)">
            <select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPurchaseId(""); }} className="sd-in3">
              <option value="">None</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          <Field label="Purchase record (optional)">
            <select value={purchaseId} onChange={(e) => setPurchaseId(e.target.value)} className="sd-in3" disabled={!vendorId}>
              <option value="">None</option>
              {purchases.map((p) => <option key={p.id} value={p.id}>{p.description}{p.agreed_price ? ` (R${p.agreed_price})` : ""}</option>)}
            </select>
          </Field>
        </div>
        <button onClick={saveLifecycle} className="sd-btn-g">Save</button>
      </Panel>

      <Panel title="Relationships" icon={Link2}>
        {relationships.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            <span style={{ color: COLORS.muted }}>
              {r.parent_ci_id === item.id ? `depends on ${r.child?.name}` : `${r.parent?.name} depends on this`}
            </span>
            <button onClick={() => removeRelationship(r.id)}><X size={13} color={COLORS.faint} /></button>
          </div>
        ))}
        <div className="flex gap-2 mt-2">
          <select value={pickRelated} onChange={(e) => setPickRelated(e.target.value)} className="sd-in3 flex-1">
            <option value="">This depends on…</option>
            {items.filter((i) => i.id !== item.id).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button onClick={addRelationship} disabled={!pickRelated} className="sd-btn-g">Link</button>
        </div>
      </Panel>

      <Panel title="Related incidents" icon={AlertTriangle}>
        {relatedIncidents.map((ic) => (
          <button key={ic.incident_id} onClick={() => onOpenIncident(ic.incident_id)} className="w-full text-left text-sm py-1.5 sd-mono underline" style={{ color: COLORS.muted, borderBottom: `1px solid ${COLORS.border}` }}>
            {ic.incidents?.display_id} — {ic.incidents?.title}
          </button>
        ))}
        {relatedIncidents.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No incidents linked to this asset yet.</p>}
      </Panel>
    </div>
  );
}

/* ========================= AFFECTED CIs PANEL (incident detail) ============== */
function AffectedCIsPanel({ incident, org, onChanged, showToast }) {
  const [allItems, setAllItems] = useState([]);
  const [linked, setLinked] = useState([]);
  const [pickId, setPickId] = useState("");

  const load = useCallback(async () => {
    const [all, lk] = await Promise.all([
      supabase.from("configuration_items").select("id, name").eq("status", "active").order("name"),
      supabase.from("incident_cis").select("ci_id, configuration_items(name, display_id)").eq("incident_id", incident.id),
    ]);
    setAllItems(all.data || []);
    setLinked(lk.data || []);
  }, [incident.id]);
  useEffect(() => { load(); }, [load]);

  async function link() {
    if (!pickId) return;
    await supabase.from("incident_cis").insert({ incident_id: incident.id, ci_id: pickId, org_id: org.id });
    setPickId("");
    showToast("Linked");
    await load(); await onChanged();
  }
  async function unlink(ciId) {
    await supabase.from("incident_cis").delete().eq("incident_id", incident.id).eq("ci_id", ciId);
    await load(); await onChanged();
  }

  return (
    <Panel title="Affected assets" icon={Server}>
      {linked.map((l) => (
        <div key={l.ci_id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={{ color: COLORS.text }}>{l.configuration_items?.name}</span>
          <button onClick={() => unlink(l.ci_id)}><X size={13} color={COLORS.faint} /></button>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <select value={pickId} onChange={(e) => setPickId(e.target.value)} className="sd-in3 flex-1">
          <option value="">Which asset does this affect?</option>
          {allItems.filter((i) => !linked.some((l) => l.ci_id === i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <button onClick={link} disabled={!pickId} className="sd-btn-g">Link</button>
      </div>
    </Panel>
  );
}

/* ============================== CI TYPES PANEL (Settings) ============= */
function CITypesPanel({ org, lookups, onLookupsChanged, showToast }) {
  const [name, setName] = useState("");
  const [isService, setIsService] = useState(false);

  async function addType() {
    if (!name.trim()) { showToast("Give the type a name"); return; }
    await supabase.from("ci_types").insert({ org_id: org.id, name, is_service: isService, sort_order: (lookups.ciTypes || []).length });
    setName(""); setIsService(false);
    showToast("Added");
    await onLookupsChanged();
  }
  async function removeType(id) {
    await supabase.from("ci_types").delete().eq("id", id);
    await onLookupsChanged();
  }

  return (
    <Panel title="Asset types" icon={Server}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        The categories your configuration items come in — e.g. Server, Application, Network Device. Mark one as a "Service" if it's business-facing rather than underlying infrastructure — Availability and Capacity tracking (coming later) will measure against Services specifically.
      </p>
      <div className="space-y-2 mb-4">
        {(lookups.ciTypes || []).map((t) => (
          <div key={t.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <span style={{ color: COLORS.text }}>{t.name}{t.is_service ? " · Service" : ""}</span>
            <button onClick={() => removeType(t.id)}><Trash2 size={13} color={COLORS.faint} /></button>
          </div>
        ))}
        {(lookups.ciTypes || []).length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No asset types yet.</p>}
      </div>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Server" className="sd-in5" /></Field>
      <label className="flex items-center gap-2 text-xs mb-3" style={{ color: COLORS.muted }}>
        <input type="checkbox" checked={isService} onChange={(e) => setIsService(e.target.checked)} />
        This is a business-facing Service
      </label>
      <button onClick={addType} className="sd-btn-p6">Add type</button>
    </Panel>
  );
}

/* ================================= ATTACHMENTS PANEL ============================== */
// Real gap found live: neither a resolver nor a requestor could attach a
// file to an incident at all. Designed against two specific, documented
// failures: ServiceNow's Service Portal silently fails uploads over 25MB
// with no error shown at all — every failure here shows a clear reason.
// Jira ties attachment storage to the same paid capacity as everything
// else in the account — this uses Supabase's separate free 1GB file
// storage, so attachments never compete with anything else for space.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB, one consistent limit everywhere

function AttachmentsPanel({ incident, org, showToast }) {
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("incident_attachments").select("*").eq("incident_id", incident.id).order("created_at", { ascending: false });
    setAttachments(data || []);
  }, [incident.id]);
  useEffect(() => { load(); }, [load]);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast("That file is larger than 10MB — please attach a smaller file.");
      return;
    }
    setUploading(true);
    const path = `${org.id}/${incident.id}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from("attachments").upload(path, file);
    if (uploadError) {
      showToast("Upload failed: " + uploadError.message);
      setUploading(false);
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("incident_attachments").insert({
      org_id: org.id, incident_id: incident.id, storage_path: path, file_name: redactPII(file.name), file_size: file.size,
      uploaded_by_type: "staff", uploaded_by_user_id: session?.user?.id || null,
    });
    setUploading(false);
    showToast("Attached");
    await load();
  }

  async function getUrl(path) {
    const { data } = await supabase.storage.from("attachments").createSignedUrl(path, 300);
    return data?.signedUrl;
  }
  async function download(att) {
    const url = await getUrl(att.storage_path);
    if (url) window.open(url, "_blank");
    else showToast("Couldn't open that file — try again");
  }
  async function remove(att) {
    await supabase.storage.from("attachments").remove([att.storage_path]);
    await supabase.from("incident_attachments").delete().eq("id", att.id);
    showToast("Removed");
    await load();
  }

  return (
    <Panel title="Attachments" icon={Link2}>
      <div className="space-y-2 mb-3">
        {attachments.map((a) => (
          <div key={a.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <button onClick={() => download(a)} className="truncate underline text-left" style={{ color: COLORS.muted }}>{a.file_name}</button>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <span className="text-[11px]" style={{ color: COLORS.faint }}>{(a.file_size / 1024).toFixed(0)} KB · {a.uploaded_by_type === "customer" ? "customer" : "staff"}</span>
              <button onClick={() => remove(a)}><Trash2 size={13} color={COLORS.faint} /></button>
            </div>
          </div>
        ))}
        {attachments.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No attachments yet.</p>}
      </div>
      <label className="sd-btn-g inline-block cursor-pointer">
        {uploading ? "Uploading…" : "Attach a file (up to 10MB)"}
        <input type="file" onChange={handleUpload} disabled={uploading} className="hidden" />
      </label>
    </Panel>
  );
}

/* ================================= TIME SPENT PANEL ============================== */
// Designed against two documented failure modes: pure manual entry gets
// forgotten ("tired people trying to remember fragmented work after the
// fact"), and naive auto-timers are just as unreliable, since agents have
// multiple tabs open and get pulled into calls. The automatic breakdown
// below needs no new schema at all — incident_timeline has logged every
// status change with a timestamp since the very first build. Manual entry
// only exists for the genuine exception: something that doesn't show up
// as a status change at all, like a phone call.
function computeTimeInStatus(incident, statuses) {
  const entries = [...(incident.incident_timeline || [])]
    .filter((t) => t.status_id)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (entries.length === 0) return [];

  const buckets = {};
  for (let i = 0; i < entries.length; i++) {
    const start = new Date(entries[i].ts).getTime();
    const end = i + 1 < entries.length ? new Date(entries[i + 1].ts).getTime() : (incident.resolved_at ? new Date(incident.resolved_at).getTime() : Date.now());
    const statusName = statuses.find((s) => s.id === entries[i].status_id)?.name || "Unknown";
    buckets[statusName] = (buckets[statusName] || 0) + Math.max(0, end - start);
  }
  return Object.entries(buckets).map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

function TimeSpentPanel({ incident, lookups, org, showToast }) {
  const [manualLogs, setManualLogs] = useState([]);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("incident_time_logs").select("*").eq("incident_id", incident.id).order("logged_at", { ascending: false });
    setManualLogs(data || []);
  }, [incident.id]);
  useEffect(() => { load(); }, [load]);

  const breakdown = computeTimeInStatus(incident, lookups.statuses);
  const autoTotal = breakdown.reduce((sum, b) => sum + b.ms, 0);
  const manualTotal = manualLogs.reduce((sum, l) => sum + l.minutes * 60000, 0);

  async function addManual() {
    const mins = parseInt(minutes, 10);
    if (!mins || mins <= 0) { showToast("Enter a number of minutes"); return; }
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("incident_time_logs").insert({
      org_id: org.id, incident_id: incident.id, user_id: session?.user?.id || null, minutes: mins, note: redactPII(note),
    });
    setMinutes(""); setNote("");
    showToast("Logged");
    await load();
  }
  async function removeManual(id) {
    await supabase.from("incident_time_logs").delete().eq("id", id);
    await load();
  }

  return (
    <Panel title="Time spent" icon={Clock}>
      <p className="text-xs mb-3" style={{ color: COLORS.faint }}>Automatic, from status history — nobody has to remember to start a timer.</p>
      <div className="space-y-1.5 mb-3">
        {breakdown.map((b) => (
          <div key={b.name} className="flex items-center justify-between text-sm">
            <span style={{ color: COLORS.muted }}>{b.name}</span>
            <span className="sd-mono" style={{ color: COLORS.text }}>{fmtDuration(b.ms)}</span>
          </div>
        ))}
        {breakdown.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No status history yet.</p>}
      </div>
      <div className="flex items-center justify-between text-sm mb-3 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
        <span style={{ color: COLORS.text }}>Total (auto + manual)</span>
        <span className="sd-mono font-semibold" style={{ color: COLORS.amber }}>{fmtDuration(autoTotal + manualTotal)}</span>
      </div>

      {manualLogs.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {manualLogs.map((l) => (
            <div key={l.id} className="flex items-center justify-between text-xs p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.muted }}>{l.minutes}m{l.note ? ` — ${l.note}` : ""}</span>
              <button onClick={() => removeManual(l.id)}><Trash2 size={12} color={COLORS.faint} /></button>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] mb-1.5" style={{ color: COLORS.faint }}>Log time that doesn't show up as a status change — a call, a site visit.</p>
      <div className="flex gap-2">
        <input type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" className="sd-in6" style={{ width: 80 }} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was it? (optional)" className="sd-in6 flex-1" />
        <button onClick={addManual} className="sd-btn-g text-xs">Log</button>
      </div>
    </Panel>
  );
}

/* ============================ FIRST RESPONSE SLA BADGE ============================ */
// Stops on either a staff comment or a status change, whichever happens
// first — no ambiguity between the two, unlike a documented Jira bug
// where a staff member's own reply can get misclassified as a customer
// comment and the clock never stops. Policies are matched by plain
// category/severity, never a scripted condition — most specific match
// wins (both filters set beats one filter beats no filter).
function findApplicableSlaPolicy(incident, policies, metricType) {
  const candidates = policies.filter((p) => p.active && p.metric_type === metricType &&
    (!p.category_id || p.category_id === incident.category?.id) &&
    (!p.severity_id || p.severity_id === incident.severity?.id));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const score = (p) => (p.category_id ? 1 : 0) + (p.severity_id ? 1 : 0);
    return score(b) - score(a);
  })[0];
}

function FirstResponseBadge({ incident, lookups }) {
  const policy = findApplicableSlaPolicy(incident, lookups.slaPolicies || [], "first_response");
  if (!policy) return null;
  const deadline = new Date(incident.created_at).getTime() + policy.target_minutes * 60000;
  const responded = !!incident.first_response_at;
  const remaining = deadline - Date.now();
  const breached = responded ? new Date(incident.first_response_at).getTime() > deadline : remaining < 0;
  let color = COLORS.teal;
  if (breached) color = COLORS.red;
  else if (!responded && remaining < policy.target_minutes * 60000 * 0.25) color = COLORS.amber;
  return (
    <div className="flex items-center gap-1.5 sd-mono text-[11px]" style={{ color }}>
      <Send size={12} />
      First response: {responded ? (breached ? "Late" : "On time") : (breached ? `Overdue ${fmtDuration(-remaining)}` : fmtClock(remaining))}
    </div>
  );
}

/* ============================== SLA POLICIES PANEL (Settings) ============= */
function SLAPoliciesPanel({ org, lookups, onLookupsChanged, showToast }) {
  const [name, setName] = useState("");
  const [metricType, setMetricType] = useState("first_response");
  const [targetMinutes, setTargetMinutes] = useState(30);
  const [categoryId, setCategoryId] = useState("");
  const [severityId, setSeverityId] = useState("");

  async function addPolicy() {
    if (!name.trim() || !targetMinutes) { showToast("Give it a name and a target time"); return; }
    await supabase.from("sla_policies").insert({
      org_id: org.id, name: redactPII(name), metric_type: metricType, target_minutes: +targetMinutes,
      category_id: categoryId || null, severity_id: severityId || null,
    });
    setName(""); setTargetMinutes(30); setCategoryId(""); setSeverityId("");
    showToast("SLA policy added");
    await onLookupsChanged();
  }
  async function togglePolicy(p) {
    await supabase.from("sla_policies").update({ active: !p.active }).eq("id", p.id);
    await onLookupsChanged();
  }
  async function removePolicy(id) {
    await supabase.from("sla_policies").delete().eq("id", id);
    await onLookupsChanged();
  }

  return (
    <Panel title="SLA policies" icon={Clock}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Separate targets for first response and resolution, by category and severity if you need it. Simple dropdowns — no scripted conditions, no calendar to misconfigure. Most specific match wins.
      </p>
      <div className="space-y-2 mb-4">
        {(lookups.slaPolicies || []).map((p) => (
          <div key={p.id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div>
              <span style={{ color: COLORS.text }}>{p.name}</span>
              <div className="text-[11px]" style={{ color: COLORS.faint }}>
                {p.metric_type === "first_response" ? "First response" : "Resolution"} · {p.target_minutes}m
                {p.category_id ? ` · ${lookups.categories.find((c) => c.id === p.category_id)?.name || ""}` : ""}
                {p.severity_id ? ` · ${lookups.severities.find((s) => s.id === p.severity_id)?.name || ""}` : ""}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => togglePolicy(p)} className="text-xs" style={{ color: p.active ? COLORS.teal : COLORS.faint }}>{p.active ? "Active" : "Paused"}</button>
              <button onClick={() => removePolicy(p.id)}><Trash2 size={13} color={COLORS.faint} /></button>
            </div>
          </div>
        ))}
        {(lookups.slaPolicies || []).length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No custom SLA policies yet — incidents still use the default resolution SLA set on each severity.</p>}
      </div>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Critical first response" className="sd-in5" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Measures">
          <select value={metricType} onChange={(e) => setMetricType(e.target.value)} className="sd-in5">
            <option value="first_response">Time to first response</option>
            <option value="resolution">Time to resolution</option>
          </select>
        </Field>
        <Field label="Target (minutes)"><input type="number" value={targetMinutes} onChange={(e) => setTargetMinutes(e.target.value)} className="sd-in5" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Only this category (optional)">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="sd-in5">
            <option value="">Any category</option>
            {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Only this severity (optional)">
          <select value={severityId} onChange={(e) => setSeverityId(e.target.value)} className="sd-in5">
            <option value="">Any severity</option>
            {lookups.severities.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <button onClick={addPolicy} className="sd-btn-p6">Add SLA policy</button>
    </Panel>
  );
}

/* ================================= VENDORS VIEW ============================== */
// Designed against the most-repeated documented pain point: "purchase
// expectations were never documented clearly before delivery." Purchases
// are recorded with agreed terms and price up front, not reconstructed
// after a dispute. Vendor issues link to the existing incident engine —
// the scorecard is derived from incidents already being tracked, not a
// separate analytics system.
function VendorsView({ org, showToast, onOpenIncident }) {
  const [vendors, setVendors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("vendors").select("*").order("name");
    setVendors(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createVendor() {
    if (!name.trim()) { showToast("Give the vendor a name"); return; }
    const displayId = `VEN-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    await supabase.from("vendors").insert({
      org_id: org.id, display_id: displayId, name: redactPII(name), category: redactPII(category),
      contact_name: redactPII(contactName), contact_email: redactPII(contactEmail), contact_phone: redactPII(contactPhone),
    });
    setName(""); setCategory(""); setContactName(""); setContactEmail(""); setContactPhone("");
    showToast("Vendor added");
    await load();
  }

  if (selected) {
    return <VendorDetail vendor={selected} org={org} onBack={() => setSelected(null)} onChanged={load} onOpenIncident={onOpenIncident} showToast={showToast} />;
  }

  return (
    <div className="pb-6">
      <Panel title="Add vendor" icon={Truck}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Office Supplies" className="sd-in3" /></Field>
        <Field label="Category (optional)"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Supplier, Logistics, Service Provider" className="sd-in3" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact name"><input value={contactName} onChange={(e) => setContactName(e.target.value)} className="sd-in3" /></Field>
          <Field label="Contact email"><input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="sd-in3" /></Field>
        </div>
        <Field label="Contact phone"><input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className="sd-in3" /></Field>
        <button onClick={createVendor} className="sd-btn-g">Add vendor</button>
      </Panel>

      <Panel title="Vendors" icon={Truck}>
        <div className="space-y-2">
          {vendors.map((v) => (
            <button key={v.id} onClick={() => setSelected(v)} className="w-full text-left p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}`, opacity: v.status === "inactive" ? 0.55 : 1 }}>
              <div className="text-sm" style={{ color: COLORS.text }}>{v.name}</div>
              <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>{v.display_id}{v.category ? ` · ${v.category}` : ""}</div>
            </button>
          ))}
          {vendors.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No vendors added yet.</p>}
        </div>
      </Panel>

      <QuoteRequestsPanel org={org} vendors={vendors} onOpenIncident={onOpenIncident} showToast={showToast} />
    </div>
  );
}

function VendorDetail({ vendor: initialVendor, org, onBack, onChanged, onOpenIncident, showToast }) {
  const [vendor, setVendor] = useState(initialVendor);
  const [purchases, setPurchases] = useState([]);
  const [linkedIncidents, setLinkedIncidents] = useState([]);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [terms, setTerms] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(vendor.name);
  const [editCategory, setEditCategory] = useState(vendor.category || "");
  const [editContactName, setEditContactName] = useState(vendor.contact_name || "");
  const [editContactEmail, setEditContactEmail] = useState(vendor.contact_email || "");
  const [editContactPhone, setEditContactPhone] = useState(vendor.contact_phone || "");
  const [editTerms, setEditTerms] = useState(vendor.contract_terms || "");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [p, ic] = await Promise.all([
      supabase.from("vendor_purchases").select("*").eq("vendor_id", vendor.id).order("created_at", { ascending: false }),
      supabase.from("incident_vendors").select("incident_id, incidents(display_id, title, resolved_at, created_at)").eq("vendor_id", vendor.id),
    ]);
    setPurchases(p.data || []);
    setLinkedIncidents(ic.data || []);
  }, [vendor.id]);
  useEffect(() => { load(); }, [load]);

  // Real gap found by direct question: once created, a vendor's own
  // details (name, contact, terms) could never be changed — no edit
  // capability existed at all. Same redaction and Field patterns already
  // used everywhere else for vendor data.
  async function saveVendorDetails() {
    if (!editName.trim()) { showToast("Give the vendor a name"); return; }
    setSaving(true);
    const updated = {
      name: redactPII(editName), category: redactPII(editCategory),
      contact_name: redactPII(editContactName), contact_email: redactPII(editContactEmail),
      contact_phone: redactPII(editContactPhone), contract_terms: redactPII(editTerms),
    };
    const { error } = await supabase.from("vendors").update(updated).eq("id", vendor.id);
    setSaving(false);
    if (error) { showToast(error.message); return; }
    setVendor((prev) => ({ ...prev, ...updated }));
    setEditing(false);
    showToast("Saved");
    await onChanged();
  }

  // The vendor scorecard, for free — derived entirely from incidents
  // already being tracked, no separate analytics system.
  const issueCount = linkedIncidents.length;
  const openIssues = linkedIncidents.filter((l) => !l.incidents?.resolved_at).length;

  async function createPurchase() {
    if (!description.trim()) { showToast("Describe what's being purchased"); return; }
    const displayId = `PO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const priceNum = price ? parseFloat(price) : null;
    const needsApproval = org.vendor_approval_threshold && priceNum && priceNum >= org.vendor_approval_threshold;
    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("vendor_purchases").insert({
      org_id: org.id, vendor_id: vendor.id, display_id: displayId, description: redactPII(description),
      agreed_price: priceNum, agreed_terms: redactPII(terms), expected_delivery_date: expectedDate || null,
      approval_status: needsApproval ? "pending" : "not_required", created_by: session?.user?.id || null,
    });
    setDescription(""); setPrice(""); setTerms(""); setExpectedDate("");
    showToast(needsApproval ? "Recorded — awaiting approval" : "Recorded");
    await load();
  }

  async function decide(purchaseId, decision) {
    const { error } = await supabase.rpc("set_vendor_purchase_approval", { target_purchase_id: purchaseId, decision });
    if (error) { showToast(error.message); return; }
    showToast(`Purchase ${decision}`);
    await load();
  }

  async function setPurchaseStatus(id, status) {
    await supabase.from("vendor_purchases").update({ status, actual_delivery_date: status === "delivered" ? new Date().toISOString().slice(0, 10) : null }).eq("id", id);
    await load();
  }

  const canApprove = org.myRole === "owner" || org.myRole === "admin";

  return (
    <div className="pb-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to vendors</button>
      <Panel title={editing ? "Edit vendor" : vendor.name} icon={Truck}>
        {editing ? (
          <>
            <Field label="Name"><input value={editName} onChange={(e) => setEditName(e.target.value)} className="sd-in3" /></Field>
            <Field label="Category"><input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="sd-in3" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact name"><input value={editContactName} onChange={(e) => setEditContactName(e.target.value)} className="sd-in3" /></Field>
              <Field label="Contact email"><input value={editContactEmail} onChange={(e) => setEditContactEmail(e.target.value)} className="sd-in3" /></Field>
            </div>
            <Field label="Contact phone"><input value={editContactPhone} onChange={(e) => setEditContactPhone(e.target.value)} className="sd-in3" /></Field>
            <Field label="Contract terms"><textarea value={editTerms} onChange={(e) => setEditTerms(e.target.value)} rows={2} className="sd-in3" /></Field>
            <div className="flex gap-2">
              <button onClick={saveVendorDetails} disabled={saving} className="sd-btn-p">{saving ? "Saving…" : "Save"}</button>
              <button onClick={() => setEditing(false)} className="sd-btn-g">Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between">
              <div className="sd-mono text-xs mb-2" style={{ color: COLORS.faint }}>{vendor.display_id}{vendor.category ? ` · ${vendor.category}` : ""}</div>
              <button onClick={() => setEditing(true)} className="text-xs" style={{ color: COLORS.amber }}>Edit</button>
            </div>
            {vendor.contact_name && <p className="text-sm" style={{ color: COLORS.muted }}>{vendor.contact_name}{vendor.contact_email ? ` · ${vendor.contact_email}` : ""}{vendor.contact_phone ? ` · ${vendor.contact_phone}` : ""}</p>}
            {vendor.contract_terms && <p className="text-sm mt-2" style={{ color: COLORS.text }}>{vendor.contract_terms}</p>}
          </>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Issues raised" value={issueCount} color={COLORS.amber} />
        <StatCard icon={Clock} label="Open issues" value={openIssues} color={COLORS.red} />
      </div>

      <Panel title="Record a purchase — terms documented before delivery, not after a dispute" icon={Truck}>
        <Field label="What's being purchased"><input value={description} onChange={(e) => setDescription(e.target.value)} className="sd-in3" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Agreed price (optional)"><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} className="sd-in3" /></Field>
          <Field label="Expected delivery (optional)"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className="sd-in3" /></Field>
        </div>
        <Field label="Agreed terms (optional)"><textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={2} className="sd-in3" placeholder="Quality, quantity, delivery conditions — whatever was actually agreed" /></Field>
        <button onClick={createPurchase} className="sd-btn-g">Record purchase</button>
      </Panel>

      <Panel title="Purchases" icon={Truck}>
        <div className="space-y-2">
          {purchases.map((p) => (
            <div key={p.id} className="p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: COLORS.text }}>{p.description}</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase" style={{ color: COLORS.faint }}>{p.status}</span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>{p.display_id}{p.agreed_price ? ` · R${p.agreed_price}` : ""}{p.expected_delivery_date ? ` · expected ${p.expected_delivery_date}` : ""}</div>
              {p.approval_status === "pending" && canApprove && (
                <div className="flex gap-2 mt-2">
                  <button onClick={() => decide(p.id, "approved")} className="text-xs px-2.5 py-1 rounded-lg font-semibold" style={{ background: COLORS.teal, color: "#0A1120" }}>Approve</button>
                  <button onClick={() => decide(p.id, "rejected")} className="text-xs px-2.5 py-1 rounded-lg font-semibold" style={{ background: COLORS.red, color: "#fff" }}>Reject</button>
                </div>
              )}
              {p.approval_status === "pending" && !canApprove && <p className="text-[11px] mt-1" style={{ color: COLORS.amber }}>Awaiting owner/admin approval</p>}
              {p.status === "ordered" && p.approval_status !== "pending" && (
                <button onClick={() => setPurchaseStatus(p.id, "delivered")} className="text-xs mt-2" style={{ color: COLORS.teal }}>Mark delivered</button>
              )}
            </div>
          ))}
          {purchases.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No purchases recorded yet.</p>}
        </div>
      </Panel>

      <Panel title="Related incidents" icon={AlertTriangle}>
        {linkedIncidents.map((l) => (
          <button key={l.incident_id} onClick={() => onOpenIncident(l.incident_id)} className="w-full text-left text-sm py-1.5 sd-mono underline" style={{ color: COLORS.muted, borderBottom: `1px solid ${COLORS.border}` }}>
            {l.incidents?.display_id} — {l.incidents?.title}
          </button>
        ))}
        {linkedIncidents.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No incidents linked to this vendor yet.</p>}
      </Panel>
    </div>
  );
}

/* ========================= VENDOR LINK PANEL (incident detail) ============== */
function VendorLinkPanel({ incident, org, onChanged, showToast }) {
  const [allVendors, setAllVendors] = useState([]);
  const [linked, setLinked] = useState([]);
  const [pickId, setPickId] = useState("");

  const load = useCallback(async () => {
    const [all, lk] = await Promise.all([
      supabase.from("vendors").select("id, name").eq("status", "active").order("name"),
      supabase.from("incident_vendors").select("vendor_id, vendors(name, display_id)").eq("incident_id", incident.id),
    ]);
    setAllVendors(all.data || []);
    setLinked(lk.data || []);
  }, [incident.id]);
  useEffect(() => { load(); }, [load]);

  async function link() {
    if (!pickId) return;
    await supabase.from("incident_vendors").insert({ incident_id: incident.id, vendor_id: pickId, org_id: org.id });
    setPickId("");
    showToast("Linked");
    await load(); await onChanged();
  }
  async function unlink(vendorId) {
    await supabase.from("incident_vendors").delete().eq("incident_id", incident.id).eq("vendor_id", vendorId);
    await load(); await onChanged();
  }

  if (allVendors.length === 0 && linked.length === 0) return null;

  return (
    <Panel title="Related vendor" icon={Truck}>
      {linked.map((l) => (
        <div key={l.vendor_id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={{ color: COLORS.text }}>{l.vendors?.name}</span>
          <button onClick={() => unlink(l.vendor_id)}><X size={13} color={COLORS.faint} /></button>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <select value={pickId} onChange={(e) => setPickId(e.target.value)} className="sd-in3 flex-1">
          <option value="">Is this about a vendor?</option>
          {allVendors.filter((v) => !linked.some((l) => l.vendor_id === v.id)).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <button onClick={link} disabled={!pickId} className="sd-btn-g">Link</button>
      </div>
    </Panel>
  );
}

/* ============================== VENDOR SETTINGS PANEL (Settings) ============= */
function VendorSettingsPanel({ org, onOrgUpdated, showToast }) {
  const [threshold, setThreshold] = useState(org.vendor_approval_threshold || "");

  async function save() {
    const newThreshold = threshold ? parseFloat(threshold) : null;
    await supabase.from("organisations").update({ vendor_approval_threshold: newThreshold }).eq("id", org.id);
    showToast("Saved");
    await onOrgUpdated({ ...org, vendor_approval_threshold: newThreshold });
  }

  return (
    <Panel title="Vendor purchase approval" icon={Truck}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Purchases at or above this amount need owner/admin approval before proceeding. One simple threshold, not a multi-level approval chain — leave blank to never require approval.
      </p>
      <div className="flex gap-2">
        <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="e.g. 5000" className="sd-in3 flex-1" />
        <button onClick={save} className="sd-btn-g">Save</button>
      </div>
    </Panel>
  );
}

/* ============================== TEMPLATE SETTINGS PANEL (Settings) ============= */
// Completes the Business Templates design — this is where an org actually
// touches what was, until now, correct data sitting unused. Module
// toggles and terminology both layer over the template's defaults,
// org's own choice always wins, matching effective_terminology() and
// isModuleEnabled() exactly.
const ALL_MODULES = [
  { key: "problems", label: "Problems" },
  { key: "cmdb", label: "Assets (CMDB)" },
  { key: "on_call", label: "On-call & escalation" },
  { key: "service_catalog", label: "Service catalog" },
  { key: "sla_policies", label: "Custom SLA policies" },
  { key: "vendors", label: "Vendors" },
];
const TERM_KEYS = [
  { key: "incident", label: "\"Incident\" (singular)" },
  { key: "incidents", label: "\"Incidents\" (plural)" },
  { key: "resolver_group", label: "\"Resolver group\" (singular)" },
  { key: "resolver_groups", label: "\"Resolver groups\" (plural)" },
];

function TemplateSettingsPanel({ org, onOrgUpdated, showToast }) {
  const [moduleOverrides, setModuleOverrides] = useState(org.module_overrides || {});
  const [termOverrides, setTermOverrides] = useState(org.terminology_overrides || {});

  function toggleModule(key) {
    const current = moduleOverrides[key] !== undefined ? moduleOverrides[key] : isModuleEnabled(org, key);
    setModuleOverrides((prev) => ({ ...prev, [key]: !current }));
  }

  async function save() {
    const redactedTerms = Object.fromEntries(Object.entries(termOverrides).map(([k, v]) => [k, redactPII(v)]));
    await supabase.from("organisations").update({ module_overrides: moduleOverrides, terminology_overrides: redactedTerms }).eq("id", org.id);
    showToast("Saved");
    await onOrgUpdated({ ...org, module_overrides: moduleOverrides, terminology_overrides: redactedTerms });
  }

  return (
    <Panel title="Template & modules" icon={Layers}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Current template: <strong style={{ color: COLORS.text }}>{org.business_templates?.name || "None — everything enabled by default"}</strong>. Turn individual modules on or off, or rename things to match how your team actually talks — your own choices always win over the template's defaults.
      </p>

      <div className="text-xs font-semibold mb-2" style={{ color: COLORS.faint }}>MODULES</div>
      <div className="space-y-1.5 mb-4">
        {ALL_MODULES.map((m) => {
          const enabled = moduleOverrides[m.key] !== undefined ? moduleOverrides[m.key] : isModuleEnabled(org, m.key);
          return (
            <label key={m.key} className="flex items-center justify-between text-sm p-2 rounded-lg cursor-pointer" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.text }}>{m.label}</span>
              <input type="checkbox" checked={enabled} onChange={() => toggleModule(m.key)} />
            </label>
          );
        })}
      </div>

      <div className="text-xs font-semibold mb-2" style={{ color: COLORS.faint }}>TERMINOLOGY</div>
      <div className="space-y-2 mb-4">
        {TERM_KEYS.map((t) => (
          <Field key={t.key} label={t.label}>
            <input
              value={termOverrides[t.key] !== undefined ? termOverrides[t.key] : (org.business_templates?.terminology?.[t.key] || "")}
              onChange={(e) => setTermOverrides((prev) => ({ ...prev, [t.key]: e.target.value }))}
              placeholder={t.key.includes("resolver_group") ? "Resolver group" : "Incident"}
              className="sd-in5"
            />
          </Field>
        ))}
      </div>

      <button onClick={save} className="sd-btn-p6">Save</button>
    </Panel>
  );
}

/* ============================== AUTOMATION TRUST PANEL (Settings) ============= */
// Every automation rule that's fired, with its computed trust tier and
// recent activity — real numbers from automation_trust_tiers, not a
// vanity claim. Flagging is explicit, human feedback, never inferred.
function AutomationTrustPanel({ org, showToast }) {
  const [rows, setRows] = useState([]);
  const [rules, setRules] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [events, setEvents] = useState([]);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      supabase.from("automation_trust_tiers").select("*").eq("automation_type", "automation_rule"),
      supabase.from("automation_rules").select("id, event_type, action_type"),
    ]);
    setRows(t.data || []);
    setRules(Object.fromEntries((r.data || []).map((x) => [x.id, x])));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function loadEvents(automationId) {
    setExpanded(automationId);
    const { data } = await supabase.from("automation_events").select("*").eq("automation_id", automationId).order("created_at", { ascending: false }).limit(10);
    setEvents(data || []);
  }

  async function flagWrong(eventId) {
    const { error } = await supabase.rpc("flag_automation_action_incorrect", { event_id: eventId });
    if (error) { showToast(error.message); return; }
    showToast("Flagged");
    await loadEvents(expanded);
    await load();
  }

  const tierColor = { new: COLORS.faint, building_trust: COLORS.amber, trusted: COLORS.teal, needs_review: COLORS.red };
  const tierLabel = { new: "New", building_trust: "Building trust", trusted: "Trusted", needs_review: "Needs review" };

  return (
    <Panel title="Automation trust" icon={Activity}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Real track record per automation rule, not a claim — flag a specific firing as wrong and the tier updates immediately.
      </p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.automation_id}>
            <button onClick={() => loadEvents(row.automation_id)} className="w-full flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.text }}>{rules[row.automation_id]?.event_type || "Rule"} → {rules[row.automation_id]?.action_type}</span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: tierColor[row.tier], background: tierColor[row.tier] + "22" }}>{tierLabel[row.tier]}</span>
            </button>
            {expanded === row.automation_id && (
              <div className="mt-1 ml-2 space-y-1">
                {events.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-xs px-2 py-1" style={{ color: COLORS.faint }}>
                    <span>{new Date(e.created_at).toLocaleString()} · {e.outcome.replace(/_/g, " ")}</span>
                    {e.outcome === "fired_no_objection" && <button onClick={() => flagWrong(e.id)} className="underline" style={{ color: COLORS.red }}>Flag as wrong</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No automation activity recorded yet.</p>}
      </div>
    </Panel>
  );
}

/* ============================== CSI TRENDS PANEL ============================== */
// Live synthesis, not a report to generate — computed from incident
// frequency already being tracked, comparing the last 30 days to the 30
// before. Scoped honestly: this is the trend engine, the foundation for
// predictive capacity — not the staffing prediction itself, which needs
// more statistical care than a live count comparison provides.
function CSITrendsPanel({ org, lookups }) {
  const [trends, setTrends] = useState([]);

  useEffect(() => {
    supabase.from("rca_category_trends").select("*").then(({ data }) => setTrends(data || []));
  }, []);

  const trendMeta = {
    improving: { color: COLORS.teal, label: "Improving", icon: TrendingUp },
    worsening: { color: COLORS.red, label: "Worsening", icon: AlertTriangle },
    stable: { color: COLORS.muted, label: "Stable", icon: Activity },
    new_pattern: { color: COLORS.amber, label: "New pattern", icon: Zap },
    no_data: { color: COLORS.faint, label: "Not enough data", icon: Clock },
  };

  const withData = trends.filter((t) => t.trend !== "no_data" && (t.recent_count > 0 || t.prior_count > 0));

  return (
    <Panel title="Continual improvement — is this actually getting better?" icon={TrendingUp}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Last 30 days versus the 30 before, per root cause — computed live from incidents already logged, not a report you have to remember to run.
      </p>
      <div className="space-y-1.5">
        {withData.map((t) => {
          const name = lookups.rcaCategories.find((r) => r.id === t.rca_category_id)?.name || "Unknown";
          const meta = trendMeta[t.trend];
          const Icon = meta.icon;
          return (
            <div key={t.rca_category_id} className="flex items-center justify-between text-sm p-2 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.text }}>{name}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px]" style={{ color: COLORS.faint }}>{t.prior_count} → {t.recent_count}</span>
                <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: meta.color, background: meta.color + "22" }}>
                  <Icon size={10} /> {meta.label}
                </span>
              </div>
            </div>
          );
        })}
        {withData.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>Not enough incident history yet to compute trends.</p>}
      </div>
    </Panel>
  );
}

/* ============================== RISK SIGNALS PANEL ============================== */
// The safe version of "dynamic SLA thresholds" — deliberately does NOT
// move the actual SLA number. Real research showed the credible version
// of this pattern adjusts priority/attention within a fixed, transparent
// SLA, never the number itself silently — an SLA is often a genuine
// commitment, and a moved target undermines exactly the trust the
// Automation Trust work exists to build. This surfaces signals for a
// human to weigh; nothing here ever escalates, reclassifies, or changes
// anything on its own.
//
// Reopen count and reply frequency are fully deterministic — counted
// from data already loaded, zero AI, zero cost, always visible. Sentiment
// is the one genuinely AI-dependent piece, so it stays click-triggered,
// exactly like the existing "Ask AI" mitigation/RCA buttons — never
// automatic, never silent.
function RiskSignalsPanel({ incident }) {
  const [comments, setComments] = useState([]);
  const [sentiment, setSentiment] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    supabase.from("incident_comments").select("body, author_type, created_at").eq("incident_id", incident.id)
      .then(({ data }) => setComments(data || []));
  }, [incident.id]);

  const reopenCount = (incident.incident_timeline || []).filter((t) => t.note === "Reopened by customer").length;
  const customerReplies = comments.filter((c) => c.author_type === "customer");
  const daysOpen = Math.max(1, (Date.now() - new Date(incident.created_at).getTime()) / 86400000);
  const replyRate = customerReplies.length ? (customerReplies.length / daysOpen).toFixed(1) : 0;

  async function analyzeSentiment() {
    if (customerReplies.length === 0) return;
    setAnalyzing(true);
    const recentText = customerReplies.slice(-3).map((c) => redactPII(c.body)).join("\n---\n");
    const result = await askAI(
      "Read these customer messages about a support ticket. Respond with exactly one word: Frustrated, Neutral, or Satisfied.",
      recentText
    );
    setSentiment(result?.trim() || "Unclear");
    setAnalyzing(false);
  }

  const sentimentColor = { Frustrated: COLORS.red, Neutral: COLORS.muted, Satisfied: COLORS.teal };

  return (
    <Panel title="Risk signals — for you to weigh, nothing here changes the SLA automatically" icon={AlertTriangle}>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="p-2.5 rounded-lg text-center" style={{ background: COLORS.surfaceHi, border: `1px solid ${reopenCount > 0 ? COLORS.amber + "55" : COLORS.border}` }}>
          <div className="sd-display text-xl font-semibold" style={{ color: reopenCount > 0 ? COLORS.amber : COLORS.text }}>{reopenCount}</div>
          <div className="text-[11px]" style={{ color: COLORS.muted }}>Times reopened</div>
        </div>
        <div className="p-2.5 rounded-lg text-center" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
          <div className="sd-display text-xl font-semibold" style={{ color: COLORS.text }}>{replyRate}/day</div>
          <div className="text-[11px]" style={{ color: COLORS.muted }}>Customer reply rate</div>
        </div>
      </div>

      <div className="flex items-center justify-between p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
        <div>
          <div className="text-[11px]" style={{ color: COLORS.muted }}>Customer sentiment</div>
          {sentiment ? (
            <div className="text-sm font-semibold" style={{ color: sentimentColor[sentiment] || COLORS.text }}>{sentiment}</div>
          ) : (
            <div className="text-xs" style={{ color: COLORS.faint }}>Not analyzed yet</div>
          )}
        </div>
        <button onClick={analyzeSentiment} disabled={analyzing || customerReplies.length === 0} className="sd-btn-g text-xs">
          {analyzing ? "Reading…" : "Analyze"}
        </button>
      </div>
      {customerReplies.length === 0 && <p className="text-[11px] mt-1.5" style={{ color: COLORS.faint }}>No customer replies yet to analyze.</p>}
    </Panel>
  );
}

/* ============================== QUOTE REQUESTS PANEL ============================== */
// Extends the exact no-login vendor-portal pattern already proven twice
// tonight to quote comparison specifically — the thing research confirmed
// SME procurement teams value most, and the exact mechanism the leading
// SME-focused competitor is praised for. No cap on invited vendors,
// unlike that competitor's own free tier (capped at three).
function QuoteRequestsPanel({ org, vendors, onOpenIncident, showToast }) {
  const [requests, setRequests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [description, setDescription] = useState("");
  const [pickedVendorIds, setPickedVendorIds] = useState([]);
  const [openIncidents, setOpenIncidents] = useState([]);
  const [linkedIncidentId, setLinkedIncidentId] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("quote_requests").select("*, incidents(display_id, title)").order("created_at", { ascending: false });
    setRequests(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Self-contained, lightweight fetch — closes the "no link back to the
  // incident that prompted this" gap without threading the full incidents
  // array through VendorsView, which doesn't otherwise need it.
  useEffect(() => {
    supabase.from("incidents").select("id, display_id, title").is("resolved_at", null).order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => setOpenIncidents(data || []));
  }, []);

  function toggleVendor(id) {
    setPickedVendorIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function createRequest() {
    if (!description.trim()) { showToast("Describe what you need a quote for"); return; }
    if (pickedVendorIds.length === 0) { showToast("Pick at least one vendor to invite"); return; }
    const displayId = `RFQ-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data: { session } } = await supabase.auth.getSession();
    const { data: qr, error } = await supabase.from("quote_requests").insert({
      org_id: org.id, display_id: displayId, description: redactPII(description), created_by: session?.user?.id || null,
      incident_id: linkedIncidentId || null,
    }).select().single();
    if (error) { showToast(error.message); return; }
    await supabase.from("quote_request_vendors").insert(
      pickedVendorIds.map((vid) => ({ quote_request_id: qr.id, vendor_id: vid, org_id: org.id }))
    );
    setDescription(""); setPickedVendorIds([]); setLinkedIncidentId("");
    showToast("Sent — each vendor will get an email with a link to quote");
    await load();
  }

  return (
    <>
      {selected ? (
        <QuoteRequestDetail request={selected} org={org} onBack={() => setSelected(null)} onChanged={load} onOpenIncident={onOpenIncident} showToast={showToast} />
      ) : (
        <>
          <Panel title="Request quotes" icon={Truck}>
            <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
              Each vendor gets an emailed link — no account needed, same as vendor issue tracking. Prices come back side by side, no spreadsheet required.
            </p>
            <Field label="What do you need a quote for?"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="sd-in3" /></Field>
            <Field label="Related incident (optional)">
              <select value={linkedIncidentId} onChange={(e) => setLinkedIncidentId(e.target.value)} className="sd-in3">
                <option value="">Not related to a specific incident</option>
                {openIncidents.map((i) => <option key={i.id} value={i.id}>{i.display_id} — {i.title}</option>)}
              </select>
            </Field>
            <Field label="Invite vendors">
              <div className="flex flex-wrap gap-1.5">
                {vendors.map((v) => (
                  <button key={v.id} type="button" onClick={() => toggleVendor(v.id)} className="text-xs px-2.5 py-1 rounded-full"
                    style={{ background: pickedVendorIds.includes(v.id) ? COLORS.amber + "22" : COLORS.surfaceHi, color: pickedVendorIds.includes(v.id) ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>
                    {v.name}
                  </button>
                ))}
              </div>
              {vendors.length === 0 && <p className="text-xs mt-1" style={{ color: COLORS.faint }}>Add a vendor first.</p>}
            </Field>
            <button onClick={createRequest} className="sd-btn-g">Send quote request</button>
          </Panel>

          <Panel title="Quote requests" icon={Truck}>
            <div className="space-y-2">
              {requests.map((r) => (
                <button key={r.id} onClick={() => setSelected(r)} className="w-full text-left p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: COLORS.text }}>{r.description}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase" style={{ color: r.status === "awarded" ? COLORS.teal : COLORS.amber, background: (r.status === "awarded" ? COLORS.teal : COLORS.amber) + "22" }}>{r.status}</span>
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>
                    {r.display_id}{r.incidents ? ` · re: ${r.incidents.display_id} — ${r.incidents.title}` : ""}
                  </div>
                </button>
              ))}
              {requests.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No quote requests yet.</p>}
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

function QuoteRequestDetail({ request, org, onBack, onChanged, onOpenIncident, showToast }) {
  const [responses, setResponses] = useState([]);

  const load = useCallback(async () => {
    const { data } = await supabase.from("quote_request_vendors").select("*, vendors(name)").eq("quote_request_id", request.id).order("quoted_price", { ascending: true, nullsFirst: false });
    setResponses(data || []);
  }, [request.id]);
  useEffect(() => { load(); }, [load]);

  async function award(vendorId) {
    await supabase.from("quote_requests").update({ status: "awarded", awarded_vendor_id: vendorId }).eq("id", request.id);
    // The actual, useful payoff of comparing quotes in one place: the
    // winning price becomes a real purchase record automatically, no
    // re-typing the number that was just compared.
    const won = responses.find((r) => r.vendor_id === vendorId);
    const displayId = `PO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    await supabase.from("vendor_purchases").insert({
      org_id: org.id, vendor_id: vendorId, display_id: displayId, description: request.description,
      agreed_price: won?.quoted_price || null, expected_delivery_date: won?.valid_until || null,
    });
    showToast("Awarded — a purchase record was created automatically");
    await onChanged();
    onBack();
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to quote requests</button>
      <Panel title={request.description} icon={Truck}>
        <div className="sd-mono text-xs mb-1" style={{ color: COLORS.faint }}>{request.display_id}</div>
        {request.incidents && (
          <button onClick={() => onOpenIncident?.(request.incident_id)} className="text-xs underline mb-2 block" style={{ color: COLORS.blue }}>
            Related to: {request.incidents.display_id} — {request.incidents.title}
          </button>
        )}
        <div className="space-y-2">
          {responses.map((r) => (
            <div key={r.id} className="p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: COLORS.text }}>{r.vendors?.name}</span>
                {r.quoted_price != null ? (
                  <span className="sd-mono text-sm font-semibold" style={{ color: COLORS.amber }}>R{r.quoted_price}</span>
                ) : (
                  <span className="text-[11px]" style={{ color: COLORS.faint }}>No response yet</span>
                )}
              </div>
              {r.notes && <p className="text-xs mt-1" style={{ color: COLORS.muted }}>{r.notes}</p>}
              {r.valid_until && <p className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>Valid until {r.valid_until}</p>}
              {r.quoted_price != null && request.status !== "awarded" && (
                <button onClick={() => award(r.vendor_id)} className="text-xs mt-2 px-2.5 py-1 rounded-lg font-semibold" style={{ background: COLORS.teal, color: "#0A1120" }}>Award to this vendor</button>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================== COMMAND SUMMARY STATS (folded into header) ============================== */
// The real, buildable version of "AI Incident Commander" — a human-driven
// cockpit view, not an autonomous agent. Originally its own boxed panel;
// folded directly into the header as part of the incident-detail
// restructure, since having "affected assets: 3" as a standalone panel
// AND a full Affected Assets panel further down was real, flagged
// duplication — the same fact shown twice at different scroll depths.
// Now it's one compact count in the header; the full interactive list
// still lives in "Related" below, not duplicated. AI assists exactly as
// it already does everywhere else tonight (click-triggered
// suggestions, human confirms) — nothing here acts on its own.
function CommandSummaryPanel({ incident, incidents, lookups }) {
  const [affectedCount, setAffectedCount] = useState(0);

  useEffect(() => {
    supabase.from("incident_cis").select("ci_id", { count: "exact", head: true }).eq("incident_id", incident.id)
      .then(({ count }) => setAffectedCount(count || 0));
  }, [incident.id]);

  // Deterministic matching, same "prefer determinism" lesson as the
  // dependency mapper — same category or same root cause, not resolved,
  // not this incident itself.
  const related = incidents.filter((i) =>
    i.id !== incident.id && !i.resolved_at &&
    ((incident.category?.id && i.category?.id === incident.category.id) ||
     (incident.rca_category?.id && i.rca_category?.id === incident.rca_category.id))
  ).slice(0, 5);

  const timeOpen = Date.now() - new Date(incident.created_at).getTime();

  return (
    <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="p-2 rounded-lg text-center" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
          <div className="sd-display text-lg font-semibold" style={{ color: COLORS.amber }}>{fmtDuration(timeOpen)}</div>
          <div className="text-[10px]" style={{ color: COLORS.muted }}>Time open</div>
        </div>
        <div className="p-2 rounded-lg text-center" style={{ background: COLORS.surfaceHi, border: `1px solid ${affectedCount > 0 ? COLORS.red + "55" : COLORS.border}` }}>
          <div className="sd-display text-lg font-semibold" style={{ color: affectedCount > 0 ? COLORS.red : COLORS.text }}>{affectedCount}</div>
          <div className="text-[10px]" style={{ color: COLORS.muted }}>Affected assets</div>
        </div>
        <div className="p-2 rounded-lg text-center" style={{ background: COLORS.surfaceHi, border: `1px solid ${related.length > 0 ? COLORS.amber + "55" : COLORS.border}` }}>
          <div className="sd-display text-lg font-semibold" style={{ color: related.length > 0 ? COLORS.amber : COLORS.text }}>{related.length}</div>
          <div className="text-[10px]" style={{ color: COLORS.muted }}>Related open incidents</div>
        </div>
      </div>

      {related.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold mb-1" style={{ color: COLORS.faint }}>MIGHT BE THE SAME UNDERLYING ISSUE</div>
          {related.map((r) => (
            <div key={r.id} className="text-xs py-1" style={{ color: COLORS.muted }}>
              <span className="sd-mono" style={{ color: COLORS.faint }}>{r.display_id}</span> — {r.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== INCIDENT LAYOUT PANEL (Settings) ============= */
// Real gap closed: every org previously got the exact same Incident
// Detail layout, no admin control. Extends the same Template & Modules
// pattern already built rather than inventing a new mechanism — org's
// own choice always wins, safe defaults if never touched.
const OPTIONAL_INCIDENT_PANELS = [
  { key: "affectedAssets", label: "Affected assets" },
  { key: "vendor", label: "Related vendor" },
  { key: "problemLink", label: "Problem link" },
  { key: "customFields", label: "Custom fields" },
  { key: "timeSpent", label: "Time spent" },
];
const INCIDENT_SECTIONS = [
  { key: "workThisIncident", label: "\"Work this incident\" open by default", fallback: true },
  { key: "activity", label: "\"Activity\" open by default", fallback: true },
  { key: "filesApproval", label: "\"Files & approval\" open by default", fallback: false },
];

function IncidentLayoutPanel({ org, onOrgUpdated, showToast }) {
  const [hiddenPanels, setHiddenPanels] = useState(org.incident_layout?.hiddenPanels || []);
  const [sectionsOpen, setSectionsOpen] = useState(org.incident_layout?.sectionsOpen || {});

  function togglePanel(key) {
    setHiddenPanels((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  }
  function toggleSection(key, fallback) {
    const current = sectionsOpen[key] === undefined ? fallback : sectionsOpen[key];
    setSectionsOpen((prev) => ({ ...prev, [key]: !current }));
  }

  async function save() {
    const newLayout = { hiddenPanels, sectionsOpen };
    await supabase.from("organisations").update({ incident_layout: newLayout }).eq("id", org.id);
    showToast("Saved");
    await onOrgUpdated({ ...org, incident_layout: newLayout });
  }

  return (
    <Panel title="Incident page layout" icon={Layers}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Every team's priorities differ — hide panels your team never uses, and choose which sections open automatically. Status, Assignee, Resolve, and Preventative Actions always stay, since those are core to working any incident.
      </p>

      <div className="text-xs font-semibold mb-2" style={{ color: COLORS.faint }}>OPTIONAL PANELS</div>
      <div className="space-y-1.5 mb-4">
        {OPTIONAL_INCIDENT_PANELS.map((p) => (
          <label key={p.key} className="flex items-center justify-between text-sm p-2 rounded-lg cursor-pointer" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <span style={{ color: COLORS.text }}>{p.label}</span>
            <input type="checkbox" checked={!hiddenPanels.includes(p.key)} onChange={() => togglePanel(p.key)} />
          </label>
        ))}
      </div>

      <div className="text-xs font-semibold mb-2" style={{ color: COLORS.faint }}>SECTION DEFAULTS</div>
      <div className="space-y-1.5 mb-4">
        {INCIDENT_SECTIONS.map((s) => {
          const isOpen = sectionsOpen[s.key] === undefined ? s.fallback : sectionsOpen[s.key];
          return (
            <label key={s.key} className="flex items-center justify-between text-sm p-2 rounded-lg cursor-pointer" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.text }}>{s.label}</span>
              <input type="checkbox" checked={isOpen} onChange={() => toggleSection(s.key, s.fallback)} />
            </label>
          );
        })}
      </div>

      <button onClick={save} className="sd-btn-p6">Save</button>
    </Panel>
  );
}

/* ============================== RCA ANALYSIS PANEL ============================== */
// The real gap this closes: rca_categories is a label picked from a
// dropdown — this is the actual reasoning trail behind that label.
// Two standard techniques, matched to the research's central finding:
// the most common real failure isn't lacking a method, it's using the
// wrong one. 5 Whys suits a single linear cause; Fishbone suits multiple
// interacting factors. AI suggests which fits — click-triggered, human
// decides, same pattern as every other AI touchpoint tonight — rather
// than forcing everyone through one fixed template regardless of fit.
const FISHBONE_CATEGORIES = [
  { key: "man", label: "People" }, { key: "machine", label: "Machine/Technology" },
  { key: "method", label: "Method/Process" }, { key: "material", label: "Material/Inputs" },
  { key: "measurement", label: "Measurement" }, { key: "milieu", label: "Environment" },
];

function RCAAnalysisPanel({ incident, problemId, org, lookups, onCategorySuggested, showToast }) {
  const [analyses, setAnalyses] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [method, setMethod] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [problemStatement, setProblemStatement] = useState("");
  const [whys, setWhys] = useState([""]);
  const [fishbone, setFishbone] = useState({ man: "", machine: "", method: "", material: "", measurement: "", milieu: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const column = incident ? "incident_id" : "problem_id";
    const id = incident ? incident.id : problemId;
    const { data } = await supabase.from("rca_analyses").select("*").eq(column, id).order("created_at", { ascending: false });
    setAnalyses(data || []);
  }, [incident, problemId]);
  useEffect(() => { load(); }, [load]);

  async function suggestMethod() {
    if (!problemStatement.trim()) { showToast("Describe the problem first"); return; }
    setSuggesting(true);
    const result = await askAI(
      "A user is investigating a technical incident's root cause. If the problem sounds like it has one clear, single, linear chain of causes, respond with exactly: five_whys. If it sounds like several different factors could be combining to cause it (people, process, technology, environment all potentially involved), respond with exactly: fishbone. Respond with only that one word, nothing else.",
      redactPII(problemStatement)
    );
    setSuggesting(false);
    const clean = (result || "").trim().toLowerCase();
    if (clean.includes("fishbone")) setMethod("fishbone");
    else setMethod("five_whys");
  }

  function updateWhy(idx, value) {
    setWhys((prev) => prev.map((w, i) => i === idx ? value : w));
  }
  function addWhy() {
    // Directly addresses the documented failure: "most root cause
    // analyses stop one why too early" — capped at 5, matching the
    // technique's own name, not unlimited.
    if (whys.length < 5) setWhys((prev) => [...prev, ""]);
  }

  async function save() {
    if (!problemStatement.trim()) { showToast("Describe the problem first"); return; }
    if (!method) { showToast("Choose a method, or let AI suggest one"); return; }
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    const content = method === "five_whys"
      ? { whys: whys.filter((w) => w.trim()).map(redactPII) }
      : Object.fromEntries(FISHBONE_CATEGORIES.map((c) => [c.key, redactPII(fishbone[c.key])]));
    const { error } = await supabase.from("rca_analyses").insert({
      org_id: org.id, incident_id: incident ? incident.id : null, problem_id: incident ? null : problemId,
      method, problem_statement: redactPII(problemStatement), content,
      created_by: session?.user?.id || null,
    });
    setSaving(false);
    if (error) { showToast(error.message); return; }
    setShowNew(false); setMethod(""); setProblemStatement(""); setWhys([""]);
    setFishbone({ man: "", machine: "", method: "", material: "", measurement: "", milieu: "" });
    showToast("Analysis saved");
    await load();
  }

  // Closes the gap between this panel and the existing "Root cause
  // category" dropdown in Resolve — previously two separate things with
  // near-identical names, unconnected. Click-triggered, human confirms,
  // same pattern as every other AI suggestion tonight — this only fills
  // in the dropdown above, it never saves anything on its own.
  const [suggestingCategory, setSuggestingCategory] = useState(false);
  async function suggestCategoryFrom(analysis) {
    if (!lookups?.rcaCategories?.length || !onCategorySuggested) return;
    setSuggestingCategory(true);
    const names = lookups.rcaCategories.map((r) => r.name).join(", ");
    const summary = analysis.method === "five_whys"
      ? (analysis.content.whys || []).join(" → ")
      : Object.entries(analysis.content).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ");
    const result = await askAI(
      `You are an ITSM assistant. Pick the single best-fitting root cause category from this exact list: ${names}. Respond with ONLY the category name, nothing else.`,
      `Problem: ${analysis.problem_statement}\nAnalysis: ${summary}`
    );
    setSuggestingCategory(false);
    const match = lookups.rcaCategories.find((r) => result && result.trim().toLowerCase().includes(r.name.toLowerCase()));
    if (match) { onCategorySuggested(match.id); showToast("Category suggested above — review and confirm in Resolve"); }
    else showToast("Couldn't find a confident match — pick manually");
  }

  return (
    <Panel title="Root cause analysis" icon={ScanEye}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        The reasoning behind the root cause category, not just the label. Two guided techniques, matched to the problem — not one fixed template forced on every incident.
      </p>

      <div className="space-y-2 mb-3">
        {analyses.map((a) => (
          <div key={a.id} className="p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold" style={{ color: COLORS.amber }}>{a.method === "five_whys" ? "5 Whys" : "Fishbone"}</span>
              <span className="text-[10px]" style={{ color: COLORS.faint }}>{new Date(a.created_at).toLocaleDateString()}</span>
            </div>
            <p className="text-sm mb-2" style={{ color: COLORS.text }}>{a.problem_statement}</p>
            {a.method === "five_whys" ? (
              <div className="space-y-1">
                {(a.content.whys || []).map((w, i) => (
                  <div key={i} className="text-xs" style={{ color: COLORS.muted }}>Why {i + 1}: {w}</div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {FISHBONE_CATEGORIES.filter((c) => a.content[c.key]).map((c) => (
                  <div key={c.key} className="text-xs" style={{ color: COLORS.muted }}><span style={{ color: COLORS.faint }}>{c.label}:</span> {a.content[c.key]}</div>
                ))}
              </div>
            )}
            {onCategorySuggested && (
              <button onClick={() => suggestCategoryFrom(a)} disabled={suggestingCategory} className="text-xs mt-2" style={{ color: COLORS.teal }}>
                {suggestingCategory ? "…" : "Use this to suggest a category above"}
              </button>
            )}
          </div>
        ))}
        {analyses.length === 0 && !showNew && <p className="text-xs" style={{ color: COLORS.faint }}>No structured analysis run yet.</p>}
      </div>

      {!showNew ? (
        <button onClick={() => setShowNew(true)} className="sd-btn-g">Run a root cause analysis</button>
      ) : (
        <div className="rounded-lg p-3" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
          <Field label="Problem statement — be specific, with numbers if you have them">
            <textarea value={problemStatement} onChange={(e) => setProblemStatement(e.target.value)} rows={2} className="sd-in3" placeholder="e.g. Tier 1 tickets rose from 45/week to 112/week starting Monday" />
          </Field>

          <div className="flex gap-2 mb-3">
            <button onClick={() => setMethod("five_whys")} className="text-xs px-2.5 py-1.5 rounded-full" style={{ background: method === "five_whys" ? COLORS.amber + "22" : COLORS.surfaceHi, color: method === "five_whys" ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>5 Whys — one clear cause</button>
            <button onClick={() => setMethod("fishbone")} className="text-xs px-2.5 py-1.5 rounded-full" style={{ background: method === "fishbone" ? COLORS.amber + "22" : COLORS.surfaceHi, color: method === "fishbone" ? COLORS.amber : COLORS.muted, border: `1px solid ${COLORS.border}` }}>Fishbone — several factors</button>
            <button onClick={suggestMethod} disabled={suggesting} className="text-xs" style={{ color: COLORS.teal }}>{suggesting ? "…" : "AI: which fits?"}</button>
          </div>

          {method === "five_whys" && (
            <div className="mb-3">
              {whys.map((w, i) => (
                <Field key={i} label={`Why ${i + 1}${i > 0 ? " (why did that happen?)" : " did this happen?"}`}>
                  <input value={w} onChange={(e) => updateWhy(i, e.target.value)} className="sd-in3" />
                </Field>
              ))}
              {whys.length < 5 && <button onClick={addWhy} className="text-xs" style={{ color: COLORS.amber }}>+ Go one level deeper</button>}
            </div>
          )}

          {method === "fishbone" && (
            <div className="mb-3">
              {FISHBONE_CATEGORIES.map((c) => (
                <Field key={c.key} label={c.label}>
                  <textarea value={fishbone[c.key]} onChange={(e) => setFishbone((prev) => ({ ...prev, [c.key]: e.target.value }))} rows={1} className="sd-in3" placeholder="Possible causes in this category…" />
                </Field>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={save} disabled={saving || !method} className="sd-btn-p">{saving ? "Saving…" : "Save analysis"}</button>
            <button onClick={() => setShowNew(false)} className="sd-btn-g">Cancel</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ============================== KB ARTICLES PANEL (Settings) ============= */
// The content layer behind portal-side deflection — research named
// content quality, not technology, as "the most common reason self-
// service portals fail." Staff authors these; the portal surfaces them
// automatically at the moment a customer is typing a ticket.
function KBArticlesPanel({ org, showToast }) {
  const [articles, setArticles] = useState([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("kb_articles").select("*").order("created_at", { ascending: false });
    setArticles(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!title.trim() || !body.trim()) { showToast("Give it a title and some content"); return; }
    const { data: { session } } = await supabase.auth.getSession();
    if (editing) {
      await supabase.from("kb_articles").update({ title: redactPII(title), body: redactPII(body), updated_at: new Date().toISOString() }).eq("id", editing.id);
    } else {
      await supabase.from("kb_articles").insert({ org_id: org.id, title: redactPII(title), body: redactPII(body), created_by: session?.user?.id || null });
    }
    setTitle(""); setBody(""); setEditing(null);
    showToast("Saved");
    await load();
  }
  function startEdit(a) {
    setEditing(a); setTitle(a.title); setBody(a.body);
  }
  async function remove(id) {
    await supabase.from("kb_articles").delete().eq("id", id);
    await load();
  }

  return (
    <Panel title="Self-service articles" icon={ScanEye}>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>
        Shown automatically to customers as they type on the portal, before they submit a ticket — not a separate help page nobody visits. Write what a customer would actually search for as the title.
      </p>
      <div className="space-y-2 mb-4">
        {articles.map((a) => (
          <div key={a.id} className="p-2.5 rounded-lg" style={{ background: COLORS.surfaceHi, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: COLORS.text }}>{a.title}</span>
              <div className="flex gap-2">
                <button onClick={() => startEdit(a)} className="text-xs" style={{ color: COLORS.amber }}>Edit</button>
                <button onClick={() => remove(a.id)}><Trash2 size={13} color={COLORS.faint} /></button>
              </div>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: COLORS.faint }}>
              {a.view_count} shown · {a.helpful_count} helpful · {a.not_helpful_count} not helpful
            </div>
          </div>
        ))}
        {articles.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No articles yet — nothing to deflect with until there's real content here.</p>}
      </div>
      <Field label="Title — write it the way a customer would ask"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. How do I reset my password?" className="sd-in5" /></Field>
      <Field label="Answer"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="sd-in5" /></Field>
      <div className="flex gap-2">
        <button onClick={save} className="sd-btn-p6">{editing ? "Save changes" : "Add article"}</button>
        {editing && <button onClick={() => { setEditing(null); setTitle(""); setBody(""); }} className="sd-btn-g">Cancel</button>}
      </div>
    </Panel>
  );
}

/* ============================== AMBIENT FLAG TOAST ============================== */
// The actual "spontaneous, any screen" mechanism — reuses the fact that
// this renders at the MainApp level already, visible regardless of
// which tab someone's on. Distinct from the generic toast: this one
// needs a real action (View) versus a real non-action (auto-dismiss),
// since that distinction is what feeds the feedback-adjusted flagging.
function AmbientFlagToast({ flag, onView, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(), 12000); // Auto-dismiss counts as "dismissed" — a real signal, not lost.
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag]);

  const isBreaching = flag.type === "newly_breaching";
  const color = isBreaching ? COLORS.red : COLORS.amber;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm px-4">
      <div className="rounded-xl p-3 shadow-xl" style={{ background: COLORS.surface, border: `1px solid ${color}55` }}>
        <div className="flex items-center gap-2 mb-1.5">
          <AlertTriangle size={14} color={color} />
          <span className="text-xs font-semibold" style={{ color }}>
            {isBreaching ? "Just breached SLA" : "Might be ready to close"}
          </span>
        </div>
        <p className="text-sm mb-2 truncate" style={{ color: COLORS.text }}>{flag.displayId} — {flag.title}</p>
        <div className="flex gap-2">
          <button onClick={onView} className="text-xs px-2.5 py-1 rounded-lg font-semibold" style={{ background: color, color: "#0A1120" }}>View</button>
          <button onClick={onDismiss} className="text-xs px-2.5 py-1 rounded-lg" style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

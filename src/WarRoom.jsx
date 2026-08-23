import React, { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Users, Send, Sparkles, Check, Radio } from "lucide-react";
import { supabase } from "./supabaseClient.js";
import { redactPII } from "./lib/redact.js";
import { askAI } from "./lib/ai.js";

const COLORS = {
  bg: "#0A1120", surface: "#121B2E", surfaceHi: "#182338", border: "#232F47",
  amber: "#F5A623", teal: "#2DD4BF", red: "#F0483E",
  text: "#E8ECF3", muted: "#8B96AB", faint: "#838EA9",
};

const NARRATIVE_FIELDS = [
  { key: "what_we_know", label: "What we know" },
  { key: "what_tried", label: "What we've tried" },
  { key: "whats_next", label: "What's next" },
];

// Passive-monitor thresholds — matches the spec's "~10-15 minutes" for a
// stale narrative, with a cooldown so it never posts more than one nudge
// per window regardless of how many 2-minute checks run in between.
const MONITOR_INTERVAL_MS = 120000;
const STALE_MINUTES_THRESHOLD = 12;
const NUDGE_COOLDOWN_MS = 15 * 60000;
const PRESENCE_HEARTBEAT_MS = 20000;
// "Viewing now" vs "viewed, inactive" — needs to be comfortably longer than
// one heartbeat interval so a normal gap between beats never flickers
// someone's own status.
const PRESENCE_ACTIVE_WINDOW_MS = 45000;

// Real coordination for Critical incidents, replacing the old "War Room"
// button that just fired one Slack/Teams message with no surface behind
// it. A shared narrative (edited directly, live for everyone), a separate
// comment thread, honest presence (no cursors/avatars — just who's
// actually looking at this right now), a calm AI monitor that only speaks
// up when something's actually stale or unassigned, and a manual summarize
// button using the same click-triggered AI pattern as the rest of the app.
export default function WarRoomView({ incident, org, members, showToast, onBack }) {
  const [warRoom, setWarRoom] = useState(null);
  const [narrative, setNarrative] = useState({ what_we_know: "", what_tried: "", whats_next: "" });
  const [comments, setComments] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [loading, setLoading] = useState(true);

  // Tracks which narrative fields the person in front of this screen is
  // actively mid-edit on, so an incoming realtime update from someone else
  // never clobbers what they're currently typing — only fields nobody's
  // touched locally get overwritten by the remote value.
  const dirtyRef = useRef({ what_we_know: false, what_tried: false, whats_next: false });
  const saveTimers = useRef({});
  const stateRef = useRef({ narrative, comments, warRoom });
  stateRef.current = { narrative, comments, warRoom };

  const emailFor = useCallback((userId) => {
    if (!userId) return "System";
    return members?.find((m) => m.user_id === userId)?.email || "Someone";
  }, [members]);

  const init = useCallback(async () => {
    const { data, error } = await supabase.rpc("open_war_room", { target_incident_id: incident.id });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      showToast(error?.message || "Couldn't open the War Room");
      onBack();
      return;
    }
    setWarRoom(row);
    setNarrative({ what_we_know: row.what_we_know || "", what_tried: row.what_tried || "", whats_next: row.whats_next || "" });
    setLoading(false);
  }, [incident.id, showToast, onBack]);
  useEffect(() => { init(); }, [init]);

  const loadComments = useCallback(async (warRoomId) => {
    const { data } = await supabase.from("war_room_comments").select("*").eq("war_room_id", warRoomId).order("created_at", { ascending: true });
    setComments(data || []);
  }, []);

  const loadParticipants = useCallback(async () => {
    const { data } = await supabase.rpc("war_room_participants", { target_incident_id: incident.id });
    setParticipants(data || []);
  }, [incident.id]);

  useEffect(() => {
    if (!warRoom?.id) return;
    loadComments(warRoom.id);
    loadParticipants();
    // Polling stays as a fallback under Realtime, not a replacement for it —
    // if a postgres_changes event ever gets missed (a dropped connection,
    // a tab that was briefly backgrounded), this puts a ceiling of a few
    // seconds on how stale anyone's view can get instead of forever.
    const commentsPoll = setInterval(() => loadComments(warRoom.id), 20000);
    const participantsPoll = setInterval(loadParticipants, 15000);
    return () => { clearInterval(commentsPoll); clearInterval(participantsPoll); };
  }, [warRoom?.id, loadComments, loadParticipants]);

  useEffect(() => {
    if (!warRoom?.id) return;
    // supabase-js query/rpc builders are lazy thenables — the request only
    // actually fires once something awaits or .then()s them. A bare call
    // with no await silently builds the request and never sends it, with
    // no error either (nothing to fail) — caught by checking war_room_
    // presence stayed empty in the database despite this "running" fine.
    const beat = async () => { await supabase.rpc("heartbeat_war_room_presence", { target_war_room_id: warRoom.id }); };
    beat();
    const t = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [warRoom?.id]);

  useEffect(() => {
    if (!warRoom?.id) return;
    const channel = supabase.channel(`war-room-${warRoom.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "war_rooms", filter: `id=eq.${warRoom.id}` }, (payload) => {
        const row = payload.new;
        setWarRoom(row);
        setNarrative((prev) => ({
          what_we_know: dirtyRef.current.what_we_know ? prev.what_we_know : row.what_we_know,
          what_tried: dirtyRef.current.what_tried ? prev.what_tried : row.what_tried,
          whats_next: dirtyRef.current.whats_next ? prev.whats_next : row.whats_next,
        }));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "war_room_comments", filter: `war_room_id=eq.${warRoom.id}` }, (payload) => {
        setComments((prev) => (prev.some((c) => c.id === payload.new.id) ? prev : [...prev, payload.new]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "war_room_comments", filter: `war_room_id=eq.${warRoom.id}` }, (payload) => {
        setComments((prev) => prev.map((c) => (c.id === payload.new.id ? payload.new : c)));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "war_room_presence", filter: `war_room_id=eq.${warRoom.id}` }, () => {
        loadParticipants();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [warRoom?.id, loadParticipants]);

  function onNarrativeChange(field, value) {
    setNarrative((prev) => ({ ...prev, [field]: value }));
    dirtyRef.current[field] = true;
    clearTimeout(saveTimers.current[field]);
    saveTimers.current[field] = setTimeout(() => saveNarrativeField(field, value), 1500);
  }
  async function saveNarrativeField(field, value) {
    dirtyRef.current[field] = false;
    if (!warRoom?.id) return;
    await supabase.from("war_rooms").update({ [field]: value }).eq("id", warRoom.id);
  }
  function onNarrativeBlur(field) {
    clearTimeout(saveTimers.current[field]);
    saveNarrativeField(field, narrative[field]);
  }
  useEffect(() => () => { Object.values(saveTimers.current).forEach(clearTimeout); }, []);

  async function postComment() {
    if (!newComment.trim() || !warRoom?.id) return;
    setPosting(true);
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from("war_room_comments").insert({
      org_id: org.id, war_room_id: warRoom.id, author_user_id: session?.user?.id || null,
      author_type: "staff", body: redactPII(newComment),
    });
    setPosting(false);
    if (error) { showToast(error.message); return; }
    setNewComment("");
    loadComments(warRoom.id);
  }

  async function promote(commentId, field) {
    const { error } = await supabase.rpc("promote_war_room_comment", { comment_id: commentId, target_field: field });
    if (error) { showToast(error.message); return; }
    showToast(`Promoted to "${NARRATIVE_FIELDS.find((f) => f.key === field)?.label}"`);
    loadComments(warRoom.id);
  }

  async function postSystemComment(body, warRoomId) {
    await supabase.from("war_room_comments").insert({ org_id: org.id, war_room_id: warRoomId, author_type: "system", body });
  }

  async function summarize() {
    setSummarizing(true);
    const combined = `What we know: ${narrative.what_we_know}\nWhat we've tried: ${narrative.what_tried}\nWhat's next: ${narrative.whats_next}\n\nRecent discussion:\n${comments.slice(-10).map((c) => c.body).join("\n")}`;
    const result = await askAI(
      "You are an ITSM assistant summarizing a live incident war room for someone who just joined. In 3-4 short plain-language sentences, say where things stand right now. No preamble.",
      redactPII(combined)
    );
    await postSystemComment(`Summary: ${result}`, warRoom.id);
    setSummarizing(false);
    loadComments(warRoom.id);
  }

  // Calm by design: runs only while this view is open, checks at most once
  // per 2 minutes, and a cooldown after its own last nudge means it can
  // never turn into running commentary — one short, non-judgmental line,
  // then silence until something's actually still wrong next time it looks.
  useEffect(() => {
    if (!warRoom?.id || incident.resolved_at) return;
    const t = setInterval(runMonitorCheck, MONITOR_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warRoom?.id, incident.resolved_at]);

  async function runMonitorCheck() {
    const { narrative: n, comments: c, warRoom: wr } = stateRef.current;
    if (!wr) return;
    const lastSystemComment = [...c].reverse().find((x) => x.author_type === "system");
    const cooldownOk = !lastSystemComment || (Date.now() - new Date(lastSystemComment.created_at).getTime()) > NUDGE_COOLDOWN_MS;
    if (!cooldownOk) return;

    const staleMinutes = (Date.now() - new Date(wr.last_narrative_update_at).getTime()) / 60000;
    if (staleMinutes >= STALE_MINUTES_THRESHOLD) {
      await postSystemComment(`This narrative hasn't been updated in about ${Math.round(staleMinutes)} minutes — worth a quick update on where things stand?`, wr.id);
      loadComments(wr.id);
      return;
    }

    const combinedText = [n.what_we_know, n.what_tried, n.whats_next, ...c.slice(-6).map((x) => x.body)].join("\n").trim();
    if (combinedText.length < 20) return;
    const result = await askAI(
      "You are quietly monitoring a live incident war room. Reply with exactly one word: YES if the text below clearly mentions an action item or task that has no assignee/owner named, or NO otherwise.",
      redactPII(combinedText)
    );
    if ((result || "").trim().toUpperCase().startsWith("YES")) {
      await postSystemComment("There might be an action item mentioned above with no one assigned yet — worth calling out who's picking it up?", wr.id);
      loadComments(wr.id);
    }
  }

  if (loading || !warRoom) {
    return <div className="p-6 text-center text-sm" style={{ color: COLORS.faint }}>Loading War Room…</div>;
  }

  return (
    <div className="pb-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to incident</button>

      <div className="flex items-center gap-2 mb-1">
        <Radio size={16} color={COLORS.red} />
        <h2 className="sd-display text-base font-semibold" style={{ color: COLORS.text }}>War Room</h2>
        <span className="sd-mono text-xs" style={{ color: COLORS.faint }}>{incident.display_id}</span>
      </div>
      <p className="text-sm mb-4" style={{ color: COLORS.muted }}>{incident.title}</p>

      {/* Presence — plain status per person, no cursors or avatars. Sorted
          never-viewed-first server-side, since that's the one someone
          needs to actually notice. */}
      <div className="rounded-xl p-4 mb-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-3"><Users size={15} color={COLORS.amber} /><h3 className="sd-display text-sm font-semibold">Who's here</h3></div>
        {participants.length === 0 ? (
          <p className="text-xs" style={{ color: COLORS.faint }}>Nobody's been pulled in yet — check the assigned team and category on-call opt-ins in Settings.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {participants.map((p) => {
              const color = p.status === "never_viewed" ? COLORS.red : p.status === "viewing_now" ? COLORS.teal : COLORS.muted;
              const label = p.status === "viewing_now" ? "viewing now" : p.status === "viewed_inactive" ? "viewed, inactive" : "never viewed";
              return (
                <div key={p.user_id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs"
                  style={{ background: p.status === "never_viewed" ? COLORS.red + "18" : COLORS.surfaceHi, border: `1px solid ${p.status === "never_viewed" ? COLORS.red + "55" : COLORS.border}`, color }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: color, display: "inline-block" }} />
                  <span style={{ color: COLORS.text }}>{p.email}</span>
                  <span style={{ color }}>{label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Shared narrative — three fields, each saved independently, so two
          people editing different fields never collide. Any one field
          being edited by the same person at the same moment is rare
          enough that last-write-wins is an honest tradeoff, not a gap. */}
      <div className="rounded-xl p-4 mb-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="sd-display text-sm font-semibold">Shared narrative</h3>
          <button onClick={summarize} disabled={summarizing} className="text-xs flex items-center gap-1" style={{ color: COLORS.teal }}>
            <Sparkles size={12} /> {summarizing ? "Summarizing…" : "Summarize where we are"}
          </button>
        </div>
        <div className="space-y-3">
          {NARRATIVE_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium block mb-1" style={{ color: COLORS.muted }}>{f.label}</label>
              <textarea
                value={narrative[f.key]}
                onChange={(e) => onNarrativeChange(f.key, e.target.value)}
                onBlur={() => onNarrativeBlur(f.key)}
                rows={3}
                className="sd-in3"
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] mt-2" style={{ color: COLORS.faint }}>Last updated {new Date(warRoom.last_narrative_update_at).toLocaleTimeString()}</p>
      </div>

      {/* Free-form discussion, separate from the narrative above — any
          comment can be promoted into one of the three fields with one
          click, so a useful update doesn't get lost in scroll. */}
      <div className="rounded-xl p-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <h3 className="sd-display text-sm font-semibold mb-3">Discussion</h3>
        <div className="space-y-2 mb-3 max-h-80 overflow-y-auto">
          {comments.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No discussion yet.</p>}
          {comments.map((c) => (
            <div key={c.id} className="p-2.5 rounded-lg" style={{ background: c.author_type === "system" ? COLORS.amber + "10" : COLORS.surfaceHi, border: `1px solid ${c.author_type === "system" ? COLORS.amber + "33" : COLORS.border}` }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold" style={{ color: c.author_type === "system" ? COLORS.amber : COLORS.text }}>
                  {c.author_type === "system" ? "AI monitor" : emailFor(c.author_user_id)}
                </span>
                <span className="text-[10px]" style={{ color: COLORS.faint }}>{new Date(c.created_at).toLocaleTimeString()}</span>
              </div>
              <p className="text-sm" style={{ color: COLORS.text }}>{c.body}</p>
              {c.promoted_to_field ? (
                <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: COLORS.teal }}><Check size={11} /> Promoted to {NARRATIVE_FIELDS.find((f) => f.key === c.promoted_to_field)?.label}</p>
              ) : c.author_type === "staff" && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {NARRATIVE_FIELDS.map((f) => (
                    <button key={f.key} onClick={() => promote(c.id, f.key)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}>
                      → {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newComment} onChange={(e) => setNewComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") postComment(); }}
            placeholder="Add to the discussion…" className="sd-in3" style={{ flex: 1 }} />
          <button onClick={postComment} disabled={posting || !newComment.trim()} className="px-3 py-2 rounded-lg shrink-0" style={{ background: COLORS.amber, color: "#1A1200" }}>
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

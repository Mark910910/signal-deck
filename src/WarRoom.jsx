import React, { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Users, Send, Sparkles, Check, Radio, AlertTriangle, Pin } from "lucide-react";
import { supabase } from "./supabaseClient.js";
import { redactPII } from "./lib/redact.js";
import { askAI, isAiUnavailable } from "./lib/ai.js";

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
  const [saveStatus, setSaveStatus] = useState({});
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
  // The value each field held the moment the user started editing it — used
  // as an optimistic-concurrency check on save (see saveNarrativeField).
  // Only updated when a remote value is applied to a non-dirty field, never
  // while the user has a pending local edit, so a concurrent change made by
  // someone else while this user was mid-edit is reliably detected instead
  // of silently overwritten.
  const baselineRef = useRef({ what_we_know: "", what_tried: "", whats_next: "" });
  const saveTimers = useRef({});
  const stateRef = useRef({ narrative, comments, warRoom });
  stateRef.current = { narrative, comments, warRoom };

  const emailFor = useCallback((userId) => {
    if (!userId) return "System";
    return members?.find((m) => m.user_id === userId)?.email || "Someone";
  }, [members]);
  const roleFor = useCallback((userId) => members?.find((m) => m.user_id === userId)?.role || "", [members]);

  const init = useCallback(async () => {
    const { data, error } = await supabase.rpc("open_war_room", { target_incident_id: incident.id });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      showToast(error?.message || "Couldn't open the War Room");
      onBack();
      return;
    }
    setWarRoom(row);
    const initial = { what_we_know: row.what_we_know || "", what_tried: row.what_tried || "", whats_next: row.whats_next || "" };
    setNarrative(initial);
    baselineRef.current = { ...initial };
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
        setNarrative((prev) => {
          const next = { ...prev };
          for (const f of NARRATIVE_FIELDS) {
            if (!dirtyRef.current[f.key]) {
              next[f.key] = row[f.key];
              baselineRef.current[f.key] = row[f.key];
            }
          }
          return next;
        });
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
  function onNarrativeFocus(field) {
    // Pin the baseline to whatever this field holds right now, the moment
    // editing starts — not re-touched again until the edit is either saved
    // or found to conflict, so a remote change that lands mid-edit is
    // compared against what the user actually started from.
    baselineRef.current[field] = stateRef.current.narrative[field];
  }
  async function saveNarrativeField(field, value) {
    if (!warRoom?.id) return;
    const label = NARRATIVE_FIELDS.find((f) => f.key === field)?.label;
    const baseline = baselineRef.current[field];
    setSaveStatus((s) => ({ ...s, [field]: "saving" }));
    // Optimistic-concurrency write: only apply if the field still holds the
    // value this edit started from. Found live: without this, a promoted
    // comment landing on this same field mid-edit gets silently destroyed
    // the moment this save fires, with the comment thread still claiming
    // "Promoted" as if it worked. Zero rows back means someone else changed
    // it first — treated as a conflict, not silently overwritten.
    const { data, error } = await supabase.from("war_rooms")
      .update({ [field]: value })
      .eq("id", warRoom.id)
      .eq(field, baseline)
      .select(field);
    if (error) {
      // Deliberately do NOT clear dirtyRef here — the realtime listener
      // already refuses to overwrite a dirty field, so failing loud (kept
      // dirty, visible error) beats failing silent (cleared dirty, then
      // quietly clobbered by the next remote update with no trace).
      setSaveStatus((s) => ({ ...s, [field]: "error" }));
      showToast(`Couldn't save "${label}" — check your connection and try again.`);
      return;
    }
    if (!data || data.length === 0) {
      setSaveStatus((s) => ({ ...s, [field]: "conflict" }));
      showToast(`"${label}" changed elsewhere while you were editing — your version wasn't saved. Review before editing again.`);
      const { data: fresh } = await supabase.from("war_rooms").select("*").eq("id", warRoom.id).maybeSingle();
      if (fresh) { setWarRoom(fresh); baselineRef.current[field] = fresh[field]; }
      return;
    }
    dirtyRef.current[field] = false;
    baselineRef.current[field] = value;
    setSaveStatus((s) => ({ ...s, [field]: "saved" }));
    setTimeout(() => setSaveStatus((s) => (s[field] === "saved" ? { ...s, [field]: undefined } : s)), 2000);
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
    setSummarizing(false);
    // Never post the raw "AI unavailable" developer message into a shared,
    // permanent comment log everyone in the room sees — found live: this
    // string mentions groq-proxy/GROQ_API_KEY by name, meaningless and
    // alarming to the non-technical staff this screen is built for.
    if (isAiUnavailable(result)) { showToast("AI summary isn't available right now — try again shortly."); return; }
    await postSystemComment(`Summary: ${result}`, warRoom.id);
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
    // A background check failing silently is correct here (unlike
    // summarize(), nobody asked for this one) — just skip the cycle rather
    // than ever guessing or leaking the raw unavailable-AI string.
    if (isAiUnavailable(result)) return;
    if ((result || "").trim().toUpperCase().startsWith("YES")) {
      await postSystemComment("There might be an action item mentioned above with no one assigned yet — worth calling out who's picking it up?", wr.id);
      loadComments(wr.id);
    }
  }

  if (loading || !warRoom) {
    return <div className="p-6 text-center text-sm" style={{ color: COLORS.faint }}>Loading War Room…</div>;
  }

  const latestSummary = [...comments].reverse().find((c) => c.author_type === "system" && c.body.startsWith("Summary:"));
  const saveStatusText = { saving: "Saving…", saved: "Saved", error: "Couldn't save", conflict: "Changed elsewhere" };
  const saveStatusColor = { saving: COLORS.faint, saved: COLORS.teal, error: COLORS.red, conflict: COLORS.amber };

  return (
    <div className="pb-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3" style={{ color: COLORS.muted }}><ArrowLeft size={15} /> Back to incident</button>

      <div className="flex items-center gap-2 mb-1">
        <Radio size={16} color={COLORS.red} />
        <h2 className="sd-display text-base font-semibold" style={{ color: COLORS.text }}>War Room</h2>
        <span className="sd-mono text-xs" style={{ color: COLORS.faint }}>{incident.display_id}</span>
      </div>
      <p className="text-sm mb-3" style={{ color: COLORS.muted }}>{incident.title}</p>

      {/* Presence — a compact strip, not a full card competing with the
          narrative for attention. Honest in both directions now: it
          reflects anyone who has actually opened this page (via the
          war_room_participants fix), not just people formally routed here,
          so this can no longer claim "nobody's here" while someone's
          plainly typing. */}
      <div className="flex items-start gap-2 flex-wrap mb-4 text-xs">
        <span className="flex items-center gap-1 shrink-0 pt-0.5" style={{ color: COLORS.muted }}><Users size={13} /> Who's here:</span>
        {participants.length === 0 ? (
          <span style={{ color: COLORS.faint }}>Nobody's confirmed yet — anyone who opens this page shows up here automatically.</span>
        ) : (
          participants.map((p) => {
            const isNever = p.status === "never_viewed";
            const isActive = p.status === "viewing_now";
            const dotColor = isNever ? COLORS.red : isActive ? COLORS.teal : COLORS.muted;
            const label = isActive ? "viewing now" : p.status === "viewed_inactive" ? "viewed, inactive" : "never viewed";
            const role = roleFor(p.user_id);
            return (
              <span key={p.user_id} className="flex items-center gap-1.5 px-2 py-1 rounded-full"
                style={{ background: isNever ? COLORS.red + "18" : COLORS.surfaceHi, border: `1px solid ${isNever ? COLORS.red + "55" : COLORS.border}` }}>
                {isNever && <AlertTriangle size={11} color={COLORS.red} />}
                <span className={isActive ? "sd-pulse" : ""} style={{ width: 6, height: 6, borderRadius: 999, background: dotColor, display: "inline-block" }} />
                <span style={{ color: COLORS.text }}>{p.email}{role ? ` · ${role}` : ""}{p.source === "joined" ? " (joined)" : ""}</span>
                <span style={{ color: isNever ? COLORS.text : dotColor, fontWeight: isNever ? 700 : 400 }}>{label}</span>
              </span>
            );
          })
        )}
      </div>

      <div className="md:flex md:gap-4 md:items-start">
        <div className="md:flex-1 md:min-w-0">
          {latestSummary && (
            <div className="rounded-lg p-3 mb-4 flex items-start gap-2" style={{ background: COLORS.teal + "0f", border: `1px solid ${COLORS.teal}33` }}>
              <Sparkles size={14} color={COLORS.teal} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-[11px] font-semibold mb-0.5" style={{ color: COLORS.teal }}>Latest summary — {new Date(latestSummary.created_at).toLocaleTimeString()}</p>
                <p className="text-sm" style={{ color: COLORS.text }}>{latestSummary.body.replace(/^Summary:\s*/, "")}</p>
              </div>
            </div>
          )}

          {/* Shared narrative — the current status anyone glancing in
              should trust, separate from the raw back-and-forth below.
              Three fields, each saved independently, so two people editing
              different fields never collide; the same field being edited
              by two people at once is now a detected conflict, not a
              silent overwrite (see saveNarrativeField). */}
          <div className="rounded-xl p-4 mb-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="sd-display text-sm font-semibold">Shared narrative</h3>
              <button onClick={summarize} disabled={summarizing} className="text-xs flex items-center gap-1" style={{ color: COLORS.teal }}>
                <Sparkles size={12} /> {summarizing ? "Summarizing…" : "Summarize where we are"}
              </button>
            </div>
            <p className="text-[11px] mb-3" style={{ color: COLORS.faint }}>The status anyone joining should trust — not the discussion itself, that's below.</p>
            <div className="space-y-3">
              {NARRATIVE_FIELDS.map((f) => (
                <div key={f.key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium" style={{ color: COLORS.muted }}>{f.label}</label>
                    {saveStatus[f.key] && <span className="text-[10px]" style={{ color: saveStatusColor[saveStatus[f.key]] }}>{saveStatusText[saveStatus[f.key]]}</span>}
                  </div>
                  <textarea
                    value={narrative[f.key]}
                    onChange={(e) => onNarrativeChange(f.key, e.target.value)}
                    onFocus={() => onNarrativeFocus(f.key)}
                    onBlur={() => onNarrativeBlur(f.key)}
                    rows={3}
                    className="sd-in3"
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] mt-2" style={{ color: COLORS.faint }}>Last updated {new Date(warRoom.last_narrative_update_at).toLocaleTimeString()}</p>
          </div>
        </div>

        <div className="md:w-96 md:shrink-0">
          {/* Free-form discussion — the raw back-and-forth. Any comment can
              be promoted into the narrative with one click; promoting
              appends into the chosen field (with a blank line if it
              already has content), it never replaces what's there. */}
          <div className="rounded-xl p-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <h3 className="sd-display text-sm font-semibold mb-1">Discussion</h3>
            <p className="text-[11px] mb-3" style={{ color: COLORS.faint }}>The working back-and-forth — promote anything useful up into the narrative.</p>
            <div className="space-y-2 mb-3 max-h-80 overflow-y-auto">
              {comments.length === 0 && <p className="text-xs" style={{ color: COLORS.faint }}>No discussion yet.</p>}
              {comments.map((c) => {
                const isSummary = c.author_type === "system" && c.body.startsWith("Summary:");
                const systemColor = isSummary ? COLORS.teal : COLORS.amber;
                return (
                  <div key={c.id} className="p-2.5 rounded-lg" style={{ background: c.author_type === "system" ? systemColor + "10" : COLORS.surfaceHi, border: `1px solid ${c.author_type === "system" ? systemColor + "33" : COLORS.border}` }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold flex items-center gap-1" style={{ color: c.author_type === "system" ? systemColor : COLORS.text }}>
                        {c.author_type === "system" && <Sparkles size={11} />}
                        {c.author_type === "system" ? (isSummary ? "AI summary" : "AI monitor") : emailFor(c.author_user_id)}
                      </span>
                      <span className="text-[10px]" style={{ color: COLORS.faint }}>{new Date(c.created_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-sm" style={{ color: COLORS.text }}>{isSummary ? c.body.replace(/^Summary:\s*/, "") : c.body}</p>
                    {c.promoted_to_field ? (
                      <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: COLORS.teal }}><Check size={11} /> Promoted to {NARRATIVE_FIELDS.find((f) => f.key === c.promoted_to_field)?.label}</p>
                    ) : c.author_type === "staff" && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {NARRATIVE_FIELDS.map((f) => (
                          <button key={f.key} onClick={() => promote(c.id, f.key)}
                            title={`Add this comment onto the end of "${f.label}" — doesn't replace what's already there`}
                            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md" style={{ color: COLORS.muted, background: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
                            <Pin size={10} /> {f.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
      </div>
    </div>
  );
}

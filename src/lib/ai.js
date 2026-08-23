import { supabase } from "../supabaseClient.js";

// Developer-facing wording, never meant to be read by end users — most
// callers just render whatever askAI() returns straight into the UI, so a
// caller that's about to show the result somewhere a real user will read it
// (a toast, a permanent shared comment) should check isAiUnavailable() first
// and show its own plain-language message instead. Found live: War Room's
// "Summarize where we are" was posting this raw string into the shared,
// permanent comment log on any Groq failure.
export const AI_UNAVAILABLE_MESSAGE = "AI suggestions aren't available right now — check that the groq-proxy function and GROQ_API_KEY secret are set up (see the setup guide).";
export function isAiUnavailable(result) {
  return result === AI_UNAVAILABLE_MESSAGE;
}

// Calls the "groq-proxy" Edge Function (see supabase/functions/groq-proxy)
// rather than an AI provider directly, so no API key ever reaches the
// browser. Returns plain text; if jsonMode is true, attempts to parse the
// response as JSON and returns null on failure so callers can handle it.
export async function askAI(system, user, jsonMode = false) {
  try {
    const { data, error } = await supabase.functions.invoke("groq-proxy", {
      body: { system, user },
    });
    if (error) throw error;
    const text = (data?.text || "").trim();
    if (jsonMode) {
      const cleaned = text.replace(/```json|```/g, "").trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
    return text;
  } catch (e) {
    console.error("AI call failed", e);
    return jsonMode ? null : AI_UNAVAILABLE_MESSAGE;
  }
}

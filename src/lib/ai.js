import { supabase } from "../supabaseClient.js";

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
    return jsonMode ? null : "AI suggestions aren't available right now — check that the groq-proxy function and GROQ_API_KEY secret are set up (see the setup guide).";
  }
}

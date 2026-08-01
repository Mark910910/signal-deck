// Supabase Edge Function: groq-proxy
// ----------------------------------------------------------------------------
// Paste this file's contents into a new Edge Function in your Supabase
// project dashboard (Edge Functions -> Deploy a new function -> name it
// "groq-proxy" -> paste this in -> Deploy). Then add GROQ_API_KEY as a
// secret (Edge Functions -> Manage secrets) — never put the key in the
// frontend, or anyone who opens the browser dev tools could copy it.
//
// The frontend calls this via supabase.functions.invoke('groq-proxy', ...)
// so your Groq key never reaches the browser bundle.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { system, user } = await req.json();
    const groqKey = Deno.env.get("GROQ_API_KEY");

    if (!groqKey) {
      return new Response(JSON.stringify({ error: "GROQ_API_KEY secret is not set on this project." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        messages: [
          { role: "system", content: system || "" },
          { role: "user", content: user || "" },
        ],
      }),
    });

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";

    return new Response(JSON.stringify({ text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

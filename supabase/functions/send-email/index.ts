// Supabase Edge Function: send-email
// ----------------------------------------------------------------------------
// Paste this into a new Edge Function named "send-email" the same way you
// did for groq-proxy. Deploy it with JWT verification OFF (there's a toggle
// for this in the deploy screen) since it's only ever called by the
// database itself (from the automation_rules trigger), never directly by a
// browser. Add RESEND_API_KEY as a secret the same way you added
// GROQ_API_KEY. This is infrastructure you run once, centrally — your
// customers never see Resend, never sign up for it, and never need to know
// it exists.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  try {
    const { to, subject, body } = await req.json();
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromAddress = Deno.env.get("SEND_FROM_ADDRESS") || "alerts@yourdomain.example";

    if (!resendKey) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY secret is not set." }), { status: 500 });
    }
    if (!to || !subject) {
      return new Response(JSON.stringify({ error: "Missing 'to' or 'subject'." }), { status: 400 });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `Signal Deck <${fromAddress}>`,
        to: [to],
        subject,
        text: body || "",
      }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

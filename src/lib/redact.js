// Strips common personal-identifier patterns before text is stored or sent
// to the AI proxy. This runs BEFORE data reaches the database now, not just
// before AI calls — the metadata-only baseline only holds if free text is
// actually kept clean at the point of entry, not cleaned up after the fact.
//
// Fixed: the SA ID number pattern previously matched 14 digits
// (\d{2}[01]\d[0-3]\d{7}\d{2}), but a real South African ID number is only
// 13 (YYMMDD SSSS C A Z = 2+2+2+4+1+1+1). It could never have matched a
// real ID number since this file was first written. Caught by an
// automated test added alongside the equivalent SQL-side fix.
export function redactPII(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]");
  out = out.replace(/\b0\d{9}\b/g, "[redacted-phone]");
  out = out.replace(/\+27\d{9}\b/g, "[redacted-phone]");
  out = out.replace(/\b\d{2}[01]\d[0-3]\d{8}\b/g, "[redacted-id-number]");
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted-card-number]");
  return out;
}

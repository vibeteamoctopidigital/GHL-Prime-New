/**
 * Deterministic writing-style cleanup, run on every AI-generated field
 * regardless of whether the model actually followed the prompt's style
 * rules — defense in depth, not just an instruction. Currently enforces the
 * one rule that's cheap and unambiguous to fix mechanically: no em/en dashes
 * used as sentence punctuation. Extend here as more mechanical rules come up;
 * anything that needs judgment (tone, jargon, sentence length) stays a
 * prompt instruction and an AI-checker concern instead.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;/gi, ', ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
}

export function sanitizeWriting(text: string): string {
  return stripEmDashes(text).replace(/[ \t]{2,}/g, ' ').trim()
}

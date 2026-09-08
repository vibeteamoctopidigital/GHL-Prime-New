// Strips ANSI/OSC/cursor-control escape sequences out of raw pty output so
// it can be safely regex-matched (for URLs/tokens) or shown as plain text.
// Cleanly removes cursor-position sequences (e.g. `\x1b[9G`), spinner-redraw
// sequences, and OSC-8 terminal hyperlinks (`\x1b]8;id=...;<url>\x1b\\ ...
// \x1b]8;;\x1b\\`) while leaving the hyperlink's own visible text intact.
// Matching ANSI/OSC escape sequences inherently requires matching the ESC
// (\x1b) and BEL (\x07) control characters themselves.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

export function stripAnsi(text: string): string {
  return String(text || '').replace(ANSI_PATTERN, '')
}

export default stripAnsi

// Strips ANSI/OSC/cursor-control escape sequences out of raw pty output so
// it can be safely regex-matched (for URLs/tokens) or shown as plain text.
// Cleanly removes cursor-position sequences (e.g. `\x1b[9G`), spinner-redraw
// sequences, and OSC-8 terminal hyperlinks (`\x1b]8;id=...;<url>\x1b\\ ...
// \x1b]8;;\x1b\\`) while leaving the hyperlink's own visible text intact.
// Matching ANSI/OSC escape sequences inherently requires matching the ESC
// (\x1b) and BEL (\x07) control characters themselves.

// `claude setup-token`'s TUI positions words with Cursor Forward
// (`\x1b[<n>C`) instead of printing literal space characters — e.g.
// "Welcome" + `\x1b[1C` + "to" renders as "Welcome to" on a real terminal,
// but naively deleting that sequence (as a generic CSI code) collapses it
// to "Welcometo" with the space gone entirely. Confirmed against a real
// captured token: the extracted value's tail was the literal English phrase
// "...store this token securely" glued onto the token with no separating
// space at all, because every `\x1b[nC` between those words had been
// deleted rather than converted to spacing — which is also what let an
// unrelated sentence fragment get swallowed into what looked like a valid
// `sk-ant-...` match. This must run BEFORE the generic CSI-stripping regex
// below, which would otherwise consume these same sequences first.
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD_PATTERN = /\x1b\[(\d*)C/g

// Same class of bug on the VERTICAL axis: the pty is spawned at `cols: 2000`
// (see blogAi.ptyRunner.ts) specifically so terminal auto-wrap can never be
// the source of a missing separator, yet a token was still captured as
// "...CyPwTAAAStore" — the real token glued directly onto the start of the
// next line's "Store this token securely" instructional text, with not even
// one boundary character between them. That shape only happens if the TUI
// moved to that next line with a cursor-positioning CSI code (Cursor Up/Down
// `\x1b[<n>A`/`\x1b[<n>B`, Cursor Next/Previous Line `\x1b[<n>E`/`\x1b[<n>F`,
// or absolute Cursor Position `\x1b[<row>;<col>H`/`f`) rather than an actual
// `\n`/`\r\n` byte — the generic CSI-stripping regex below deletes those
// codes outright, same mistake as the Cursor Forward case above but on rows
// instead of columns. Converting them to a single `\n` is safe: neither the
// token regex (`sk-ant-[A-Za-z0-9_-]{20,}`) nor the OAuth-URL regex
// (`[^\s]+`) matches across whitespace, so an inserted newline can only ever
// separate two things that were never meant to be joined — it can't corrupt
// a real match. Must also run BEFORE the generic pattern below.
// eslint-disable-next-line no-control-regex
const CURSOR_LINE_PATTERN = /\x1b\[[0-9;]*[ABEFHf]/g

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

export function stripAnsi(text: string): string {
  const withPreservedSpacing = String(text || '')
    .replace(CURSOR_FORWARD_PATTERN, (_match, count: string) => {
      const n = Number.parseInt(count, 10)
      return ' '.repeat(Number.isFinite(n) && n > 0 ? n : 1)
    })
    .replace(CURSOR_LINE_PATTERN, '\n')

  return withPreservedSpacing.replace(ANSI_PATTERN, '')
}

export default stripAnsi

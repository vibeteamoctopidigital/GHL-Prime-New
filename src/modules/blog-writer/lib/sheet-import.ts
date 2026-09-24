/**
 * Reading a content calendar out of a Google Sheet.
 *
 * The queue is filled from a spreadsheet somebody else maintains, and re-filled
 * as they add to it. Pasting a column works, but it cannot see the Status
 * column — so every re-import would re-queue everything already written, and
 * whoever pasted would have to remember where they got to.
 *
 * Reading the sheet directly is what makes the import repeatable: run it again
 * next month and it adds the new rows and nothing else.
 *
 * No `server-only` here so the URL parsing can be unit-checked and reused by
 * the dashboard to validate what was pasted before sending it.
 */

/** A row worth queueing, once the Done ones have been dropped. */
export type SheetTopic = {
  /** What goes in the queue: the keyword the post targets. */
  topic: string
  /** The intended headline, carried as steering for the writer. */
  notes: string
}

export type SheetRef = { fileId: string; gid: string }

/**
 * Pull the file id and tab id out of a pasted Google Sheets URL.
 *
 * The gid matters and cannot be guessed: a workbook's tabs have arbitrary ids,
 * and asking for the wrong one returns an error page rather than the wrong
 * data. It comes from whichever tab was open when the URL was copied, which is
 * why the dashboard asks for the calendar tab specifically.
 */
export function parseSheetUrl(input: string): SheetRef | null {
  const url = input.trim()
  const fileId = url.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9-_]{20,})/)?.[1]
  if (!fileId) return null

  // Google puts the gid in the fragment when you copy from the address bar,
  // and in the query when it comes from a share dialog. Both are normal.
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0"
  return { fileId, gid }
}

/** Where that tab can be read as CSV. */
export function sheetCsvUrl({ fileId, gid }: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv&gid=${gid}`
}

/**
 * Split CSV text into rows of fields.
 *
 * Hand-rolled rather than pulled in, because the whole of the format that
 * matters here is quoting: a field may contain commas, newlines and escaped
 * quotes, and splitting on commas gets all three wrong. Everything else about
 * CSV is already handled by reading the file as text.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false

  // A trailing newline would otherwise produce a final empty row.
  const input = text.replace(/\r\n/g, "\n").replace(/\n+$/, "")

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quoted) {
      if (ch === '"') {
        // Doubled quotes are one literal quote, not the end of the field.
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') quoted = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += ch
  }

  row.push(field)
  rows.push(row)
  return rows
}

/** Loose header matching, so a renamed or re-spaced column still lands. */
function findColumn(headers: string[], candidates: string[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const normalised = headers.map(norm)
  for (const candidate of candidates) {
    const want = norm(candidate)
    const exact = normalised.indexOf(want)
    if (exact !== -1) return exact
  }
  // Nothing matched outright; accept a header that contains the phrase.
  for (const candidate of candidates) {
    const want = norm(candidate)
    const partial = normalised.findIndex((h) => h.includes(want))
    if (partial !== -1) return partial
  }
  return -1
}

export type SheetReadResult = {
  topics: SheetTopic[]
  /** Rows skipped because the calendar already marks them written. */
  done: number
  /** Rows with no keyword and no title, which are usually spacing in the sheet. */
  blank: number
  /** The headers that were found, for an error message worth reading. */
  headers: string[]
}

/**
 * Turn a calendar tab into topics worth queueing.
 *
 * Two columns are wanted and they are not interchangeable. The focus keyword is
 * what the post should rank for and becomes the topic; the title is the
 * headline somebody wrote for it and becomes the note, because a headline makes
 * a poor search target — long, punctuated, and often past the title limit.
 *
 * Rows already marked done are dropped here rather than queued and skipped
 * later. That is the difference between an import that can be re-run and one
 * that rewrites the whole calendar every time.
 */
export function readCalendar(csv: string): SheetReadResult {
  const rows = parseCsv(csv).filter((r) => r.some((cell) => cell.trim()))
  if (rows.length === 0) return { topics: [], done: 0, blank: 0, headers: [] }

  const headers = (rows[0] ?? []).map((h) => h.trim())
  const keywordAt = findColumn(headers, ["Focus Keyword", "Keyword"])
  const titleAt = findColumn(headers, ["Target Keyword / Blog Topic", "Blog Topic", "Title", "Topic"])
  const statusAt = findColumn(headers, ["Status"])

  // Either column alone is enough to queue from; without both there is nothing
  // here that looks like a content calendar, and the caller says so.
  if (keywordAt === -1 && titleAt === -1) return { topics: [], done: 0, blank: 0, headers }

  const topics: SheetTopic[] = []
  let done = 0
  let blank = 0

  for (const row of rows.slice(1)) {
    const cell = (i: number) => (i === -1 ? "" : (row[i] ?? "").trim())
    const keyword = cell(keywordAt)
    const title = cell(titleAt)

    if (!keyword && !title) {
      blank++
      continue
    }

    // Anything the calendar calls finished is left alone, whatever word it
    // uses for it.
    if (/^(done|published|complete[d]?)$/i.test(cell(statusAt))) {
      done++
      continue
    }

    // The keyword is preferred, and the title stands in when a row has no
    // keyword — a row with only a headline is still a row worth writing.
    topics.push({ topic: keyword || title, notes: keyword ? title : "" })
  }

  return { topics, done, blank, headers }
}

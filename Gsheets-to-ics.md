# Gsheets-to-ics.js: Google Sheets Conference Listings → ICS Calendar File

This document describes the design and exact behavior of `Gsheets-to-ics.js`, in enough detail that an AI assistant or a person could recreate it from scratch in a future session without the original file.

---

`Gsheets-to-ics.js` is a Node.js script that runs on the command line and uses the Google Sheets API to read one or more sheets of conference listings, then converts them into a single, merged iCalendar (.ics) file.

### Usage

```
node Gsheets-to-ics.js <SPREADSHEET_ID[,SPREADSHEET_ID...]> [OUTPUT_FILE] [--config=path]
```

- `OUTPUT_FILE` defaults to `conferences.ics`
- `--config` defaults to `Gsheets-to-ics.conf` in the current working directory — see "Config file" below
- Authentication uses an API key passed via the `GOOGLE_API_KEY` environment variable (each sheet must be publicly accessible)
- No npm dependencies — use only Node built-in modules (`https`, `fs`, `crypto`)
- No sheet/tab name is passed in — see "Sheet selection" below.

### Multiple sources

`SPREADSHEET_ID` accepts a comma-separated list to read from more than one sheet and merge the results into one output file:

```
node Gsheets-to-ics.js "ID_2026,ID_2027" conferences.ics
```

- Sheets are fetched **sequentially, in the order the IDs are given**, and each source's events are appended to the output in that order (source 1's rows in sheet order, then source 2's, etc.) — never re-sorted by date across sources.
- Each source gets its own "Opened" console line identifying it (see Console output below) — individual row lines don't repeat the spreadsheet ID.

### Sheet selection

Don't take a sheet/tab name argument. Instead, for each spreadsheet ID, call the Sheets API metadata endpoint first to list its tabs:

```
GET https://sheets.googleapis.com/v4/spreadsheets/{id}?key={API_KEY}&fields=sheets.properties(title,index)
```

Sort the returned `sheets` array by `properties.index` and use `sheets[0].properties.title` — i.e. always read whichever tab is first, regardless of what it's named. The resolved tab name isn't logged on its own — it's folded into the single "Opened" line printed once all of the tab lookup, values fetch, and header detection have succeeded (see Console output below).

### Config file

**Settled Sep 2026, replacing an earlier hardcoded `COLS` constant.** Column layout is not baked into the script at all — it's read from a plain-text config file, plain `key = value` lines (blank lines and `#`-comments ignored, split on the *first* `=` only so a value containing `=`, e.g. a URL query string, survives intact). Default filename `Gsheets-to-ics.conf`, overridable with `--config=path`. No parsing library — hand-rolled, since the format is simple enough not to need one.

Ten possible keys:

| Key | Meaning | Required? |
|---|---|---|
| `organiser` | Header text for the Organiser column | Yes |
| `name` | Header text for the event title column | Yes |
| `quarter` | Header text for the Quarter column | Yes |
| `start` | Header text for the Start date column | Yes |
| `end` | Header text for the End date column | Yes |
| `city` | Header text for the City column | Yes |
| `country` | Header text for the Country column | Yes |
| `region` | Header text for the Region column | Yes |
| `link` | Header text for the Link column | Yes |
| `topics` | Header text for the Key Topics column | **No** — omit the line (or comment it out) to disable Topics entirely: no `Topics:` line in the description, no "Topics empty" warning |
| `boilerplate` | Free text appended to every event's description | Yes |

Any value can be a **comma-separated list of acceptable header texts** — e.g. `organiser = Organiser, Organizer`. This exists because Mark's own 2026 and 2027 sheets don't actually agree on wording for two columns ("Organiser" vs "Organizer", "Key Topics" vs "Topics") even though they mean the same thing — a single shared config still needs to work across both when they're merged into one run. Matching against a header cell's text is case-insensitive but otherwise exact (whitespace-trimmed) against each alternate.

At startup, before touching any spreadsheet: read the config file (fail loudly, with the resolved path in the message, if it can't be read), then confirm every required key is present (fail loudly listing which key(s) are missing — only `topics` may legitimately be absent).

**Column order is irrelevant by construction** — since header detection works by *searching* for these header texts (see below) rather than assuming fixed positions, a sheet can have its columns in any order, or extra unrelated columns interspersed, without needing any change.

### Header row / data start row

Two sheets can have their header rows at completely different row numbers (row 6 vs row 4, in Mark's real two sheets) even when using the same config, so never hardcode a start row. Instead:

1. Fetch a wide range from row 1 through a generous column limit (`'{tabName}'!A1:Z2000`, i.e. 26 columns — a configured field found beyond column Z won't be detected) with `valueRenderOption=UNFORMATTED_VALUE`.
2. Build a lookup from every configured header text (lowercased, comma-alternates split out individually) to its field name.
3. Scan the first ~20 returned rows; for each row, check every cell against that lookup, building a `{ field: columnIndex }` map as matches are found (this **is** the column-position discovery — there's no separate "order" configuration needed). The first row where *every* configured field has been found (topics only counted if it's in the config at all) is the header row, and that map is `cols` for this source.
4. Data begins the row after that. Compute real 1-based sheet row numbers for logging from the header row's position.
5. If no row satisfies all the required field names within the search limit, fail loudly — the error message lists every header text being searched for and names the config file, since a mismatch here is almost always a config/sheet wording disagreement, not a bug.

Since `cols` is discovered fresh per source (not a module-level constant), every function that used to read a global `COLS.field` now takes `cols` as an explicit parameter instead — this also lets two sources in the same run have their fields at genuinely different column indices, as long as the same header text is found in each.

### End of table

Sheets have trailing content below the real data (footer links, copyright notices, etc.) that a wide `A1:J2000` fetch happily picks up as more "rows." Stop reading a source's rows entirely — don't skip-and-continue, actually break out of the loop — the moment a row has **all** of Event, Quarter, Start, End, City, Country, and Region empty after trimming (Organiser, Topics, and Link are deliberately excluded from this check, since footer rows often have text in Organiser). Log a single line, `⚠️   Row N: end of table`, and process no further rows from that source. "Empty" here means missing or blank-after-trim — not merely invalid (a `Start` of `"Jan?"` is not empty, just unparseable as a date, and does not trigger this).

### Data fetching

Use `valueRenderOption=UNFORMATTED_VALUE` in the values API request so that date cells are returned as Google Sheets serial numbers (a float representing days since 30 Dec 1899) rather than their display string. This is important because the date columns are displayed as `DD MMM` (2026) or `yyyy-mm-dd` (2027) with the format itself unreliable — reading the underlying serial sidesteps that entirely.

### Organiser hyperlinks

The Organiser column is sometimes itself a hyperlink — the organiser's name as the visible cell text, with a URL as the actual link target. `spreadsheets.values.get` (used for all the row data above) never returns hyperlink metadata, only text/numbers, so pulling the link needs a second, separate request per source, scoped to just the Organiser column and the exact row range already fetched:

```
GET https://sheets.googleapis.com/v4/spreadsheets/{id}?key={API_KEY}&ranges={tabName}!{organiserColLetter}{dataStartRow}:{organiserColLetter}{lastRow}&fields=sheets.data.rowData.values.hyperlink
```

Derive the column letter from the discovered `cols.organiser` index (passed in as a parameter — see Config file above) rather than hardcoding `A`. The response nests as `sheets[0].data[0].rowData[i].values[0].hyperlink` — build a plain array of hyperlink strings (or `null` where a row has no `rowData` entry, no `values`, or no `hyperlink` field), aligned 1:1 by index with the row array already being iterated. Skip this call entirely when there are zero data rows (an empty `A{n}:A{n-1}` range is invalid).

When a row's Organiser hyperlink is present, append it to the `Organiser:` description line (see Calendar events below); when it's `null`, leave it off that line entirely rather than a trailing space or an empty line.

### Date handling

Convert Google Sheets serial numbers to dates using:

```js
const ms = (serial - 25569) * 86400 * 1000;
const d = new Date(ms);
// use d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()
```

Use UTC date methods throughout to avoid timezone offsets shifting dates by a day. Validate that converted dates fall between 1970 and 2100.

### Row validation

Settled Sep 2026 after discussion. Two tiers: **blocking** rules skip the row entirely (no event made) with a console warning naming every rule that failed; **non-blocking** rules only warn — the event is still produced.

**Blocking** — skip the row if any of these are true:
- Organiser column is empty
- Conference name column is empty
- Quarter column is empty (its own distinct message, separate from the next rule — don't lump "empty" and "wrong value" into one message)
- Quarter column is non-empty but not exactly one of `Q1`/`Q2`/`Q3`/`Q4` (case-insensitive — normalize to uppercase before comparing, but log the original raw value in the warning)
- City, Country, or Region column is empty
- City, Country, or Region column is a placeholder value — exactly `TBA`, `TBC`, or `TBD` after trimming and uppercasing to check against (kept in a `PLACEHOLDER_VALUES` const near the top of the file). Exact match only: `"TBD"` counts, `"TBD - venue not yet confirmed"` does not. The warning message itself preserves the value's original casing as typed in the sheet rather than normalizing it — `"City is TBD"`, `"Country is tbc"`, not `"City is placeholder \"TBD\""`.
- Start date column is missing or not a valid date serial number
- End date column is missing or not a valid date serial number
- End date is before Start date (a data-entry sanity check — logs both dates in the warning)
- Event spans more than `MAX_EVENT_DAYS` days (a `const` near the top of the file, currently `10`) — another data-entry sanity check, e.g. catching a typo'd year in one of the two dates. Logs the actual span and both dates in the warning. The longest genuine event on the 2027 sheet (Paris Air Show, 6 days) is comfortably under this, so it shouldn't false-positive on real data as of Sep 2026 — revisit the constant if a legitimately longer event ever gets added.
- End date is more than `MAX_PAST_DAYS` days before today (a `const` near the top of the file, currently `30`) — the message is exactly `"Event >30 past"` (interpolate `MAX_PAST_DAYS` into that exact phrasing, don't reword it). Compares against the actual current date at run time (UTC midnight), not a fixed date — so which rows this catches shifts day to day as old events age past the 30-day cutoff. Exactly 30 days ago still passes; 31 does not.

**Non-blocking** — warn but still include the event:
- Topics column is empty (only checked when the config defines a `topics` field at all — see Config file above; when Topics is disabled entirely, there's no such column to be empty, so no warning either)
- Link column is empty

Deliberate consequences of the blocking rules above, confirmed with Mark rather than accidental:
- **Placeholder-date rows** (`Jan?`, `Sep?`, `TBD`, etc. — month known but exact days not yet announced) are excluded from the calendar entirely, since they have no real date serial to build an event from. They stay out of the sheet's own tracking, just not on this calendar.
- **Holiday rows** (New Year's Day, Christmas, etc.) have a real date but a blank Organiser (and blank City/Country/Region), so they're excluded too — this calendar is conferences only, holidays are a planning reference inside the spreadsheet, not calendar content.

Deliberate **non**-checks — things that look like they'd be validated but aren't, confirmed with Mark as intentional rather than gaps:
- **Link is not validated as a URL.** Any non-empty string passes straight through into the description's `Link:` line as-is — including a placeholder comment like `(no link available yet)` instead of an actual URL. Mark is fine with that text showing up in the calendar description exactly as typed in the sheet.
- **Quarter is not cross-checked against Start/End.** The script never confirms that, say, a Start date in March actually falls within a `Q1` Quarter value — Quarter is only checked for being one of `Q1`-`Q4` (see above), not for internal consistency with the dates.

Track a running count of events written with at least one non-blocking warning, separate from the skipped-row count, and report both in the final summary line.

### Calendar events

- Each valid row becomes one all-day event (no start/end times)
- `DTSTART;VALUE=DATE:YYYYMMDD` from the Start date column
- `DTEND;VALUE=DATE:YYYYMMDD` from the End date column, **plus one day** (iCalendar all-day DTEND is exclusive)
- `SUMMARY` (event title): `{name} – {city}` (conference name, en dash, city). If city is empty, use just the conference name.
- `DESCRIPTION` (settled Sep 2026, replacing an earlier all-labelled layout — in this exact order):

```
{name}
{city}, {country}
{link}                            ← omitted entirely (no blank line left behind) when Link is blank

Topics: {topics}                  ← this whole line omitted (not left blank) when the config has no "topics" key at all
Organiser: {organiser}            ← or "Organiser: {organiser} {organiserLink}" when the Organiser cell is a hyperlink — same line, space-separated, no separate label

{boilerplate}                     ← verbatim from the config file's "boilerplate" key
```

Title, City/Country, and Link are unlabelled — only Topics and Organiser keep a label. City and Country are guaranteed non-empty by the blocking validation rules above, so `{city}, {country}` never needs a conditional; Link can legitimately be blank (it's only a non-blocking warning), in which case its line is skipped entirely rather than left as an empty line before the blank-line separator. Organiser's hyperlink (when present) rides on the same line as `Organiser:` — there's no separate `Organiser Link:` line any more, and when there's no hyperlink, the line is just `Organiser: {name}` with no trailing space. The blank line before `Organiser:` is unconditional — with Topics disabled, `Organiser:` still ends up as the first line after exactly one blank line, same visual shape either way.

### iCalendar compliance (RFC 5545)

- Build description lines joined with actual newline characters (`"\n"` in JS), then pass through an `icsEscape()` function that converts real newlines to the `\n` escape sequence. Do **not** pre-join with the two-character string `"\\n"` — this causes double-escaping and renders as literal `\n` text in calendar apps.
- `icsEscape()` must handle (in order): backslash → `\\`, semicolon → `\;`, comma → `\,`, newline → `\n`, strip carriage returns.
- Fold long lines at 75 octets (RFC 5545 §3.1), with continuation lines prefixed by a single space.
- Use CRLF (`\r\n`) as the line separator throughout the file.
- Generate a UID per event as `sha1(Organiser|Name|Start date)` (via `crypto.createHash("sha1")`) — **deterministic, not random.** A random UID (e.g. `crypto.randomUUID()`) would make two runs against identical sheet data produce byte-different output, which breaks both (a) any script that diffs successive runs to detect "did anything actually change," and (b) subscribed calendar apps (Apple/Google/Outlook), which match on UID to update an existing event in place on refresh rather than creating a duplicate. Start date is part of the key specifically so the same event's different yearly editions (e.g. GBTA Convention 2026 vs 2027) still get distinct UIDs.
- Each event must include `TRANSP:TRANSPARENT` so that events import with a status of Free rather than Busy.
- Calendar-level properties: `VERSION:2.0`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME:Global Travel Tech Conferences`.

### Console output

One line per row, no matter how many rules it hits — don't print a header line plus one bullet per failure. Keep the individual warning messages short (a few words each, e.g. `"City empty"`, `"Quarter \"Q5\" not Q1/Q2/Q3/Q4"`, `"Spans 11d (>10d limit)"`) so several can still join onto one line.

**The spreadsheet ID is only printed once per source**, in a single "opened" line after the tab lookup, values fetch, header detection, and Organiser hyperlink fetch have all succeeded — e.g. `📑  Opened {id} — tab "{sheetName}", header at row {N}, {count} row(s) returned`. Every row line below that (accepted, skipped, or end-of-table) omits the `[id]` prefix entirely — with one source at a time being processed in its own block, the leading "Opened" line already establishes which source the rows below it belong to.

- Skipped row: `⚠️   Row N: skipped "<Name>" — <reason1>; <reason2>; ...` (all blocking failures joined with `"; "`). Every "Row N" line — skipped, end-of-table, accepted — puts a colon right after the row number, for consistency; don't let this one drift to `Row N skipped —` without it. The quoted title comes from the Event/Name column and is included whenever it's non-empty, even though the row is otherwise invalid (e.g. a bad date) — `validateRow` returns `name` alongside `warnings` on the invalid path specifically so the caller can do this. When Name itself is empty (e.g. a holiday row with no Organiser/Name at all), skip the quoted-title segment entirely rather than printing empty quotes: `⚠️   Row N: skipped — <reason1>; ...`.
- End of table (see above): `⚠️   Row N: end of table`, and no further rows from that source are processed at all — not even to check whether they'd otherwise be accepted or skipped.
- Accepted row with no non-blocking warnings: `✅  Row N: "Name" (dtStart → dtEnd)`.
- Accepted row with non-blocking warnings (blank Topics/Link): same line, with `  ⚠️ <reason1>; <reason2>` appended.

Finish with one summary line: events written, source count, how many written events carried a warning, and how many rows were skipped (rows never reached because of an end-of-table break don't count as "skipped").

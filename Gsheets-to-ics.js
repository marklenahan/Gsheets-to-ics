// Gsheets-to-ics.js
// Reads one or more Google Sheets of conference listings and merges them
// into a single iCalendar (.ics) file.
//
// Usage:
//   node Gsheets-to-ics.js <SPREADSHEET_ID[,SPREADSHEET_ID...]> [OUTPUT_FILE] [--config=path]
//
// Defaults:
//   OUTPUT_FILE → conferences.ics
//   --config    → Gsheets-to-ics.conf (in the current working directory)
//
// Requires the GOOGLE_API_KEY environment variable to be set.
// Each Google Sheet must be publicly accessible (shared as "Anyone with the link can view").
//
// No sheet name is passed in: the script lists each spreadsheet's tabs and
// always reads the first one (index 0), whatever it's named.
//
// Example (single sheet):
//   node Gsheets-to-ics.js 1CW-PbWr9amRXWKfkm8zSHyqxfz8CjSmdcvQbFKDaSSg conferences.ics
//
// Example (2026 sheet then 2027 sheet, merged into one calendar, in that order):
//   node Gsheets-to-ics.js "1_0pkZIzBV3vyTduleF7i0-H2pRxUtaJFud_Vzz-NK5k,1CW-PbWr9amRXWKfkm8zSHyqxfz8CjSmdcvQbFKDaSSg" conferences.ics
//
// Column layout is not hardcoded — it's read from a config file (see
// loadConfig() below and Gsheets-to-ics.conf / Gsheets-to-ics.md for the exact
// format). Each field is mapped to the header TEXT to search for; wherever
// that text actually appears in the header row is where the column is, so
// column order in the sheet doesn't matter. "topics" is the one field that
// can be left out of the config entirely — when it is, there's no Topics
// line in the description at all and no "Topics empty" warning. Every other
// field (organiser, name, quarter, start, end, city, country, region, link)
// is required, along with a "boilerplate" text setting appended to every
// event's description.
//
// The header row itself can sit at a different row number in different
// sheets, so instead of hardcoding a start row, the script fetches a wide
// range from row 1 (columns A through Z — see MAX_COLUMN_LETTER) and finds
// the header row by searching for the configured field names; data begins
// the row after that.
//
// Once reading data rows, a row with Event/Quarter/Start/End/City/Country/
// Region ALL blank (trailing footer content below the real table) ends that
// source's read entirely — see isEndOfTableRow(). Every row is otherwise put
// through validateRow(): a set of blocking rules (empty/invalid required
// fields, a TBA/TBC/TBD placeholder in City/Country/Region, End before
// Start, an event spanning more than MAX_EVENT_DAYS, or an End date more
// than MAX_PAST_DAYS in the past) skip the row entirely, while blank Topics/
// Link only warn — the event is still produced. See Gsheets-to-ics.md
// for the full rationale and the exact console-output format.
//
// The Organiser column is sometimes itself a hyperlink (name as display
// text, a URL as the link target); when it is, the description gets it
// appended to the "Organiser:" line — see fetchOrganiserHyperlinks().

const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const MAX_EVENT_DAYS = 10; // sanity bound: End more than this many days after Start is treated as a data-entry error
const MAX_PAST_DAYS = 30; // skip events whose End date is more than this many days before today
const PLACEHOLDER_VALUES = ["TBA", "TBC", "TBD"]; // treated as "not really known yet" in City/Country/Region, not a real value
const MAX_ROWS = 2000; // Fetch up to this many rows per sheet, header block included
const MAX_COLUMN_LETTER = "Z"; // Fetch up to this many columns (A..Z, 26) — a configured field found beyond this won't be detected
const HEADER_SEARCH_LIMIT = 20; // Give up looking for the header within the first N rows

// Column-name fields every config file must define; "topics" is the one
// optional column field, checked for separately.
const REQUIRED_COLUMN_FIELDS = ["organiser", "name", "quarter", "start", "end", "city", "country", "region", "link"];
const OPTIONAL_COLUMN_FIELDS = ["topics"];
const REQUIRED_OTHER_KEYS = ["boilerplate"];

// Exact match (trimmed, case-insensitive) against PLACEHOLDER_VALUES — "TBD"
// counts, "TBD - venue not yet confirmed" does not.
function isPlaceholderText(text) {
  return PLACEHOLDER_VALUES.includes(String(text).trim().toUpperCase());
}

// A cell counts as empty if it's missing entirely or blank after trimming —
// not the same as "invalid" (e.g. a Start date of "Jan?" is non-empty text,
// just not a usable date).
function isEmptyCell(value) {
  return value == null || String(value).trim() === "";
}

// End-of-table marker: once Event, Quarter, Start, End, City, Country, and
// Region are ALL empty on a row, treat everything from there on as trailing
// sheet content (footer links, copyright notices, etc.) rather than data,
// and stop reading that source. Organiser/Topics/Link are deliberately not
// part of this check.
function isEndOfTableRow(row, cols) {
  return (
    isEmptyCell(row[cols.name]) &&
    isEmptyCell(row[cols.quarter]) &&
    isEmptyCell(row[cols.start]) &&
    isEmptyCell(row[cols.end]) &&
    isEmptyCell(row[cols.city]) &&
    isEmptyCell(row[cols.country]) &&
    isEmptyCell(row[cols.region])
  );
}

// ─── Config file ────────────────────────────────────────────────────────────
// Plain "key = value" lines. Blank lines and lines starting with # are
// ignored. Split on the FIRST "=" only, so a value containing "=" (e.g. a
// URL with a query string) is preserved intact. See Gsheets-to-ics.conf for
// a real example and Gsheets-to-ics.md for the full spec.

function loadConfigFile(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    console.error(`❌  Could not read config file "${configPath}": ${err.code === "ENOENT" ? "file not found" : err.message}`);
    console.error(`    Use --config=<path> to point at a different file, or create "${configPath}" — see Gsheets-to-ics.md for the format.`);
    process.exit(1);
  }

  const config = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      console.warn(`⚠️   Ignoring unrecognised line in "${configPath}": ${rawLine}`);
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) config[key] = value;
  }

  const missing = [...REQUIRED_COLUMN_FIELDS, ...REQUIRED_OTHER_KEYS].filter((k) => !config[k]);
  if (missing.length > 0) {
    console.error(`❌  Config file "${configPath}" is missing required setting(s): ${missing.join(", ")}`);
    console.error(`    (Only "${OPTIONAL_COLUMN_FIELDS.join(", ")}" may be left out — see Gsheets-to-ics.md.)`);
    process.exit(1);
  }

  return config;
}

// Build the { field: headerText } map used to search for the header row,
// from a loaded config. Only includes optional fields (topics) when the
// config actually defines them.
function fieldNamesFromConfig(config) {
  const fieldNames = {};
  for (const field of REQUIRED_COLUMN_FIELDS) fieldNames[field] = config[field];
  for (const field of OPTIONAL_COLUMN_FIELDS) {
    if (config[field]) fieldNames[field] = config[field];
  }
  return fieldNames;
}

// ─── Config (CLI) ───────────────────────────────────────────────────────────

const API_KEY = process.env.GOOGLE_API_KEY;

const rawArgs = process.argv.slice(2);
let configPath = "Gsheets-to-ics.conf";
const positional = [];
for (const arg of rawArgs) {
  const m = /^--config=(.+)$/.exec(arg);
  if (m) {
    configPath = m[1];
  } else {
    positional.push(arg);
  }
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const spreadsheetIds = splitList(positional[0]);
const OUTPUT_FILE = positional[1] || "conferences.ics";

// ─── Guards ───────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error("❌  GOOGLE_API_KEY environment variable is not set.");
  console.error("    export GOOGLE_API_KEY=your_key_here");
  process.exit(1);
}

if (spreadsheetIds.length === 0) {
  console.error("❌  No spreadsheet ID provided.");
  console.error("    Usage: node Gsheets-to-ics.js <SPREADSHEET_ID[,SPREADSHEET_ID...]> [OUTPUT_FILE] [--config=path]");
  process.exit(1);
}

// ─── Date conversion ──────────────────────────────────────────────────────────
// With valueRenderOption=UNFORMATTED_VALUE, Google Sheets returns date cells as
// their underlying serial number (a float: days elapsed since Dec 30 1899).
// Serial 25569 == January 1 1970 (Unix epoch).  We use UTC throughout to avoid
// local-timezone offsets shifting the date by a day.

function serialToDate(serial) {
  if (typeof serial !== "number" || isNaN(serial) || serial <= 0) return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function isValidDate(d) {
  if (!d) return false;
  const { year, month, day } = d;
  if (year < 1970 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

// Format as YYYYMMDD for iCalendar
function toIcsDate({ year, month, day }) {
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

// A single comparable number for a {year,month,day} date, for ordering checks
// (e.g. detecting an End date before its Start date).
function dateToOrdinal({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

// Today's date (UTC, midnight) as the same comparable ordinal, for checking
// how far in the past an event's End date is.
function todayOrdinal() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Add one day (for DTEND, which is exclusive in iCalendar all-day events)
function addOneDay({ year, month, day }) {
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

// ─── iCalendar helpers ────────────────────────────────────────────────────────

// Escape special characters as required by RFC 5545
function icsEscape(text) {
  if (!text) return "";
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

// Fold long lines to max 75 octets (RFC 5545 §3.1)
function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const limit = first ? 75 : 74; // continuation lines start with a space
    parts.push(bytes.slice(offset, offset + limit).toString("utf8"));
    offset += limit;
    first = false;
  }
  return parts.join("\r\n ");
}

// Deterministic per-event UID, derived from the fields that identify "this
// event" (Organiser, Name, Start date) rather than a fresh random value each
// run. Two reasons: (1) it lets a re-run of this script against unchanged
// sheet data produce byte-identical output, so a simple diff can detect
// "nothing actually changed"; (2) calendar apps (Apple/Google/Outlook) match
// on UID to update an existing subscribed event in place on refresh rather
// than creating a duplicate — a random UID every run would make every
// refresh look like a brand new batch of events to subscribers. Including
// Start date (not just Organiser+Name) keeps the same event distinct across
// different years/editions (e.g. GBTA Convention 2026 vs 2027).
function uid(organiser, name, dtStart) {
  const hash = crypto.createHash("sha1").update(`${organiser}|${name}|${dtStart}`).digest("hex");
  return `${hash}@Gsheets-to-ics`;
}

// ─── Fetch from Google Sheets API ────────────────────────────────────────────

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch (e) {
            reject(new Error("Failed to parse API response as JSON"));
            return;
          }
          if (json.error) {
            reject(new Error(`Google Sheets API: ${json.error.message}`));
            return;
          }
          resolve(json);
        });
      })
      .on("error", (err) => reject(err));
  });
}

// Look up a spreadsheet's tabs and return the title of the first one
// (lowest index), whatever it's named.
async function fetchFirstSheetTitle(spreadsheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${API_KEY}&fields=${encodeURIComponent(
    "sheets.properties(title,index)"
  )}`;
  const json = await apiGet(url);
  const sheets = json.sheets || [];
  if (sheets.length === 0) {
    throw new Error("Spreadsheet has no sheets/tabs");
  }
  sheets.sort((a, b) => a.properties.index - b.properties.index);
  return sheets[0].properties.title;
}

async function fetchSheetValues(spreadsheetId, sheetName) {
  const range = encodeURIComponent(`'${sheetName}'!A1:${MAX_COLUMN_LETTER}${MAX_ROWS}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=${API_KEY}&valueRenderOption=UNFORMATTED_VALUE`;
  const json = await apiGet(url);
  return json.values || [];
}

// The plain values.get endpoint above never returns hyperlink metadata, only
// cell text/numbers — so Organiser cells that are themselves a hyperlink
// (name as the display text, a URL as the link target) need a second,
// separate call to spreadsheets.get scoped to just the Organiser column,
// which does expose per-cell hyperlinks. Returns an array of hyperlink
// strings (or null where there isn't one), aligned 1:1 with the row range
// requested (startRow..endRow, both 1-based, inclusive).
async function fetchOrganiserHyperlinks(spreadsheetId, sheetName, startRow, endRow, organiserColIndex) {
  const colLetter = String.fromCharCode("A".charCodeAt(0) + organiserColIndex);
  const range = encodeURIComponent(`'${sheetName}'!${colLetter}${startRow}:${colLetter}${endRow}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${API_KEY}&ranges=${range}&fields=${encodeURIComponent(
    "sheets.data.rowData.values.hyperlink"
  )}`;
  const json = await apiGet(url);
  const rowData = json.sheets?.[0]?.data?.[0]?.rowData || [];
  const numRows = endRow - startRow + 1;
  const links = [];
  for (let i = 0; i < numRows; i++) {
    links.push(rowData[i]?.values?.[0]?.hyperlink || null);
  }
  return links;
}

// Find the header row by searching each of the first HEADER_SEARCH_LIMIT
// rows for every field name in `fieldNames` ({ field: headerText }),
// wherever it appears in that row — column order doesn't matter, only that
// every configured field's header text is found somewhere in the same row.
// Returns { headerIdx, cols } (cols: { field: columnIndex }) or null.
function findHeaderRow(values, fieldNames) {
  // Each field's config value may be a comma-separated list of acceptable
  // header texts (e.g. "Organiser, Organizer") — useful when merging sources
  // whose sheets don't use identical header wording for the same field.
  const wantedByLower = {};
  for (const [field, headerTextList] of Object.entries(fieldNames)) {
    for (const alt of String(headerTextList).split(",")) {
      const norm = alt.trim().toLowerCase();
      if (norm) wantedByLower[norm] = field;
    }
  }

  const limit = Math.min(values.length, HEADER_SEARCH_LIMIT);
  for (let i = 0; i < limit; i++) {
    const row = values[i] || [];
    const found = {};
    row.forEach((cell, idx) => {
      const text = String(cell == null ? "" : cell).trim().toLowerCase();
      if (text && Object.prototype.hasOwnProperty.call(wantedByLower, text)) {
        found[wantedByLower[text]] = idx;
      }
    });
    if (Object.keys(fieldNames).every((field) => found[field] !== undefined)) {
      return { headerIdx: i, cols: found };
    }
  }
  return null;
}

// ─── Row validation ───────────────────────────────────────────────────────────

function validateRow(row, cols, hasTopics) {
  // Text cells arrive as strings; date cells arrive as numbers (serials).
  const getText = (idx) => String(row[idx] != null ? row[idx] : "").trim();
  const getRaw = (idx) => row[idx]; // preserve the raw type for date columns

  const organiser = getText(cols.organiser);
  const name = getText(cols.name);
  const quarter = getText(cols.quarter);
  const city = getText(cols.city);
  const country = getText(cols.country);
  const region = getText(cols.region);
  const topics = hasTopics ? getText(cols.topics) : "";
  const link = getText(cols.link);
  const startRaw = getRaw(cols.start);
  const endRaw = getRaw(cols.end);

  // Blocking: any of these failing means the row is skipped, no event made.
  const blocking = [];

  if (!organiser) blocking.push("Organiser empty");
  if (!name) blocking.push("Name empty");
  if (!quarter) blocking.push("Quarter empty");
  else if (!VALID_QUARTERS.includes(quarter.toUpperCase()))
    blocking.push(`Quarter "${quarter}" not ${VALID_QUARTERS.join("/")}`);
  if (!city) blocking.push("City empty");
  else if (isPlaceholderText(city)) blocking.push(`City is ${city}`);
  if (!country) blocking.push("Country empty");
  else if (isPlaceholderText(country)) blocking.push(`Country is ${country}`);
  if (!region) blocking.push("Region empty");
  else if (isPlaceholderText(region)) blocking.push(`Region is ${region}`);

  const startDate = serialToDate(startRaw);
  const endDate = serialToDate(endRaw);

  if (startRaw == null || startRaw === "") blocking.push("Start empty");
  else if (!isValidDate(startDate)) blocking.push(`Start "${startRaw}" not a date`);

  if (endRaw == null || endRaw === "") blocking.push("End empty");
  else if (!isValidDate(endDate)) blocking.push(`End "${endRaw}" not a date`);

  // Only compare start vs. end once both individually parsed as valid dates.
  if (isValidDate(startDate) && isValidDate(endDate)) {
    const spanDays = (dateToOrdinal(endDate) - dateToOrdinal(startDate)) / 86400000;
    if (spanDays < 0) {
      blocking.push(`End ${toIcsDate(endDate)} before Start ${toIcsDate(startDate)}`);
    } else if (spanDays > MAX_EVENT_DAYS) {
      blocking.push(`Spans ${spanDays}d (>${MAX_EVENT_DAYS}d limit)`);
    }
  }

  // Skip events that are well over — not just already finished, but stale.
  if (isValidDate(endDate)) {
    const daysPast = (todayOrdinal() - dateToOrdinal(endDate)) / 86400000;
    if (daysPast > MAX_PAST_DAYS) {
      blocking.push(`Event >${MAX_PAST_DAYS} past`);
    }
  }

  if (blocking.length > 0) {
    return { valid: false, warnings: blocking, name };
  }

  // Non-blocking: worth a console warning, but the event is still produced.
  const warnings = [];
  if (hasTopics && !topics) warnings.push("Topics empty");
  if (!link) warnings.push("Link empty");

  return { valid: true, startDate, endDate, organiser, name, warnings };
}

// Build one VEVENT block for a validated row.
function buildEvent(row, validation, organiserLink, cols, hasTopics, boilerplate) {
  const get = (idx) => (row[idx] || "").trim();
  const { startDate, endDate, name, organiser } = validation;

  const city = get(cols.city);
  const country = get(cols.country);
  const link = get(cols.link);

  // Line 1: title, unlabelled. Line 2: "City, Country", unlabelled (both are
  // guaranteed non-empty by validateRow's blocking rules, so no conditional
  // needed here). Line 3: Link, unlabelled — omitted entirely when blank
  // (Link is only a non-blocking warning, so it can be) rather than left as
  // an empty line.
  const descriptionLines = [name, `${city}, ${country}`];
  if (link) descriptionLines.push(link);

  // The blank separator line always follows next, whether or not Topics
  // itself is present — so with Topics disabled in config, "Organiser:"
  // still ends up on its own line after exactly one blank line.
  descriptionLines.push("");
  if (hasTopics) descriptionLines.push(`Topics: ${get(cols.topics)}`);

  // Organiser link (when the Organiser cell is itself a hyperlink) sits on
  // the same line as "Organiser:", space-separated, no separate label —
  // omitted entirely rather than left blank when there's no hyperlink.
  descriptionLines.push(organiserLink ? `Organiser: ${organiser} ${organiserLink}` : `Organiser: ${organiser}`);

  descriptionLines.push("", boilerplate);
  const description = descriptionLines.join("\n");

  // iCalendar DTEND for all-day events is exclusive (day after the last day)
  const dtStart = toIcsDate(startDate);
  const dtEnd = toIcsDate(addOneDay(endDate));

  const summary = city ? `${name} – ${city}` : name;

  return {
    dtStart,
    dtEnd: toIcsDate(endDate), // for logging only
    block: [
      "BEGIN:VEVENT",
      foldLine(`UID:${uid(organiser, name, dtStart)}`),
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      foldLine(`SUMMARY:${icsEscape(summary)}`),
      foldLine(`DESCRIPTION:${icsEscape(description)}`),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ].join("\r\n"),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfigFile(configPath);
  const fieldNames = fieldNamesFromConfig(config);
  const hasTopics = Boolean(config.topics);
  const boilerplate = config.boilerplate;

  const events = [];
  let totalSkipped = 0;
  let totalWithWarnings = 0;

  for (const id of spreadsheetIds) {
    let sheetName;
    try {
      sheetName = await fetchFirstSheetTitle(id);
    } catch (err) {
      console.error(`❌  Error listing sheets for spreadsheet ${id}:`, err.message);
      process.exit(1);
    }
    let values;
    try {
      values = await fetchSheetValues(id, sheetName);
    } catch (err) {
      console.error(`❌  Error fetching sheet "${sheetName}" (${id}):`, err.message);
      process.exit(1);
    }

    const header = findHeaderRow(values, fieldNames);
    if (!header) {
      const wanted = Object.values(fieldNames).join('", "');
      console.error(
        `❌  Could not find a header row containing all of "${wanted}" within the first ${HEADER_SEARCH_LIMIT} rows of "${sheetName}" (${id}). Check "${configPath}" matches this sheet's actual header text.`
      );
      process.exit(1);
    }
    const { headerIdx, cols } = header;
    const dataStartRow = headerIdx + 2; // 1-based sheet row number of the first data row
    const rows = values.slice(headerIdx + 1);

    let organiserLinks = [];
    if (rows.length > 0) {
      try {
        organiserLinks = await fetchOrganiserHyperlinks(id, sheetName, dataStartRow, dataStartRow + rows.length - 1, cols.organiser);
      } catch (err) {
        console.error(`❌  Error fetching Organiser hyperlinks for "${sheetName}" (${id}):`, err.message);
        process.exit(1);
      }
    }

    // The ID/tab/header info is only printed here, once per source — not
    // repeated on every row line below.
    console.log(`📑  Opened ${id} — tab "${sheetName}", header at row ${headerIdx + 1}, ${rows.length} row(s) returned`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sheetRowNum = dataStartRow + i;

      if (isEndOfTableRow(row, cols)) {
        console.warn(`⚠️   Row ${sheetRowNum}: end of table`);
        break;
      }

      const validation = validateRow(row, cols, hasTopics);

      if (!validation.valid) {
        const titlePart = validation.name ? `"${validation.name}" ` : "";
        console.warn(`⚠️   Row ${sheetRowNum}: skipped ${titlePart}— ${validation.warnings.join("; ")}`);
        totalSkipped++;
        continue;
      }

      const { block, dtStart, dtEnd } = buildEvent(row, validation, organiserLinks[i], cols, hasTopics, boilerplate);
      events.push(block);

      if (validation.warnings.length > 0) {
        totalWithWarnings++;
        console.log(`✅  Row ${sheetRowNum}: "${validation.name}" (${dtStart} → ${dtEnd})  ⚠️ ${validation.warnings.join("; ")}`);
      } else {
        console.log(`✅  Row ${sheetRowNum}: "${validation.name}" (${dtStart} → ${dtEnd})`);
      }
    }
  }

  if (events.length === 0) {
    console.error("❌  No valid events found across any source. No file written.");
    process.exit(1);
  }

  const calName = "Global Travel Tech Conferences";

  // Assemble the iCalendar file. Events stay in source order (source 1's
  // rows first, in sheet order, then source 2's, etc.) — no re-sorting by date.
  const ics =
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Gsheets-to-ics//Conference Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${calName}`,
      ...events,
      "END:VCALENDAR",
    ].join("\r\n") + "\r\n";

  fs.writeFileSync(OUTPUT_FILE, ics, "utf8");

  console.log(
    `✅  Done! ${events.length} event(s) written from ${spreadsheetIds.length} source(s) (${totalWithWarnings} with warnings), ${totalSkipped} row(s) skipped.`
  );
  console.log(`📁  Output: ${OUTPUT_FILE}`);
}

main();

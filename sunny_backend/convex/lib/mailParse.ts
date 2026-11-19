import { fromBase64Url } from "./base64";
import { isRecord } from "./http";
import type { IcsEvent, MailSender, ParsedEmail } from "./mailTypes";
import { oneLine } from "./text";
import { MINUTE_MS, canonicalTimezone, localDate, localTime, zonedInstant } from "./time";

export const MAX_EMAIL_TEXT = 6000;
const MAX_BODY_SOURCE = 256 * 1024;
const GMAIL_AUTHSERV = "mx.google.com";

export interface MailHeader {
  name: string;
  value: string;
}

interface MimePart {
  mimeType: string;
  filename: string;
  headers: MailHeader[];
  data: string | null;
  parts: MimePart[];
}

function readHeaders(raw: unknown): MailHeader[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((h) =>
    isRecord(h) && typeof h.name === "string" && typeof h.value === "string"
      ? [{ name: h.name, value: h.value }]
      : [],
  );
}

function readPart(raw: unknown): MimePart | null {
  if (!isRecord(raw)) return null;
  const body = isRecord(raw.body) ? raw.body : {};
  return {
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType.toLowerCase() : "",
    filename: typeof raw.filename === "string" ? raw.filename : "",
    headers: readHeaders(raw.headers),
    data: typeof body.data === "string" && body.data !== "" ? body.data : null,
    parts: Array.isArray(raw.parts)
      ? raw.parts.map(readPart).filter((p): p is MimePart => p !== null)
      : [],
  };
}

function header(headers: MailHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value ?? null;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

function decodeWord(charset: string, encoding: string, text: string): string {
  try {
    if (encoding.toUpperCase() === "B") return decodeBytes(fromBase64Url(text), charset);
    const bytes: number[] = [];
    const source = text.replace(/_/g, " ");
    for (let i = 0; i < source.length; i += 1) {
      const hex = source[i] === "=" ? source.slice(i + 1, i + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(source.charCodeAt(i) & 0xff);
      }
    }
    return decodeBytes(new Uint8Array(bytes), charset);
  } catch {
    return text;
  }
}

function decodeHeaderValue(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(ENCODED_WORD, (_, charset: string, encoding: string, text: string) =>
      decodeWord(charset, encoding, text),
    );
}

function parseAddress(value: string): { name: string; address: string } | null {
  const decoded = oneLine(decodeHeaderValue(value));
  const angled = /^(.*?)<([^<>\s@]+@[^<>\s]+)>$/.exec(decoded);
  if (angled) {
    const name = angled[1]!
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(.)/g, "$1")
      .trim();
    return { name, address: angled[2]!.toLowerCase() };
  }
  const bare = /^([^\s<>()@]+@[^\s<>()]+)(?:\s*\((.*)\))?$/.exec(decoded);
  if (bare) return { name: (bare[2] ?? "").trim(), address: bare[1]!.toLowerCase() };
  return null;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function aligned(signer: string, fromDomain: string): boolean {
  return (
    signer === fromDomain || fromDomain.endsWith(`.${signer}`) || signer.endsWith(`.${fromDomain}`)
  );
}

function withoutCommentsAndQuotes(value: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (quoted) {
      if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    } else if (ch === '"') {
      quoted = true;
      out += '""';
    } else if (ch === "(") {
      depth = 1;
      out += " ";
    } else {
      out += ch;
    }
  }
  return depth === 0 && !quoted ? out : null;
}

interface AuthResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

function authResults(value: string): { authserv: string; results: AuthResult[] } | null {
  const bare = withoutCommentsAndQuotes(value);
  if (bare === null) return null;
  const [head = "", ...clauses] = bare.toLowerCase().split(";");
  const results = clauses.flatMap((clause) => {
    const [verdict = "", ...props] = clause.trim().split(/\s+/);
    const eq = verdict.indexOf("=");
    if (eq <= 0) return [];
    const pairs = props.flatMap((prop) => {
      const at = prop.indexOf("=");
      return at > 0 ? [[prop.slice(0, at), prop.slice(at + 1)] as const] : [];
    });
    return [{ method: verdict.slice(0, eq), result: verdict.slice(eq + 1), props: new Map(pairs) }];
  });
  return { authserv: head.trim().split(/\s+/)[0] ?? "", results };
}

function passes(result: AuthResult, fromDomain: string): boolean {
  if (result.result !== "pass") return false;
  if (result.method === "dmarc") return result.props.get("header.from") === fromDomain;
  if (result.method !== "dkim") return false;
  const signers = [result.props.get("header.d"), result.props.get("header.i")]
    .filter((s): s is string => s !== undefined)
    .map(domainOf);
  return signers.some((signer) => signer !== "" && aligned(signer, fromDomain));
}

export function authenticated(headers: MailHeader[]): boolean {
  const from = parseAddress(header(headers, "From") ?? "");
  if (!from) return false;
  const parsed = headers
    .filter((h) => h.name.toLowerCase() === "authentication-results")
    .map((h) => authResults(h.value));
  if (parsed.some((p) => p === null)) return false;
  const gmail = parsed.filter((p) => p?.authserv === GMAIL_AUTHSERV);
  if (gmail.length !== 1) return false;
  const fromDomain = domainOf(from.address);
  return gmail[0]!.results.some((result) => passes(result, fromDomain));
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const SKIPPED_TAGS = new Set(["script", "style", "head", "title", "template", "noscript"]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "section",
  "table",
  "tr",
  "ul",
]);

const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:;|$|!)|font-size\s*:\s*0(?:\.0*)?(?:px|pt|em|rem|%)?\s*(?:;|$|!)|max-height\s*:\s*0(?:px)?\s*(?:;|$|!))/i;

function isHidden(attributes: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attributes)) return true;
  const style = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return style !== null && HIDDEN_STYLE.test(style[1] ?? style[2] ?? "");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
  bull: "-",
  middot: "-",
  copy: "(c)",
  reg: "(R)",
  trade: "",
  shy: "",
  zwnj: "",
  zwj: "",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const INVISIBLE_CHARS = /[​-‏⁠﻿­]/g;

function normalizeText(text: string): string {
  const flat = text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return flat.length <= MAX_EMAIL_TEXT ? flat : flat.slice(0, MAX_EMAIL_TEXT);
}

const HTML_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|[^<]+|</g;

export function htmlToText(html: string): string {
  const stack: string[] = [];
  let hiddenFrom: number | null = null;
  let out = "";
  for (const match of html.slice(0, MAX_BODY_SOURCE).matchAll(HTML_TOKEN)) {
    const [token, closing, rawName, attributes = ""] = match;
    if (token.startsWith("<!--")) continue;
    if (rawName === undefined) {
      if (hiddenFrom === null) out += decodeEntities(token);
      continue;
    }
    const name = rawName.toLowerCase();
    if (closing === "/") {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      if (hiddenFrom !== null && stack.length <= hiddenFrom) hiddenFrom = null;
    } else if (!VOID_TAGS.has(name) && !attributes.trimEnd().endsWith("/")) {
      if (hiddenFrom === null && (SKIPPED_TAGS.has(name) || isHidden(attributes))) {
        hiddenFrom = stack.length;
      }
      stack.push(name);
    }
    if (hiddenFrom !== null) continue;
    if (BLOCK_TAGS.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += " ";
  }
  return normalizeText(out);
}

function leaves(part: MimePart): MimePart[] {
  return part.parts.length === 0 ? [part] : part.parts.flatMap(leaves);
}

function isAttachment(part: MimePart): boolean {
  return (
    part.filename !== "" ||
    /^\s*attachment/i.test(header(part.headers, "Content-Disposition") ?? "")
  );
}

function partText(part: MimePart): string | null {
  if (part.data === null) return null;
  const charset =
    /charset\s*=\s*"?([^";\s]+)/i.exec(header(part.headers, "Content-Type") ?? "")?.[1] ?? "utf-8";
  try {
    return decodeBytes(fromBase64Url(part.data), charset);
  } catch {
    return null;
  }
}

function bodyText(parts: MimePart[]): string {
  const inline = parts.filter((p) => !isAttachment(p));
  const plain = inline
    .filter((p) => p.mimeType === "text/plain")
    .map(partText)
    .find((t): t is string => t !== null && t.trim() !== "");
  if (plain !== undefined) return normalizeText(plain.slice(0, MAX_BODY_SOURCE));
  const html = inline
    .filter((p) => p.mimeType === "text/html")
    .map(partText)
    .find((t): t is string => t !== null && t.trim() !== "");
  return html === undefined ? "" : htmlToText(html);
}

function isCalendarPart(part: MimePart): boolean {
  return (
    part.mimeType === "text/calendar" ||
    part.mimeType === "application/ics" ||
    part.filename.toLowerCase().endsWith(".ics")
  );
}

export function parseGmailMessage(raw: unknown, timezone: string): ParsedEmail | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const payload = readPart(raw.payload);
  const receivedAt = typeof raw.internalDate === "string" ? Number(raw.internalDate) : NaN;
  if (payload === null || !Number.isSafeInteger(receivedAt) || receivedAt <= 0) return null;
  const from = parseAddress(header(payload.headers, "From") ?? "");
  if (from === null) return null;
  const parts = leaves(payload);
  const icsText = parts
    .filter(isCalendarPart)
    .map(partText)
    .find((t): t is string => t !== null);
  const sender: MailSender = { ...from, authenticated: authenticated(payload.headers) };
  return {
    gmailId: raw.id,
    labels: Array.isArray(raw.labelIds)
      ? raw.labelIds.filter((l): l is string => typeof l === "string")
      : [],
    sender,
    subject: oneLine(decodeHeaderValue(header(payload.headers, "Subject") ?? "")),
    receivedAt,
    text: bodyText(parts),
    ics: icsText === undefined ? null : parseIcs(icsText, timezone),
  };
}

interface IcsLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseIcsLine(line: string): IcsLine | null {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      const [name = "", ...rawParams] = line.slice(0, i).split(";");
      const params: Record<string, string> = {};
      for (const p of rawParams) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

function unescapeIcs(value: string): string {
  return oneLine(
    value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? " " : ch)),
  );
}

const ICS_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:\d{2})?(Z?)$/;

function icsInstant(line: IcsLine | undefined, timezone: string): number | null {
  if (line === undefined) return null;
  const m = ICS_DATE_TIME.exec(line.value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  try {
    if (m[6] === "Z") return Date.parse(`${date}T${time}:00Z`);
    const tzid = line.params.TZID;
    const zone = tzid === undefined ? timezone : canonicalTimezone(tzid.replace(/^\//, ""));
    return zone === null ? null : zonedInstant(date, time, zone);
  } catch {
    return null;
  }
}

function durationMinutes(value: string | undefined): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(
    value?.trim() ?? "",
  );
  if (!m) return null;
  const [, w = "0", d = "0", h = "0", mi = "0"] = m;
  const total = ((Number(w) * 7 + Number(d)) * 24 + Number(h)) * 60 + Number(mi);
  return total > 0 ? total : null;
}

const RECURRENCE_PROPS = ["RRULE", "RDATE", "RECURRENCE-ID"];

const ICS_METHODS: Record<string, IcsEvent["method"]> = {
  REQUEST: "REQUEST",
  CANCEL: "CANCEL",
  REPLY: "REPLY",
};

export function parseIcs(text: string, timezone: string): IcsEvent | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map(parseIcsLine)
    .filter((l): l is IcsLine => l !== null);
  let method = "";
  let depth = 0;
  let state: "before" | "inside" | "done" = "before";
  const props = new Map<string, IcsLine>();
  for (const line of lines) {
    const value = line.value.trim().toUpperCase();
    if (line.name === "BEGIN") {
      if (state === "before" && value === "VEVENT") state = "inside";
      else if (state === "inside") depth += 1;
    } else if (line.name === "END") {
      if (state === "inside" && depth === 0 && value === "VEVENT") state = "done";
      else if (state === "inside") depth -= 1;
    } else if (state === "inside" && depth === 0) {
      if (!props.has(line.name)) props.set(line.name, line);
    } else if (state !== "inside" && line.name === "METHOD") {
      method = value;
    }
  }
  const uid = props.get("UID")?.value.trim() ?? "";
  if (uid === "") return null;
  const start = icsInstant(props.get("DTSTART"), timezone);
  const end = icsInstant(props.get("DTEND"), timezone);
  const cancelled = props.get("STATUS")?.value.trim().toUpperCase() === "CANCELLED";
  const location = unescapeIcs(props.get("LOCATION")?.value ?? "");
  const sequence = props.get("SEQUENCE")?.value.trim() ?? "";
  return {
    method: cancelled ? "CANCEL" : (ICS_METHODS[method] ?? "OTHER"),
    uid,
    start:
      start === null
        ? null
        : { date: localDate(start, timezone), time: localTime(start, timezone) },
    durationMinutes:
      start !== null && end !== null && end > start
        ? Math.round((end - start) / MINUTE_MS)
        : durationMinutes(props.get("DURATION")?.value),
    summary: unescapeIcs(props.get("SUMMARY")?.value ?? ""),
    location: location === "" ? null : location,
    recurring: RECURRENCE_PROPS.some((name) => props.has(name)),
    sequence: /^\d{1,9}$/.test(sequence) ? Number(sequence) : 0,
  };
}

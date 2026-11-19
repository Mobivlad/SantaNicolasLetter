import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Bare address only: no display names, groups, comments or trailing dots (nodemailer would parse those)
export const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

// One mailbox = one key for daily limits: case, "+tag" and Gmail dots don't make a new address
export function normEmail(email) {
  let [local = "", domain = ""] = String(email).toLowerCase().split("@");
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return `${local}@${domain}`;
}

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// POSTs must come from our own pages: a JSON content type forces a CORS preflight for other sites
export function foreign(req) {
  return req.headers.get("sec-fetch-site") === "cross-site" || !/^application\/json\b/i.test(req.headers.get("content-type") || "");
}

// Error logs without personal data (nodemailer messages may contain addresses)
export const logErr = (what, e) => console.error(what, e?.code || e?.name || "error", e?.responseCode || "");

// Single line, trimmed, length-limited text from user input (invisible format characters removed, except emoji joiners)
export function clean(value, max) {
  const s = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/(?!\u200d)\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

// Age as a string "1".."99", or "" when empty/invalid
export function cleanAge(value) {
  const s = clean(value, 3);
  return /^\d{1,2}$/.test(s) && Number(s) >= 1 ? String(Number(s)) : "";
}

/* ---- Personal links: AES-256-GCM token (key = LINK_SECRET env var) ----
   Payload: JSON {n: name, e: email, s: surname, c: city, a: age}; older links: "name\nemail[\nsurname]" */
function key() {
  const secret = process.env.LINK_SECRET;
  if (!secret) throw new Error("LINK_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

function seal(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

function unseal(token) {
  const k = key();
  try {
    const raw = Buffer.from(String(token || ""), "base64url");
    if (raw.length < 30 || raw.length > 900) return null;
    const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function toLink(d) {
  const link = {
    name: clean(d.name, 60), email: clean(d.email, 120), surname: clean(d.surname, 60),
    city: clean(d.city, 100), age: cleanAge(d.age)
  };
  return EMAIL_RE.test(link.email) ? link : null;
}

const pack = ({ name, email, surname = "", city = "", age = "" }) => ({ n: name, e: email, s: surname, c: city, a: age });
const unpack = (j) => ({ name: j.n, email: j.e, surname: j.s, city: j.c, age: j.a });

// Child link token
export const sealLink = (d) => seal(pack(d));

// Returns { name, email, surname, city, age } or null for a garbled / foreign / confirmation token
export function openLink(token) {
  const plain = unseal(token);
  if (!plain) return null;
  try {
    if (!plain.startsWith("{")) {
      const [name, email, surname] = plain.split("\n");
      return toLink({ name, email, surname });
    }
    const j = JSON.parse(plain);
    return j.t ? null : toLink(unpack(j));
  } catch {
    return null;
  }
}

// Generic sealed object (server-side records in Netlify Blobs)
export const sealData = (obj) => seal(obj);
export function openData(token) {
  try { return JSON.parse(unseal(token) || "null"); } catch { return null; }
}
export const packKid = pack;
export const unpackKid = (j) => (j ? toLink(unpack(j)) : null);

// Short link ids: 8 chars of [0-9A-Za-z] (~47 bits), e.g. ?l=Ab3dE9xK
const ABC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function newId(len = 8) {
  let s = "";
  while (s.length < len) for (const b of randomBytes(len * 2)) if (b < 248 && s.length < len) s += ABC[b % 62]; // no modulo bias
  return s;
}
export const isShortId = (s) => /^[0-9A-Za-z]{6,12}$/.test(String(s || ""));

// Links live until the end of the season: 31 January (Kyiv winter time, UTC+2)
export function seasonEnd(now = Date.now()) {
  const [y, m] = new Date(now).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).split("-").map(Number);
  return Date.parse(`${m >= 2 ? y + 1 : y}-02-01T00:00:00+02:00`);
}

// Old (pre short-link) email confirmation token: same data plus type and expiry, never usable as a child link
export function openConfirm(token) {
  try {
    const j = JSON.parse(unseal(token) || "null");
    return j && j.t === "c" && j.x > Date.now() ? toLink(unpack(j)) : null;
  } catch {
    return null;
  }
}

/* ---- Best-effort per-IP rate limit (per warm function instance) ---- */
const hits = new Map();
export function limited(bucket, context, max, windowMs) {
  const id = `${bucket}:${context?.ip || "?"}`;
  const now = Date.now();
  const list = (hits.get(id) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(id, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

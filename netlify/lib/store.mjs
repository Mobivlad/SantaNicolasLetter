// Small persistent state in Netlify Blobs. Emails are stored only inside AES-GCM sealed records or as a keyed hash.
//   k/<id>    - child link {x: expiry ms, d: sealed {n,e,s,c,a,b}}   (?l=<id>)
//   b/<id>    - links sent in one email {x, d: sealed {e, k:[{i,n}]}} (link.html?c=<id>)
//   o/<id>    - that email was opened (first use of any of its links) {x}
//   u/<id>    - the child has already sent a letter with this link {x}, or is sending it right now {x, p: start ms}
//               (old long tokens: u/h<sha256 of the decrypted child data>; before that: u/h<sha256 of the token>)
//   c/<hash>  - emails with links sent today {d, n}
//   s/<hash>  - letters sent to this address today {d, n}
//   g/<date>  - whole-site mails today {d, n, f} (Gmail allows ~500 recipients a day; f = letters without a link)
//   stats/total, stats/<YYYY-MM-DD> - anonymous counters {links, confirmed, confirmMails, letters, freeLetters}
// Expired k/ b/ o/ u/ records, old v/ markers and yesterday's c/ s/ g/ counters are deleted by cleanup() (daily).
import { createHmac, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { sealData, openData, unpackKid, openLink, newId, isShortId, normEmail } from "./common.mjs";

let store;
const mem = new Map();
function db() {
  if (store) return store;
  try {
    store = getStore({ name: "mykolai", consistency: "strong" });
  } catch (e) {
    if (!process.env.MAIL_DRY_RUN) throw e;
    // Local dry run outside Netlify: in-memory stand-in
    const set = async (k, v, o = {}) => {
      if (o.onlyIfNew && mem.has(k)) return { modified: false };
      mem.set(k, v);
      return { modified: true };
    };
    store = {
      get: async (k) => mem.get(k) ?? null,
      set,
      setJSON: (k, v, o) => set(k, JSON.stringify(v), o),
      getWithMetadata: async (k) => (mem.has(k) ? { data: JSON.parse(mem.get(k)) } : null),
      delete: async (k) => { mem.delete(k); },
      list: async ({ prefix }) => ({ blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) })
    };
  }
  return store;
}

const hash = (email) => createHmac("sha256", process.env.LINK_SECRET || "").update(normEmail(email)).digest("hex").slice(0, 40);
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

// New sealed record under a fresh short id
export async function putSealed(prefix, data, x) {
  for (let i = 0; i < 5; i++) {
    const id = newId();
    const r = await db().set(`${prefix}/${id}`, JSON.stringify({ x, d: sealData(data) }), { onlyIfNew: true });
    if (r?.modified !== false) return id;
  }
  throw new Error("id collision");
}

export async function setSealed(prefix, id, data, x) {
  await db().set(`${prefix}/${id}`, JSON.stringify({ x, d: sealData(data) }));
}

// Storage errors are thrown (the caller answers "try again"); a missing, expired or garbled record is null
export async function getSealed(prefix, id) {
  if (!isShortId(id)) return null;
  const raw = await db().get(`${prefix}/${id}`);
  try {
    const j = JSON.parse(raw || "null");
    return j && j.x > Date.now() ? openData(j.d) : null;
  } catch {
    return null;
  }
}

// Child link from ?l=: short id (k/<id>) or an old self-contained token.
// Returns { name, email, surname, city, age, batch? } or null
export async function findKid(l) {
  if (isShortId(l)) {
    const j = await getSealed("k", l);
    const kid = unpackKid(j);
    return kid ? { ...kid, batch: j.b } : null;
  }
  return openLink(l);
}

// One letter per child link: u/<id> exists once the letter is sent.
// Old long tokens are re-issued with a new random IV, so they are keyed by the decrypted child data instead.
const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
function usedKeys(l) {
  if (isShortId(l)) return [`u/${l}`];
  const d = openLink(l);
  const legacy = `u/h${sha(l)}`;
  return d ? [`u/h${sha(`${d.name}\n${String(d.email).toLowerCase()}\n${d.surname}`)}`, legacy] : [legacy];
}

// A send that died midway (function killed by a timeout) must not burn the link forever
const STALE_MS = 90e3;
const isStale = (j) => !!j?.p && Date.now() - j.p >= STALE_MS;

async function readRaw(key) {
  try { return JSON.parse((await db().get(key)) || "null"); } catch { return null; }
}

export async function isUsed(l) {
  for (const k of usedKeys(l)) {
    const j = await readRaw(k);
    if (j && !isStale(j)) return true;
  }
  return false;
}

// Returns true for the first caller only, so two simultaneous letters cannot both pass
export async function claimLink(l, x) {
  const [k, ...legacy] = usedKeys(l);
  for (const old of legacy) if (await readRaw(old)) return false;
  const s = db();
  const r = await s.set(k, JSON.stringify({ x, p: Date.now() }), { onlyIfNew: true });
  if (r?.modified !== false) return true;
  const cur = await s.getWithMetadata(k, { type: "json" });
  if (!isStale(cur?.data)) return false;
  const w = await s.setJSON(k, { x, p: Date.now() }, cur.etag ? { onlyIfMatch: cur.etag } : {});
  return w?.modified !== false;
}

// The letter went out: the claim becomes permanent
export async function markSent(l, x) {
  const k = usedKeys(l)[0];
  for (let i = 0; i < 3; i++) {
    try { await db().set(k, JSON.stringify({ x })); return; } catch (e) { if (i === 2) console.error("markSent failed:", e?.name); }
  }
}

// The letter was not sent after all: the link may be used again
export async function releaseLink(l) {
  try { await db().delete(usedKeys(l)[0]); } catch (e) { console.error("release failed:", e?.name); }
}

// Returns true only the first time any link from this email is used
export async function markOpened(batch, x) {
  if (!isShortId(batch)) return false;
  const r = await db().set(`o/${batch}`, JSON.stringify({ x }), { onlyIfNew: true });
  return r?.modified !== false;
}

// Runs daily: today's counters first, then expired records; stops before the scheduled-function time limit
export async function cleanup() {
  const s = db(), now = Date.now(), d = today(), until = now + 22e3;
  let removed = 0;
  for (const prefix of ["c/", "s/", "g/", "v/", "u/", "o/", "k/", "b/"]) {
    const { blobs } = await s.list({ prefix });
    for (let i = 0; i < blobs.length; i += 20) {
      if (Date.now() > until) return removed;
      await Promise.all(blobs.slice(i, i + 20).map(async ({ key }) => {
        if (prefix === "v/") { await s.delete(key); removed++; return; }
        const j = await readRaw(key);
        const keep = ["c/", "s/", "g/"].includes(prefix) ? j?.d === d : j?.x > now;
        if (!keep) { await s.delete(key); removed++; }
      }));
    }
  }
  return removed;
}
export const STAT_FIELDS = ["links", "confirmed", "confirmMails", "letters", "freeLetters"];

// Read-modify-write guarded by the blob ETag, so concurrent requests can't both pass a limit or lose increments.
// fn(old object or null) -> new object, or null to refuse. Returns true when written.
async function update(key, fn) {
  const s = db();
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const old = cur?.data && typeof cur.data === "object" ? cur.data : null;
    const next = fn(old ? { ...old } : null);
    if (!next) return false;
    const r = await s.setJSON(key, next, cur ? (cur.etag ? { onlyIfMatch: cur.etag } : {}) : { onlyIfNew: true });
    if (r?.modified !== false) return true;
    await new Promise((res) => setTimeout(res, 15 + Math.random() * 60));
  }
  throw new Error("busy");
}

const addTo = (key, field, n = 1) => update(key, (o) => ({ ...o, [field]: (Number(o?.[field]) || 0) + n }));

// Never fails the request: statistics are best effort
export async function count(field, n = 1) {
  try {
    await addTo("stats/total", field, n);
    await addTo(`stats/${today()}`, field, n);
  } catch (e) {
    console.error("stats failed:", e);
  }
}

async function readJSON(key) {
  try { return JSON.parse((await db().get(key)) || "null") || {}; } catch { return {}; }
}

export async function heardTotal() {
  const t = await readJSON("stats/total");
  return (Number(t.letters) || 0) + (Number(t.freeLetters) || 0);
}

export async function readStats(days = 14) {
  const total = await readJSON("stats/total");
  const now = Date.now();
  const dates = Array.from({ length: days }, (_, i) => new Date(now - i * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }));
  const daily = await Promise.all(dates.map(async (d) => ({ d, ...(await readJSON(`stats/${d}`)) })));
  return { total, daily };
}

// Daily counter per address; returns false (and does not count) when the limit is reached
export function takeDaily(kind, email, max) {
  const d = today();
  return update(`${kind}/${hash(email)}`, (o) => {
    const n = o?.d === d ? Number(o.n) || 0 : 0;
    return n >= max ? null : { d, n: n + 1 };
  });
}

// Whole-site mail budget for today; returns false when it is used up. free = a letter without a parent link.
export function spendMail(free = false) {
  const d = today();
  const max = Number(process.env.MAIL_DAILY_MAX) || 450, freeMax = Number(process.env.FREE_DAILY_MAX) || 100;
  return update(`g/${d}`, (o) => {
    const g = o?.d === d ? o : { d, n: 0, f: 0 };
    if (g.n >= max || (free && g.f >= freeMax)) return null;
    return { d, n: g.n + 1, f: g.f + (free ? 1 : 0) };
  });
}

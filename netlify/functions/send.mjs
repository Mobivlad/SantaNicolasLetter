// POST /api/send {l?, name, age, city, about?, wishes[], good:true} -> letter by Gmail SMTP.
// Recipient: parent's email from the personal link (short id or old token), otherwise FALLBACK_EMAIL (or GMAIL_USER).
// A link that is unknown or expired -> 400 {error:"link"} (the letter would never reach the parent).
// A personal link sends only one letter: afterwards -> 409 {error:"used"}.
// The whole site has a daily mail budget (Gmail limit) -> 503 {error:"busy"} when it is used up.
// Subject tags: "[Без батьків]" = letter without a link, "[Основний]" = link letter whose parent email is FALLBACK_EMAIL.
// A backup copy ("[Копія]" in the subject, no surname) goes to FALLBACK_EMAIL when it differs from the recipient;
// it is sent in the background after the main letter, so the child does not wait for it.
import { json, clean, cleanAge, limited, seasonEnd, foreign, logErr } from "../lib/common.mjs";
import { sendMail, esc } from "../lib/mail.mjs";
import { takeDaily, count, findKid, claimLink, releaseLink, markSent, spendMail } from "../lib/store.mjs";

const LETTERS_PER_DAY = 10; // per parent address

// "7 років", "2 роки", "1 рік"
function years(n) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? "рік" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "роки" : "років"}`;
}

function render({ name, fullName, age, city, about, wishes, sentAt }) {
  const text = [
    `Дорогий Святий Миколаю!`,
    ``,
    `Мене звати: ${fullName}`,
    `Мені ${years(Number(age))}`,
    `Я живу: ${city}`,
    ...(about ? [``, `Про себе:`, about] : []),
    ``,
    `Цього року я дуже хочу:`,
    ...wishes.map((w, i) => `${i + 1}. ${w}`),
    ``,
    `✅ Підтверджую, що я був чемним / була чемною весь рік.`,
    ``,
    `З любов'ю, ${name}`,
    `Надіслано: ${sentAt}`
  ].join("\n");

  const li = wishes.map((w) => `<li style="margin:4px 0">${esc(w)}</li>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#14234f;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:560px;margin:0 auto;background:#fdf6e3;border:6px solid #c8102e;border-radius:12px;padding:24px;color:#3b2f4a">
<h1 style="margin:0 0 16px;font-size:26px;color:#c8102e">Дорогий Святий Миколаю! ✨</h1>
<p style="margin:8px 0;font-size:17px"><b>Мене звати:</b> ${esc(fullName)}</p>
<p style="margin:8px 0;font-size:17px"><b>Мені:</b> ${esc(years(Number(age)))}</p>
<p style="margin:8px 0;font-size:17px"><b>Я живу:</b> ${esc(city)}</p>
${about ? `<p style="margin:16px 0 4px;font-size:17px"><b>Про себе:</b></p>
<p style="margin:0;font-size:17px">${esc(about).replace(/\n/g, "<br>")}</p>` : ""}
<p style="margin:16px 0 4px;font-size:17px"><b>Цього року я дуже хочу:</b></p>
<ol style="margin:0;padding-left:24px;font-size:17px">${li}</ol>
<p style="margin:18px 0 8px;font-size:16px">✅ Підтверджую, що я був чемним / була чемною весь рік.</p>
<p style="margin:18px 0 0;font-size:18px;text-align:right;color:#1d3a8a"><i>З любов'ю, ${esc(name)}</i></p>
<p style="margin:16px 0 0;font-size:12px;color:#8a7a66">Надіслано: ${esc(sentAt)}</p>
</div></body></html>`;
  return { text, html };
}

export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "method" });
  if (foreign(req)) return json(403, { error: "origin" });
  if (limited("send", context, 12, 10 * 60e3)) return json(429, { error: "rate" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "json" }); }

  const name = clean(body.name, 60);
  const wishes = (Array.isArray(body.wishes) ? body.wishes : []).map((w) => clean(w, 120)).filter(Boolean).slice(0, 10);
  // Optional free text: keep line breaks, clean each line
  const about = Array.from(String(body.about ?? "").slice(0, 2000).split(/\r?\n|\r/).map((s) => clean(s, 600)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim()).slice(0, 600).join("").trim();

  let to = process.env.FALLBACK_EMAIL || process.env.GMAIL_USER;
  let surname = "", city = "", age = "", fromLink = false;
  try {
    if (body.l) {
      const link = await findKid(body.l);
      if (!link) return json(400, { error: "link" });
      ({ email: to, surname, city, age } = link);
      fromLink = true;
    }
  } catch (e) {
    logErr("findKid failed:", e);
    return json(503, { error: "storage" });
  }
  // Values given by parents in the link win over what the page sends
  city = city || clean(body.city, 100);
  age = age || cleanAge(body.age);
  if (!name || !city || !age || !wishes.length || body.good !== true) return json(400, { error: "invalid" });
  if (!to) return json(500, { error: "config" });

  const fullName = surname ? `${name} ${surname}` : name;
  const sentAt = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });
  const mail = (rcpt, prefix, who) => sendMail({
    to: rcpt, subject: `${prefix}Лист Святому Миколаю — ${who}`,
    ...render({ name, fullName: who, age, city, about, wishes, sentAt })
  });
  const backupTo = process.env.FALLBACK_EMAIL;
  const toBackup = !!backupTo && backupTo.toLowerCase() === to.toLowerCase();
  // Subject tags for the backup mailbox; letters to other parents get no tag
  const mainPrefix = !fromLink ? "[Без батьків] " : toBackup ? "[Основний] " : "";

  let main;
  try {
    // One letter per link: claim it first, give it back if the letter is not sent
    if (fromLink && !(await claimLink(body.l, seasonEnd()))) return json(409, { error: "used" });
    try {
      // Nobody can flood a parent's mailbox, even with a valid link
      if (fromLink && !(await takeDaily("s", to, LETTERS_PER_DAY))) throw Object.assign(new Error(), { reply: [429, "limit"] });
      if (!(await spendMail(!fromLink))) throw Object.assign(new Error(), { reply: [503, "busy"] });
      main = await mail(to, mainPrefix, fullName);
    } catch (e) {
      if (fromLink) await releaseLink(body.l);
      throw e;
    }
    if (fromLink) await markSent(body.l, seasonEnd());
  } catch (e) {
    if (e.reply) return json(e.reply[0], { error: e.reply[1] });
    logErr("send failed:", e);
    return json(502, { error: "mail" });
  }

  // Backup copy (without surname) to FALLBACK_EMAIL after the main letter, in the background; skipped if the budget is out
  const backup = backupTo && !toBackup
    ? spendMail().then((ok) => (ok ? mail(backupTo, "[Копія] ", name) : null)).catch((e) => { logErr("backup failed:", e); return null; })
    : Promise.resolve(null);
  const counted = count(fromLink ? "letters" : "freeLetters");
  if (context?.waitUntil) context.waitUntil(Promise.all([backup, counted]));
  if (!process.env.MAIL_DRY_RUN) return json(200, { ok: true });
  await counted;
  const b = await backup;
  return json(200, {
    ok: true,
    preview: JSON.parse(main.message),
    backup: b ? JSON.parse(b.message) : null
  });
};

export const config = { path: "/api/send" };
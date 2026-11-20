// POST /api/link {email, consent:true, kids:[{name, surname, age?, city?}] (1..5)}
//   -> saves a short link per child (k/<id>) and the list (b/<id>), emails all links to the parent -> {sent:true}.
//   The email is the confirmation: only the mailbox owner ever gets the links.
// POST /api/confirm {c} -> {email, kids:[{name, id, used}]}  (link.html?c=<id> from that email: share / copy page)
// GET  /api/open?l=<id or old token> -> {name, age, city} or {name, used:true} once the letter is sent   (child, index.html; surname and email never leave the server)
import { EMAIL_RE, json, clean, cleanAge, sealLink, openConfirm, limited, seasonEnd, packKid, isShortId, foreign, logErr } from "../lib/common.mjs";
import { sendMail, esc } from "../lib/mail.mjs";
import { takeDaily, count, putSealed, setSealed, getSealed, findKid, markOpened, isUsed, spendMail } from "../lib/store.mjs";

const MAILS_PER_DAY = 3; // emails with links per parent address
const MAX_KIDS = 5;

// Counting must not delay the reply
const bg = (context, p) => (context?.waitUntil ? context.waitUntil(p) : p);

const untilText = (x) => new Date(x - 1).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", year: "numeric" }).replace(/\s*р\.$/, "");

function linksMail(pageUrl, kids, until) {
  const many = kids.length > 1;
  const text = [
    "Добрий день!",
    "",
    many ? "Ось посилання на лист Святому Миколаю для ваших дітей. Надішліть кожній дитині її посилання:" : "Ось посилання на лист Святому Миколаю. Надішліть його дитині:",
    "",
    ...kids.map((k) => `${k.name} ${k.surname}: ${k.url}`),
    "",
    "Ім'я дитини вже буде вписане, а лист прийде на цю пошту.",
    "Щоб лист дитини не потрапив у «Спам», додайте адресу відправника в контакти.",
    `${many ? "Поділитися посиланнями або скопіювати їх" : "Поділитися посиланням або скопіювати його"}: ${pageUrl}`,
    `${many ? "Кожне посилання — для одного листа. Посилання працюють" : "Посилання — для одного листа й працює"} до ${until}.`,
    "",
    "Якщо ви не просили цих посилань, просто проігноруйте цей лист: без них ніхто не зможе надіслати листи на вашу пошту."
  ].join("\n");
  const rows = kids.map((k) => `<div style="margin:0 0 12px;padding:12px 14px;border:2px dashed #e0cfa6;border-radius:10px;background:#fffdf6">
<div style="font-size:18px;font-weight:bold;color:#3b2f4a">${esc(k.name)} ${esc(k.surname)}</div>
<a href="${esc(k.url)}" style="font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#1c3a8a;word-break:break-all">${esc(k.url)}</a></div>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#14234f;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:560px;margin:0 auto;background:#fdf6e3;border:6px solid #c8102e;border-radius:12px;padding:24px;color:#3b2f4a;font-size:17px;line-height:1.5">
<h1 style="margin:0 0 14px;font-size:24px;color:#c8102e">${many ? "Посилання для ваших дітей" : "Посилання для дитини"}</h1>
<p style="margin:0 0 14px">${many ? "Надішліть кожній дитині її посилання" : "Надішліть це посилання дитині"}: ім'я вже буде вписане, а лист Святому Миколаю прийде на цю пошту.</p>
${rows}
<p style="margin:20px 0;text-align:center"><a href="${esc(pageUrl)}" style="display:inline-block;padding:14px 26px;border-radius:999px;background:#c8102e;color:#fff;text-decoration:none;font-weight:bold">${many ? "Поділитися посиланнями" : "Поділитися посиланням"}</a></p>
<p style="margin:0 0 12px;font-size:15px">${many ? "Кожне посилання — для одного листа. Посилання працюють" : "Посилання — для одного листа й працює"} до ${esc(until)}.</p>
<p style="margin:0 0 12px;font-size:15px">Щоб лист дитини не потрапив у «Спам», додайте адресу відправника в контакти.</p>
<p style="margin:0;font-size:13px;color:#6b5d4c">Якщо ви не просили цих посилань, просто проігноруйте цей лист: без них ніхто не зможе надіслати листи на вашу пошту.</p>
</div></body></html>`;
  return { text, html };
}

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    logErr("link failed:", e);
    return json(503, { error: "storage" });
  }
};

async function handle(req, context) {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;
  const site = process.env.URL || url.origin;

  if (pathname.endsWith("/open")) {
    if (limited("open", context, 60, 10 * 60e3)) return json(429, { error: "rate" });
    const kid = await findKid(searchParams.get("l"));
    if (!kid) return json(400, { error: "link" });
    if (kid.batch) bg(context, markOpened(kid.batch, seasonEnd()).then((first) => first && count("confirmed")).catch(() => {}));
    if (await isUsed(searchParams.get("l"))) return json(200, { name: kid.name, used: true });
    return json(200, { name: kid.name, age: kid.age, city: kid.city });
  }

  if (req.method !== "POST") return json(405, { error: "method" });
  if (foreign(req)) return json(403, { error: "origin" });

  if (pathname.endsWith("/confirm")) {
    if (limited("confirm", context, 30, 10 * 60e3)) return json(429, { error: "rate" });
    const c = (await readBody(req))?.c;
    if (isShortId(c)) {
      const b = await getSealed("b", c);
      if (!b) return json(400, { error: "expired" });
      bg(context, markOpened(c, seasonEnd()).then((first) => first && count("confirmed")).catch(() => {}));
      return json(200, { email: b.e, kids: await Promise.all(b.k.map(async (k) => ({ name: k.n, id: k.i, used: await isUsed(k.i) }))) });
    }
    // Confirmation emails sent before short links: the old self-contained link
    const d = openConfirm(c);
    if (!d) return json(400, { error: "expired" });
    const id = sealLink(d);
    return json(200, { email: d.email, kids: [{ name: d.name, id, used: await isUsed(id) }] });
  }

  if (limited("link", context, 30, 10 * 60e3)) return json(429, { error: "rate" });
  const body = await readBody(req);
  if (!body) return json(400, { error: "json" });
  const email = clean(body.email, 120);
  const list = Array.isArray(body.kids) ? body.kids : [];
  if (!EMAIL_RE.test(email) || body.consent !== true || !list.length || list.length > MAX_KIDS) return json(400, { error: "invalid" });
  const kids = [];
  for (const k of list) {
    const kid = { name: clean(k?.name, 60), surname: clean(k?.surname, 60), city: clean(k?.city, 100), age: cleanAge(k?.age), email };
    if (!kid.name || !kid.surname) return json(400, { error: "invalid" });
    if (clean(k?.age, 3) && !kid.age) return json(400, { error: "age" });
    kids.push(kid);
  }

  if (!(await takeDaily("c", email, MAILS_PER_DAY))) return json(429, { error: "confirm-limit" });
  if (!(await spendMail())) return json(503, { error: "busy" });
  const x = seasonEnd();
  const batch = await putSealed("b", { e: email, k: [] }, x); // reserve the id first: children point to it
  for (const kid of kids) {
    kid.id = await putSealed("k", { ...packKid(kid), b: batch }, x);
    kid.url = `${site}/?l=${kid.id}`;
  }
  await setSealed("b", batch, { e: email, k: kids.map((k) => ({ i: k.id, n: k.name })) }, x);
  const pageUrl = `${site}/link.html?c=${batch}`;
  const subject = kids.length > 1 ? "Посилання на листи Святому Миколаю" : `${kids[0].name}: посилання на лист Святому Миколаю`;
  try {
    const info = await sendMail({ to: email, subject, ...linksMail(pageUrl, kids, untilText(x)) });
    bg(context, count("confirmMails").then(() => count("links", kids.length)));
    if (process.env.MAIL_DRY_RUN) return json(200, { sent: true, preview: JSON.parse(info.message), pageUrl, ids: kids.map((k) => k.id) });
  } catch (e) {
    logErr("links sendMail failed:", e);
    return json(502, { error: "mail" });
  }
  return json(200, { sent: true });
}

export const config = { path: ["/api/link", "/api/open", "/api/confirm"] };
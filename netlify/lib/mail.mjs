// Gmail SMTP transport shared by the functions. MAIL_DRY_RUN=1 -> no real sending, JSON preview instead.
import nodemailer from "nodemailer";

let transport;
function getTransport() {
  if (transport) return transport;
  if (process.env.MAIL_DRY_RUN) {
    transport = nodemailer.createTransport({ jsonTransport: true });
  } else {
    const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD are not set");
    // pool: reuse one authenticated SMTP connection while the function instance stays warm.
    // Short timeouts: the whole request must finish well inside Netlify's 10 s function limit.
    transport = nodemailer.createTransport({
      service: "gmail", auth: { user, pass: pass.replace(/\s+/g, "") },
      pool: true, maxConnections: 1,
      connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 7000
    });
  }
  return transport;
}

const RETRY = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE"]);

// to: one bare address (already checked with EMAIL_RE)
export async function sendMail({ to, subject, text, html }) {
  const msg = {
    from: { name: process.env.MAIL_FROM_NAME || "Святий Миколай", address: process.env.GMAIL_USER || "dry-run@example.com" },
    to: { name: "", address: to }, subject, text, html
  };
  const start = Date.now();
  try {
    return await getTransport().sendMail(msg);
  } catch (e) {
    // A pooled connection may have been dropped by Gmail while the function was frozen: retry once on a fresh one,
    // but only if the first attempt failed fast (otherwise the function would time out midway)
    if (!RETRY.has(e.code) || Date.now() - start > 3000) throw e;
    transport?.close?.();
    transport = null;
    return getTransport().sendMail(msg);
  }
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

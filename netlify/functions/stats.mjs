// GET  /api/stats -> {heard}   public number of letters Mykolai received (cached for a minute)
// POST /api/stats  header X-Stats-Key: <STATS_KEY> -> detailed counters for the site owner (stats.html)
import { timingSafeEqual, createHash } from "node:crypto";
import { json, limited } from "../lib/common.mjs";
import { heardTotal, readStats } from "../lib/store.mjs";

const digest = (s) => createHash("sha256").update(String(s)).digest();
const keyOk = (k) => !!process.env.STATS_KEY && !!k && timingSafeEqual(digest(k), digest(process.env.STATS_KEY));

export default async (req, context) => {
  if (req.method === "GET") {
    let heard = 0;
    try { heard = await heardTotal(); } catch (e) { console.error("stats read failed:", e); }
    return new Response(JSON.stringify({ heard }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300"
      }
    });
  }
  if (req.method !== "POST") return json(405, { error: "method" });
  if (limited("stats", context, 10, 10 * 60e3)) return json(429, { error: "rate" });
  if (!keyOk(req.headers.get("x-stats-key"))) return json(403, { error: "key" });
  return json(200, await readStats());
};

export const config = { path: "/api/stats" };

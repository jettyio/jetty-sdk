/**
 * GET /api/runs — the dashboard's data source on Vercel.
 *
 * One Jetty fetch per request (stateless, serverless-native), flattened into the same
 * `{ rows, gate, meta }` payload the local SSE monitor streams. The JETTY_API_TOKEN stays
 * here on the server — it's a Vercel env var, never shipped to the browser. The browser
 * (index.html) polls this every ~1.5s.
 */
import { buildPayload } from "../lib/jetty.js";

const API = process.env.JETTY_API_URL || "https://flows-api.jetty.io";

export default async function handler(req, res) {
  const token = process.env.JETTY_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: "JETTY_API_TOKEN is not set on this deployment." });
    return;
  }
  const collection = process.env.JETTY_COLLECTION || "jetty-vercel-demo";
  const task = process.env.JETTY_AGENT_TASK || "triage-live";
  const limit = Number(process.env.LIMIT || 100);
  const url = `${API}/api/v1/db/trajectories/${encodeURIComponent(collection)}/${encodeURIComponent(task)}?limit=${limit}&page=1`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      res.status(502).json({ error: `Jetty list failed: ${r.status}`, collection, task });
      return;
    }
    const data = await r.json();
    const payload = buildPayload(data, process.env);
    res.setHeader("cache-control", "no-store");
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: e && e.message ? e.message : String(e) });
  }
}

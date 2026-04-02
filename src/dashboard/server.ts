/**
 * Dashboard: 知識の全体像をWeb UIで可視化
 *
 * シンプルなHTTPサーバー + JSON API
 * フロントエンドは静的HTMLで、外部依存なし
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getKnowledgeDB, closeKnowledgeDB } from "../knowledge/db.js";
import { logger } from "../utils/logger.js";

export async function startDashboard(
  scribePath: string,
  port: number = 3141
): Promise<void> {
  const db = getKnowledgeDB(scribePath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    try {
      switch (url.pathname) {
        case "/":
          res.setHeader("Content-Type", "text/html");
          res.end(getDashboardHTML());
          break;

        case "/api/stats":
          res.end(JSON.stringify(getStats(db)));
          break;

        case "/api/nodes":
          res.end(JSON.stringify(getNodes(db, url.searchParams.get("search") || "")));
          break;

        case "/api/graph":
          res.end(JSON.stringify(getGraph(db)));
          break;

        case "/api/mysteries":
          res.end(JSON.stringify(getMysteries(db)));
          break;

        case "/api/screens":
          res.end(JSON.stringify(getScreens(db)));
          break;

        case "/api/endpoints":
          res.end(JSON.stringify(getEndpoints(db)));
          break;

        case "/api/features":
          res.end(JSON.stringify(getFeatures(db)));
          break;

        case "/api/feedback":
          res.end(JSON.stringify(getFeedback(db)));
          break;

        default:
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`PIECE Dashboard: http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    server.close();
    closeKnowledgeDB();
    process.exit(0);
  });
}

function getStats(db: Database.Database) {
  return {
    nodes: (db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as any).c,
    mysteries: (db.prepare("SELECT COUNT(*) as c FROM mysteries WHERE status = 'open'").get() as any).c,
    screens: safeCount(db, "screens"),
    endpoints: safeCount(db, "endpoints"),
    features: safeCount(db, "features"),
    feedback: safeCount(db, "feedback_events"),
    rules: safeCount(db, "learned_rules"),
    cache_hits: (db.prepare("SELECT COALESCE(SUM(hit_count), 0) as c FROM query_cache").get() as any).c,
  };
}

function getNodes(db: Database.Database, search: string) {
  if (search) {
    return db.prepare(
      "SELECT id, summary, node_type, confidence, access_count, created_at FROM knowledge_nodes WHERE summary LIKE ? OR content LIKE ? ORDER BY confidence DESC LIMIT 50"
    ).all(`%${search}%`, `%${search}%`);
  }
  return db.prepare(
    "SELECT id, summary, node_type, confidence, access_count, created_at FROM knowledge_nodes ORDER BY access_count DESC LIMIT 50"
  ).all();
}

function getGraph(db: Database.Database) {
  const nodes = db.prepare(
    "SELECT id, summary, node_type, confidence FROM knowledge_nodes LIMIT 100"
  ).all();
  const links = db.prepare(
    "SELECT source_id, target_id, link_type, weight FROM node_links LIMIT 200"
  ).all();
  return { nodes, links };
}

function getMysteries(db: Database.Database) {
  return db.prepare(
    "SELECT * FROM mysteries ORDER BY priority DESC, created_at DESC LIMIT 50"
  ).all();
}

function getScreens(db: Database.Database) {
  try { return db.prepare("SELECT * FROM screens ORDER BY route").all(); }
  catch { return []; }
}

function getEndpoints(db: Database.Database) {
  try { return db.prepare("SELECT * FROM endpoints ORDER BY path").all(); }
  catch { return []; }
}

function getFeatures(db: Database.Database) {
  try { return db.prepare("SELECT * FROM features ORDER BY name").all(); }
  catch { return []; }
}

function getFeedback(db: Database.Database) {
  try { return db.prepare("SELECT * FROM feedback_events ORDER BY created_at DESC LIMIT 20").all(); }
  catch { return []; }
}

function safeCount(db: Database.Database, table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; }
  catch { return 0; }
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PIECE Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 20px; }
  h2 { color: #58a6ff; margin: 16px 0 8px; font-size: 1.1em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .value { font-size: 2em; font-weight: bold; color: #58a6ff; }
  .card .label { font-size: 0.85em; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: normal; }
  .tag { background: #1f6feb33; color: #58a6ff; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; }
  .search { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; margin-bottom: 16px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 6px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; color: #8b949e; }
  .tab.active { background: #1f6feb; color: white; border-color: #1f6feb; }
</style>
</head>
<body>
<h1>PIECE Dashboard</h1>
<div id="stats" class="grid"></div>
<div class="tabs">
  <div class="tab active" onclick="loadTab('nodes')">Knowledge</div>
  <div class="tab" onclick="loadTab('mysteries')">Mysteries</div>
  <div class="tab" onclick="loadTab('screens')">Screens</div>
  <div class="tab" onclick="loadTab('endpoints')">Endpoints</div>
  <div class="tab" onclick="loadTab('features')">Features</div>
  <div class="tab" onclick="loadTab('feedback')">Feedback</div>
</div>
<input class="search" placeholder="Search knowledge..." oninput="searchNodes(this.value)">
<div id="content"></div>
<script>
async function load() {
  const stats = await (await fetch('/api/stats')).json();
  document.getElementById('stats').innerHTML = Object.entries(stats)
    .map(([k,v]) => '<div class="card"><div class="value">'+v+'</div><div class="label">'+k+'</div></div>').join('');
  loadTab('nodes');
}
async function loadTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event?.target?.classList?.add('active');
  const data = await (await fetch('/api/'+tab)).json();
  if (!Array.isArray(data)) { document.getElementById('content').innerHTML = '<pre>'+JSON.stringify(data,null,2)+'</pre>'; return; }
  if (data.length === 0) { document.getElementById('content').innerHTML = '<p style="color:#8b949e">No data</p>'; return; }
  const keys = Object.keys(data[0]).filter(k => !k.includes('id') || k === 'id').slice(0, 6);
  document.getElementById('content').innerHTML = '<table><tr>'+keys.map(k=>'<th>'+k+'</th>').join('')+'</tr>'
    +data.map(r=>'<tr>'+keys.map(k=>'<td>'+(typeof r[k]==='number'&&k.includes('confid')?(r[k]*100).toFixed(0)+'%':r[k]||'-')+'</td>').join('')+'</tr>').join('')+'</table>';
}
async function searchNodes(q) {
  if (q.length < 2) return;
  const data = await (await fetch('/api/nodes?search='+encodeURIComponent(q))).json();
  const keys = ['summary','node_type','confidence','access_count'];
  document.getElementById('content').innerHTML = '<table><tr>'+keys.map(k=>'<th>'+k+'</th>').join('')+'</tr>'
    +data.map(r=>'<tr>'+keys.map(k=>'<td>'+(k==='confidence'?(r[k]*100).toFixed(0)+'%':r[k]||'-')+'</td>').join('')+'</tr>').join('')+'</table>';
}
load();
</script>
</body>
</html>`;
}

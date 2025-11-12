// src/index.ts
// TMC Claim-Worker: /claim?tx=... → Einmal-Token (60 Min) → /download/:token
// Jetzt mit Bestätigungsseite (Link) statt Auto-Download. JSON via ?json=1 optional.

export interface Env {
	TMC_CLAIMS: KVNamespace; // KV-Binding (siehe wrangler.jsonc)
	tmc_ebooks: R2Bucket;    // R2-Binding (siehe wrangler.jsonc)
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
  }
  
  type CatalogItem = {
	id: string;
	path: string;
	weight?: number;
	active?: boolean;
	category?: string;
  };
  
  type TokenRecord = {
	path: string;
	ebookId: string;
	created: number;
	expires: number;
	used: boolean;
	tx: string;
  };
  
  const TOKEN_TTL_SEC = 60 * 60; // 60 Minuten
  const TELEGRAM_API = "https://api.telegram.org";
  
  // Fallback-Katalog, falls kein CATALOG_JSON in KV liegt
  const DEFAULT_CATALOG: CatalogItem[] = [
	{ id: "ebook_demo", path: "ebooks/demo.pdf", weight: 1, active: true, category: "general" },
  ];
  
  // ------------------------------ Utils ------------------------------
  function randToken(len = 32): string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let s = "";
	for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
	return s;
  }
  
  function weightedPick(items: CatalogItem[]): CatalogItem {
	const active = items.filter((i) => i.active !== false);
	const sum = active.reduce((acc, i) => acc + (i.weight ?? 1), 0);
	let r = Math.random() * sum;
	for (const it of active) {
	  r -= it.weight ?? 1;
	  if (r <= 0) return it;
	}
	return active[active.length - 1];
  }
  
  async function notifyTelegram(env: Env, text: string): Promise<void> {
	const tok = env.TELEGRAM_BOT_TOKEN;
	const chat = env.TELEGRAM_CHAT_ID;
	if (!tok || !chat) return;
	const url = `${TELEGRAM_API}/bot${tok}/sendMessage`;
	try {
	  await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chat_id: chat, text }),
	  });
	} catch { /* ignore */ }
  }
  
  async function getCatalog(env: Env): Promise<CatalogItem[]> {
	const j = await env.TMC_CLAIMS.get("CATALOG_JSON");
	if (!j) return DEFAULT_CATALOG;
	try {
	  const parsed = JSON.parse(j);
	  return Array.isArray(parsed) ? parsed : DEFAULT_CATALOG;
	} catch {
	  return DEFAULT_CATALOG;
	}
  }
  
  function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
	  status,
	  headers: { "content-type": "application/json" },
	});
  }
  
  function html(body: string, status = 200): Response {
	const page = `<!doctype html>
  <html lang="de">
  <head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<title>The Mystery Code – Download bereit</title>
	<style>
	  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
		   margin:0;padding:0;background:#0b0b0d;color:#eaeaea;display:flex;min-height:100vh}
	  .wrap{margin:auto;max-width:720px;padding:32px}
	  .card{background:#141418;border:1px solid #23232a;border-radius:16px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
	  h1{font-size:22px;margin:0 0 8px}
	  p{line-height:1.6;margin:0 0 16px;color:#cfcfd6}
	  .cta{display:inline-block;padding:12px 18px;border-radius:12px;background:#e6c15a;color:#0b0b0d;
		   font-weight:600;text-decoration:none}
	  .cta:hover{filter:brightness(1.05)}
	  .meta{font-size:12px;color:#9c9cab;margin-top:12px}
	</style>
  </head>
  <body>
	<div class="wrap">
	  <div class="card">
		${body}
	  </div>
	</div>
  </body>
  </html>`;
	return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  
  // ------------------------------ Handlers ------------------------------
  async function handleClaim(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const tx = (url.searchParams.get("tx") || "").trim();
	if (!tx) return html("<h1>Fehler</h1><p>Transaktions-ID (tx) fehlt.</p>", 400);
  
	// Doppel-Claim pro Transaktion vermeiden
	const txKey = `tx:${tx}`;
	const existing = await env.TMC_CLAIMS.get(txKey);
	if (existing) {
	  try {
		const rec = JSON.parse(existing) as { token?: string; expires?: number; ebookId?: string };
		if (rec.token && rec.expires && Date.now() < rec.expires) {
		  const link = new URL(`/download/${rec.token}`, url.origin).toString();
		  if (url.searchParams.get("json") === "1") {
			return json({ ok: true, url: link, ebookId: rec.ebookId, ttl: Math.floor((rec.expires - Date.now())/1000) });
		  }
		  return html(`
			<h1>Dein E-Book ist bereit</h1>
			<p>Du kannst deinen Download in den nächsten <b>${Math.floor((rec.expires - Date.now())/60000)}</b> Minuten abrufen.</p>
			<p><a class="cta" href="${link}">Jetzt herunterladen</a></p>
			<p class="meta">Einmal-Link – wird nach Aufruf oder Ablauf automatisch ungültig.</p>
		  `);
		}
	  } catch { /* fällt durch zur Neuvergabe */ }
	}
  
	// Katalog laden + gewichtete Auswahl
	const catalog = await getCatalog(env);
	const pick = weightedPick(catalog);
  
	// Einmal-Token erzeugen & persistieren
	const token = randToken(32);
	const tokenKey = `token:${token}`;
	const expires = Date.now() + TOKEN_TTL_SEC * 1000;
  
	const tokenRec: TokenRecord = {
	  path: pick.path,
	  ebookId: pick.id,
	  created: Date.now(),
	  expires,
	  used: false,
	  tx,
	};
  
	await env.TMC_CLAIMS.put(tokenKey, JSON.stringify(tokenRec), { expirationTtl: TOKEN_TTL_SEC });
	await env.TMC_CLAIMS.put(txKey, JSON.stringify({ token, ebookId: pick.id, issued: Date.now(), expires }));
  
	const link = new URL(`/download/${token}`, url.origin).toString();
	await notifyTelegram(env, `📦 Claim OK\nTX: ${tx}\nE-Book: ${pick.id}\nLink gültig: 60 Min.`);
  
	if (url.searchParams.get("json") === "1") {
	  return json({ ok: true, url: link, ebookId: pick.id, ttl: TOKEN_TTL_SEC });
	}
	return html(`
	  <h1>Dein E-Book ist bereit</h1>
	  <p>Dein persönlicher Download-Link wurde erstellt und ist <b>60 Minuten</b> gültig.</p>
	  <p><a class="cta" href="${link}">Jetzt herunterladen</a></p>
	  <p class="meta">Einmal-Link – wird nach Aufruf oder Ablauf automatisch ungültig.</p>
	`);
  }
  
  async function handleDownload(_req: Request, env: Env, token: string): Promise<Response> {
	const tKey = `token:${token}`;
	const recStr = await env.TMC_CLAIMS.get(tKey);
	if (!recStr) return html("<h1>Link abgelaufen</h1><p>Dieser Einmal-Link ist nicht mehr gültig.</p>", 410);
  
	let rec: TokenRecord;
	try { rec = JSON.parse(recStr) as TokenRecord; } catch {
	  return html("<h1>Fehler</h1><p>Token konnte nicht gelesen werden.</p>", 500);
	}
	if (rec.used) return html("<h1>Bereits benutzt</h1><p>Dieser Link wurde bereits verwendet.</p>", 410);
	if (Date.now() > rec.expires) return html("<h1>Abgelaufen</h1><p>Die 60 Minuten sind leider vorbei.</p>", 410);
  
	const obj = await env.tmc_ebooks.get(rec.path);
	if (!obj || !obj.body) {
		return html(`<h1>Nicht gefunden</h1>
		  <p>Datei existiert nicht im Speicher.</p>
		  <p><code>${rec.path}</code></p>`, 404);
	  }
  
	// echtes Einmal-Token: nach erfolgreicher Ausgabe invalidieren
	await env.TMC_CLAIMS.delete(tKey);
	await notifyTelegram(env, `⬇️ Download served\nE-Book: ${rec.ebookId}`);
  
	const headers = new Headers({
	  "content-type": "application/pdf",
	  "content-disposition": `attachment; filename="${rec.ebookId}.pdf"`,
	  "cache-control": "no-store",
	});
	return new Response(obj.body, { headers });
  }
  
  // ------------------------------ Debug ------------------------------
  async function handleDebug(env: Env, url: URL): Promise<Response> {
	const action = url.searchParams.get("action");
	if (action === "write") {
	  await env.tmc_ebooks.put("ebooks/worker_probe.txt", "hello from worker");
	}
	const listed = await env.tmc_ebooks.list({ limit: 100 });
	const keys = listed.objects.map((o) => o.key);
	const probeKey = "ebooks/demo.pdf";
	const probe = await env.tmc_ebooks.get(probeKey);
	return json({
	  ok: true,
	  wrote: action === "write" ? "ebooks/worker_probe.txt" : null,
	  foundKeys: keys,
	  probeKey,
	  probeOk: !!(probe && probe.body),
	});
  }
  // ------------------------------ Diagnose ------------------------------
async function handleDiag(env: Env): Promise<Response> {
	// 1) Katalog aus KV laden
	let catalog: { id: string; path: string; active?: boolean }[] = [];
	try {
	  const raw = await env.TMC_CLAIMS.get("CATALOG_JSON");
	  if (raw) catalog = JSON.parse(raw);
	} catch { /* ignore */ }
  
	// 2) Alle R2-Keys (ebooks/) auflisten
	const listed = await env.tmc_ebooks.list({ prefix: "ebooks/", limit: 1000 });
	const r2Keys = new Set(listed.objects.map(o => o.key));
  
	// 3) Abgleich
	const missing: { id: string; path: string }[] = [];
	for (const item of catalog) {
	  if (!item || !item.path) continue;
	  if (!r2Keys.has(item.path)) missing.push({ id: item.id, path: item.path });
	}
  
	const extra = [...r2Keys].filter(k => !catalog.some(c => c.path === k));
  
	return new Response(JSON.stringify({
	  ok: true,
	  catalogCount: catalog.length,
	  r2Count: r2Keys.size,
	  missingInR2: missing,    // Diese Keys fehlen im Bucket
	  extraInR2: extra         // Diese Keys sind im Bucket, aber nicht im Katalog referenziert
	}, null, 2), { headers: { "content-type": "application/json" }});
  }
  
  
  // ------------------------------ Router ------------------------------
  export default {
	async fetch(req: Request, env: Env): Promise<Response> {
	  const url = new URL(req.url);
	  const p = url.pathname;
  
	  if (p === "/") return html("<h1>tmc-claim-worker</h1><p>OK.</p>");
	  if (p.startsWith("/debug")) return handleDebug(env, url);
	  if (p.startsWith("/claim")) {
		if (req.method !== "GET") return html("<h1>405</h1><p>Nur GET erlaubt.</p>", 405);
		return handleClaim(req, env);
	  }
	  if (p.startsWith("/download/")) {
		if (req.method !== "GET") return html("<h1>405</h1><p>Nur GET erlaubt.</p>", 405);
		const token = p.split("/").pop() || "";
		return handleDownload(req, env, token);
	  }
	  if (p.startsWith("/diag")) return handleDiag(env);
	  return html("<h1>404</h1><p>Not found.</p>", 404);
	},
  };
  
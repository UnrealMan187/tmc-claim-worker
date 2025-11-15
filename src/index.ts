export interface Env {
	TMC_CLAIMS: KVNamespace;
	tmc_ebooks: R2Bucket;
  
	// Optional / Secrets
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
  
	// PayPal
	PAYPAL_ENV?: string; // "sandbox" | "live"
	PAYPAL_CLIENT_ID?: string;
	PAYPAL_CLIENT_SECRET?: string;
  
	// Business Rules
	MIN_AMOUNT_EUR?: string; // z.B. "10.00"
	THANKYOU_URL?: string;   // z.B. https://themysterycode.de/thankyou.html
  }
  
  /* ----------------------------- KATALOG ---------------------------------- */
  type CatalogItem = {
	id: string;
	path: string;
	weight?: number;
	active?: boolean;
	category?: string;
  };
  type Catalog = { items: CatalogItem[] } | CatalogItem[];
  
  async function loadCatalog(env: Env): Promise<CatalogItem[]> {
	// Variante A: aus KV (Key "CATALOG_JSON")
	const kvRaw = await env.TMC_CLAIMS.get("CATALOG_JSON");
	if (kvRaw) {
	  try {
		const data = JSON.parse(kvRaw) as Catalog;
		const items = Array.isArray(data) ? data : data.items;
		return (items || [])
		  .map((i) => ({
			id: String(i.id),
			path: String(i.path),
			weight: typeof i.weight === "number" ? i.weight : 1,
			active: i.active !== false,
			category: i.category,
		  }))
		  .filter((i) => i.active !== false);
	  } catch {
		// Fallback auf R2
	  }
	}
  
	// Variante B: aus R2 (catalog.json)
	const obj = await env.tmc_ebooks.get("catalog.json");
	if (!obj) return [];
	const txt = await obj.text();
	const data = JSON.parse(txt) as Catalog;
	const items = Array.isArray(data) ? data : data.items;
	return (items || [])
	  .map((i) => ({
		id: String(i.id),
		path: String(i.path),
		weight: typeof i.weight === "number" ? i.weight : 1,
		active: i.active !== false,
		category: i.category,
	  }))
	  .filter((i) => i.active !== false);
  }
  
  function findById(items: CatalogItem[], id?: string | null) {
	if (!id) return undefined;
	const norm = id.trim().toLowerCase();
	return items.find((i) => i.id.toLowerCase() === norm);
  }
  
  function weightedPick(items: CatalogItem[]) {
	const arr = items.filter((i) => i.active !== false);
	if (!arr.length) return undefined;
	const total = arr.reduce((s, i) => s + (i.weight ?? 1), 0);
	let r = Math.random() * total;
	for (const it of arr) {
	  r -= it.weight ?? 1;
	  if (r <= 0) return it;
	}
	return arr[arr.length - 1];
  }
  
  /* ----------------------------- PAYPAL ----------------------------------- */
  type PayPalAmount = { currency_code?: string; value?: string };
  type PayPalOrder = {
	id: string;
	status: string; // APPROVED | COMPLETED | ...
	purchase_units?: Array<{
	  amount?: PayPalAmount;
	  custom_id?: string;
	  description?: string;
	  payments?: { captures?: Array<{ id?: string; status?: string; amount?: PayPalAmount }> };
	}>;
  };
  
  function ppBase(env: Env) {
	return env.PAYPAL_ENV === "live"
	  ? "https://api-m.paypal.com"
	  : "https://api-m.sandbox.paypal.com";
  }
  
  async function getPayPalAccessToken(env: Env) {
	if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
	  throw new Error("PayPal credentials missing");
	}
	const creds = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
	const r = await fetch(`${ppBase(env)}/v1/oauth2/token`, {
	  method: "POST",
	  headers: {
		Authorization: `Basic ${creds}`,
		"Content-Type": "application/x-www-form-urlencoded",
	  },
	  body: "grant_type=client_credentials",
	});
	if (!r.ok) throw new Error(`PayPal token error: ${r.status}`);
	const j = (await r.json()) as { access_token: string };
	return j.access_token;
  }
  
  async function fetchPayPalOrder(env: Env, id: string) {
	const token = await getPayPalAccessToken(env);
	const r = await fetch(`${ppBase(env)}/v2/checkout/orders/${id}`, {
	  headers: { Authorization: `Bearer ${token}` },
	});
	if (!r.ok) throw new Error(`PayPal order error: ${r.status}`);
	return (await r.json()) as PayPalOrder;
  }
  
  async function capturePayPalOrder(env: Env, id: string) {
	const token = await getPayPalAccessToken(env);
	const r = await fetch(`${ppBase(env)}/v2/checkout/orders/${id}/capture`, {
	  method: "POST",
	  headers: {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"PayPal-Request-Id": crypto.randomUUID(),
	  },
	});
	if (!r.ok) throw new Error(`PayPal capture error: ${r.status}`);
	return (await r.json()) as PayPalOrder;
  }
  
  function extractAmount(order: PayPalOrder) {
	const pu = order.purchase_units?.[0];
	const cap = pu?.payments?.captures?.[0]?.amount;
	const src = cap || pu?.amount;
	const amount = parseFloat(src?.value || "0");
	const currency = (src?.currency_code || "EUR").toUpperCase();
	return { amount: isNaN(amount) ? 0 : amount, currency };
  }
  
  /* ----------------------------- UTIL ------------------------------------- */
  async function notifyTelegram(env: Env, text: string) {
	if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
	const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
	await fetch(url, {
	  method: "POST",
	  headers: { "Content-Type": "application/json" },
	  body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
	});
  }
  
  function html(content: string, status = 200) {
	return new Response(content, {
	  status,
	  headers: { "Content-Type": "text/html; charset=UTF-8" },
	});
  }
  
  function thankyouUrl(env: Env) {
	return env.THANKYOU_URL || "https://themysterycode.de/thankyou.html?from=claim";
  }
  
  function footerSection() {
	return `
	<footer style="margin-top:32px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;opacity:0.8">
	  <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
		<a href="https://themysterycode.de/impressum.html"
		   style="color:#e0b35c;text-decoration:none;">Impressum</a>
		<a href="https://themysterycode.de/datenschutz.html"
		   style="color:#e0b35c;text-decoration:none;">Datenschutz</a>
	  </div>
	</footer>`;
  }
  
  /* ----------------------- CLAIM → Token erzeugen -------------------------- */
  async function handlePayPalClaim(req: Request, env: Env) {
	const url = new URL(req.url);
	const orderId = url.searchParams.get("order_id");
	if (!orderId) {
	  return html(
		`<h1>Fehler</h1><p>order_id fehlt.</p>${footerSection()}`,
		400,
	  );
	}
  
	const usedKey = `pp_used:${orderId}`;
	if (await env.TMC_CLAIMS.get(usedKey)) {
	  return html(
		`<h1>Bereits eingelöst</h1><p>Diese Bestellung wurde schon verarbeitet.</p>${footerSection()}`,
		409,
	  );
	}
  
	// Order prüfen & ggf. capturen – jetzt mit try/catch
	let order: PayPalOrder;
	try {
	  order = await fetchPayPalOrder(env, orderId);
	  if (order.status === "APPROVED") {
		order = await capturePayPalOrder(env, orderId);
	  }
	} catch (e: any) {
	  await notifyTelegram(
		env,
		`❌ PayPal-Fehler bei Claim\nOrder: ${orderId}\n${e?.message || String(e)}`,
	  );
	  return html(
		`<h1>Fehler bei der Zahlungsprüfung</h1>
		 <p>Deine Zahlung konnte aktuell nicht bestätigt werden. Bitte aktualisiere die Seite oder versuche es später erneut.</p>
		 <p style="margin-top:12px;font-size:12px;opacity:0.8">
		   Technische Info (nur Testphase):<br>
		   <code>${(e && (e as any).message) || String(e)}</code>
		 </p>
		 ${footerSection()}`,
		502,
	  );
	}
  
	if (order.status !== "COMPLETED") {
	  return html(
		`<h1>Nicht abgeschlossen</h1><p>Status: ${order.status}</p>${footerSection()}`,
		400,
	  );
	}
  
	const { amount, currency } = extractAmount(order);
	const minAmt = parseFloat(env.MIN_AMOUNT_EUR || "10.00");
	if (currency !== "EUR" || amount < minAmt) {
	  return html(
		`<h1>Ungültiger Betrag</h1>
		 <p>Erhalten: ${amount.toFixed(2)} ${currency} (erwartet mind. ${minAmt.toFixed(
		   2,
		 )} EUR)</p>
		 ${footerSection()}`,
		400,
	  );
	}
  
	// Katalog laden, gewünschte ID (optional) oder random pick
	const catalog = await loadCatalog(env);
	const wanted = order.purchase_units?.[0]?.custom_id?.trim();
	let chosen = findById(catalog, wanted) || weightedPick(catalog);
	if (!chosen) {
	  chosen = { id: "ebook_demo", path: "ebooks/demo.pdf", weight: 1 };
	}
  
	// Einmal-Token ablegen (60 Min. gültig)
	const token = crypto.randomUUID().replace(/-/g, "");
	await env.TMC_CLAIMS.put(
	  `token:${token}`,
	  JSON.stringify({ path: chosen.path }),
	  { expirationTtl: 60 * 60 },
	);
	await env.TMC_CLAIMS.put(usedKey, "1", {
	  expirationTtl: 60 * 60 * 24 * 30,
	});
  
	await notifyTelegram(
	  env,
	  `✅ PayPal Claim\nOrder: ${orderId}\nBetrag: ${amount.toFixed(
		2,
	  )} ${currency}\nE-Book: ${chosen.id}`,
	);
  
	const origin = new URL(req.url).origin;
	const urlDownload = `${origin}/download/${token}`;
  
	return html(`
	<html><head><meta charset="utf-8"><title>The Mystery Code</title>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
	  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#000;color:#fff;margin:0;padding:64px;text-align:center}
	  .wrap{max-width:680px;margin:0 auto}
	  .btn{display:inline-block;background:#c9a448;color:#000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600}
	  .muted{opacity:.7}
	</style></head>
	<body><div class="wrap">
	  <h1>Dein Link zum Download deiner Digitalen Datei.</h1>
	  <p class="muted">${chosen.path.split("/").pop()}</p>
	  <p><a class="btn" href="${urlDownload}">Jetzt herunterladen</a></p>
	  <p class="muted">Der Link ist einmalig. Nach dem Download wirst du weitergeleitet.</p>
	  ${footerSection()}
	</div></body></html>`);
  }
  
  /* ------------- /download/:token → HTML + JS + Redirect ------------------- */
  function renderDownloadOrchestrator(token: string, redirectTo: string) {
	return html(`<!doctype html>
  <html lang="de">
  <head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>Dein Download – The Mystery Code</title>
	<style>
	  body {
		font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
		background:#000;
		color:#fff;
		margin:0;
		padding:64px 16px;
		text-align:center;
	  }
	  .wrap {
		max-width:680px;
		margin:0 auto;
	  }
	  h1 {
		font-size:24px;
		margin-bottom:8px;
	  }
	  p.muted {
		opacity:.75;
		font-size:14px;
		margin-top:0;
		margin-bottom:16px;
	  }
	  .download-consent-box {
		margin:24px auto 0;
		padding:16px 18px;
		max-width:520px;
		text-align:left;
		background:#0f0f15;
		border:1px solid rgba(212,175,55,0.35);
		border-radius:8px;
		transition: border-color 0.2s ease, box-shadow 0.2s ease;
	  }
	  .download-consent-box.error {
		border-color:#ff4d4f;
		box-shadow:0 0 0 1px rgba(255,77,79,0.6);
	  }
	  .download-consent {
		display:flex;
		gap:10px;
		align-items:flex-start;
		font-size:13px;
		line-height:1.5;
		color:#cfcfd8;
	  }
	  .download-consent-box.error .download-consent span {
		color:#ffb3b6;
	  }
	  .download-consent input[type="checkbox"] {
		margin-top:2px;
		accent-color:#c9a448;
	  }
	  .download-hint {
		font-size:12px;
		opacity:.7;
		margin-top:8px;
	  }
	  .download-actions {
		margin-top:18px;
		text-align:left;
	  }
	  .download-button {
		display:inline-block;
		background:#c9a448;
		color:#000;
		padding:10px 20px;
		border-radius:6px;
		border:none;
		font-weight:600;
		font-size:14px;
		cursor:pointer;
		transition:opacity 0.15s ease, transform 0.1s ease;
	  }
	  .download-button:hover:enabled {
		opacity:0.9;
		transform:translateY(-1px);
	  }
	  .download-button:disabled {
		opacity:0.4;
		cursor:not-allowed;
		transform:none;
	  }
	  .small-note {
		font-size:11px;
		opacity:0.7;
		margin-top:16px;
		text-align:center;
	  }
	</style>
  </head>
  <body>
	<div class="wrap">
	  <h1>Dein digitaler Inhalt ist bereit.</h1>
	  <p class="muted">
		Um den Download zu starten, bestätige bitte zuerst den Hinweis zum Widerrufsrecht.
	  </p>
  
	  <div class="download-consent-box">
		<label class="download-consent">
		  <input type="checkbox" id="consentCheckbox">
		  <span>
			Ich stimme ausdrücklich zu, dass die Ausführung des Vertrags
			(Bereitstellung des digitalen Inhalts) vor Ablauf der Widerrufsfrist beginnt.
			Mir ist bekannt, dass ich dadurch mein Widerrufsrecht für diesen digitalen Inhalt verliere.
		  </span>
		</label>
		<p class="download-hint">
		  Der Download steht dir im Anschluss sofort zur Verfügung.
		</p>
  
		<div class="download-actions">
		  <button id="downloadButton" class="download-button" disabled>
			Download jetzt starten
		  </button>
		</div>
	  </div>
  
	  <p class="small-note">
		Der Link ist einmalig gültig. Nach dem Download wirst du automatisch weitergeleitet.
	  </p>
  
	  ${footerSection()}
	</div>
  
	<script>
	  (function () {
		const checkbox = document.getElementById('consentCheckbox');
		const button = document.getElementById('downloadButton');
		const box = document.querySelector('.download-consent-box');
		if (!checkbox || !button || !box) return;
  
		let isRunning = false;
  
		checkbox.addEventListener('change', function () {
		  button.disabled = !checkbox.checked;
		  if (checkbox.checked) {
			box.classList.remove('error');
		  }
		});
  
		button.addEventListener('click', async function (ev) {
		  ev.preventDefault();
  
		  if (!checkbox.checked) {
			// Visuelles Feedback in Rot
			box.classList.add('error');
			return;
		  }
  
		  if (isRunning) return;
		  isRunning = true;
		  button.disabled = true;
		  const originalText = button.textContent;
		  button.textContent = 'Download wird vorbereitet …';
  
		  try {
			const res = await fetch('/file/${token}', { cache: 'no-store' });
			if (!res.ok) throw new Error('HTTP ' + res.status);
  
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = (res.headers.get('x-filename') || 'ebook.pdf');
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		  } catch (e) {
			console.error('Download fehlgeschlagen', e);
			box.classList.add('error');
			button.textContent = 'Fehler – bitte erneut versuchen';
			button.disabled = false;
			isRunning = false;
			return;
		  }
  
		  // kurzer Delay, dann Redirect auf Thankyou-Page
		  setTimeout(function () {
			location.href = ${JSON.stringify(redirectTo)};
		  }, 1500);
		});
	  })();
	</script>
  </body>
  </html>`);
  }  
  
  async function handleDownloadPage(req: Request, env: Env) {
	const token = new URL(req.url).pathname.split("/").pop()!;
	return renderDownloadOrchestrator(token, thankyouUrl(env));
  }
  
  /* ---------------- /file/:token → echtes PDF + One-Shot ------------------- */
  async function handleDownloadBinary(req: Request, env: Env) {
	const token = new URL(req.url).pathname.split("/").pop();
	if (!token) return html("<h1>Fehler</h1><p>Token fehlt.</p>", 400);
  
	const entry = (await env.TMC_CLAIMS.get(
	  `token:${token}`,
	  "json",
	)) as { path: string } | null;
	if (!entry) {
	  return html(
		"<h1>Abgelaufen</h1><p>Dieser Link ist nicht mehr gültig.</p>",
		404,
	  );
	}
  
	const obj = await env.tmc_ebooks.get(entry.path);
	if (!obj) {
	  return html(
		"<h1>Datei fehlt</h1><p>Im Speicher nicht gefunden.</p>",
		404,
	  );
	}
  
	await env.TMC_CLAIMS.delete(`token:${token}`);
  
	const filename = entry.path.split("/").pop() || "ebook.pdf";
	const headers = new Headers();
	headers.set("Content-Type", "application/pdf");
	headers.set("Content-Disposition", `attachment; filename="${filename}"`);
	headers.set("Cache-Control", "no-store");
	headers.set("x-filename", filename);
  
	return new Response(obj.body, { headers });
  }
  
  /* -------------------------------- ROUTER -------------------------------- */
  export default {
	async fetch(req: Request, env: Env): Promise<Response> {
	  const p = new URL(req.url).pathname;
  
	  if (p === "/debug/thankyou") {
		return new Response(
		  JSON.stringify({ thankyou: thankyouUrl(env) }, null, 2),
		  { headers: { "content-type": "application/json; charset=utf-8" } },
		);
	  }
  
	  if (p.startsWith("/paypal-claim")) return handlePayPalClaim(req, env);
	  if (p.startsWith("/download/")) return handleDownloadPage(req, env);
	  if (p.startsWith("/file/")) return handleDownloadBinary(req, env);
  
	  return html("<h1>The Mystery Code</h1><p>Worker online.</p>");
	},
  };
  
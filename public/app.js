// nVestPadi dashboard — vanilla JS, no build step. Talks to the REST API in src/server/server.ts.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
	get(key, fallback) {
		try {
			return localStorage.getItem(key) ?? fallback;
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
		} catch {
			/* storage unavailable (private mode) — preferences just won't persist */
		}
	},
};

const state = {
	exchange: store.get("nvest.exchange", "NGX"),
	movers: "gainers",
	market: null,
	status: null,
	watchlist: [],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const esc = (v) =>
	String(v ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

const fmtPrice = (n) =>
	n == null
		? "—"
		: Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });

function fmtCompact(n) {
	if (n == null || !Number.isFinite(n)) return "—";
	return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function chg(pct) {
	if (pct == null) return '<span class="chg flat">—</span>';
	const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
	return `<span class="chg ${cls}">${pct > 0 ? "+" : ""}${Number(pct).toFixed(2)}%</span>`;
}

const currency = () => (state.exchange === "NGX" ? "₦" : "$");

function toast(message, kind = "info") {
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = message;
	$("#toasts").append(el);
	setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
}

function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

function sparkSvg(values, cls = "spark") {
	if (!values || values.length < 2) return `<svg class="${cls}" viewBox="0 0 64 24"></svg>`;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pts = values
		.map((v, i) => `${(i / (values.length - 1)) * 64},${22 - ((v - min) / (max - min || 1)) * 20}`)
		.join(" ");
	const colour = values.at(-1) >= values[0] ? "var(--up)" : "var(--down)";
	return `<svg class="${cls}" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" stroke="${colour}" stroke-width="1.6" fill="none"/></svg>`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
	const key = store.get("nvest.apiKey", "");
	const res = await fetch(path, {
		...options,
		headers: {
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) {
		showKeyPrompt();
		throw new Error("API key required");
	}
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

function showKeyPrompt() {
	const banner = $("#banner");
	if (!banner.hidden) return;
	banner.hidden = false;
	banner.innerHTML = `<form id="key-form">This server is protected. Enter its API key:<input type="password" name="key" required autocomplete="current-password" aria-label="API key"/><button class="btn btn-primary">Unlock</button></form>`;
	$("#key-form").addEventListener("submit", (e) => {
		e.preventDefault();
		store.set("nvest.apiKey", new FormData(e.target).get("key"));
		banner.hidden = true;
		refreshAll();
	});
}

// ---------------------------------------------------------------------------
// Market overview
// ---------------------------------------------------------------------------

async function loadMarket() {
	const m = await api(`/api/market?exchange=${state.exchange}&top=8`);
	state.market = m;
	$("#session").textContent = m.date ? `Session ${m.date}` : "";

	const total = m.count || 1;
	const [up, flat, down] = $$("#breadth-bar span");
	up.style.flexGrow = m.advancers / total;
	flat.style.flexGrow = m.unchanged / total;
	down.style.flexGrow = m.decliners / total;
	$("#adv").textContent = `▲ ${m.advancers}`;
	$("#unch").textContent = `■ ${m.unchanged}`;
	$("#dec").textContent = `▼ ${m.decliners}`;
	$("#value").textContent = m.count ? `${currency()}${fmtCompact(m.totalValue)}` : "—";
	$("#volume").textContent = m.count ? `${fmtCompact(m.totalVolume)} shares` : "";

	const traded = m.sectors.filter((s) => s.advancers + s.decliners > 0);
	const best = traded[0];
	const worst = traded.at(-1);
	$("#best-sector").textContent = best?.sector ?? "—";
	$("#best-sector-chg").innerHTML = best ? chg(best.avgChangePct) : "";
	$("#worst-sector").textContent = worst?.sector ?? "—";
	$("#worst-sector-chg").innerHTML = worst ? chg(worst.avgChangePct) : "";

	renderMovers();
	renderSectors();
	fillSectorFilter();
}

function emptyMarket() {
	return `<div class="empty">No ${state.exchange} data yet. Click <b>Sync</b> or run <code>nvest sync</code>.</div>`;
}

function renderMovers() {
	const list = state.market?.[state.movers] ?? [];
	$("#movers").innerHTML = list.length
		? list
				.map(
					(q) => `<li><button type="button" data-open="${esc(q.exchange)}:${esc(q.symbol)}">
						<b>${esc(q.symbol)}</b>${chg(q.changePct)}
						<span class="name">${esc(q.name)} · ${fmtPrice(q.close)}</span>
					</button></li>`,
				)
				.join("")
		: `<li style="grid-column:1/-1">${emptyMarket()}</li>`;
}

function renderSectors() {
	const sectors = state.market?.sectors ?? [];
	const maxAbs = Math.max(0.5, ...sectors.map((s) => Math.abs(s.avgChangePct)));
	$("#sectors").innerHTML = sectors.length
		? sectors
				.map((s) => {
					const width = (Math.abs(s.avgChangePct) / maxAbs) * 50;
					const cls = s.avgChangePct >= 0 ? "up" : "down";
					return `<div class="sector-row" title="${s.advancers} up · ${s.decliners} down · ${s.count} stocks">
						<span class="label">${esc(s.sector)}</span>
						<div class="bar-track"><div class="bar ${cls}" style="width:${width}%"></div></div>
						<span class="num ${cls}" style="text-align:right">${s.avgChangePct > 0 ? "+" : ""}${s.avgChangePct.toFixed(2)}%</span>
					</div>`;
				})
				.join("")
		: emptyMarket();
}

function fillSectorFilter() {
	const select = $('#screen-form [name="sector"]');
	const current = select.value;
	const sectors = (state.market?.sectors ?? []).map((s) => s.sector).sort();
	select.innerHTML = `<option value="">All sectors</option>${sectors.map((s) => `<option${s === current ? " selected" : ""}>${esc(s)}</option>`).join("")}`;
}

// ---------------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------------

async function loadScreen() {
	const form = new FormData($("#screen-form"));
	const params = new URLSearchParams({ exchange: state.exchange, limit: "200" });
	for (const [k, v] of form) if (v) params.set(k, v);
	const rows = await api(`/api/screen?${params}`);
	const showRsi = rows.some((r) => r.rsi14 != null);
	$("#rsi-col").hidden = !showRsi;
	$("#screen-count").textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
	$("#screen-body").innerHTML = rows.length
		? rows
				.map(
					(r) => `<tr tabindex="0" data-open="${esc(r.exchange)}:${esc(r.symbol)}">
						<td class="sym"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span></td>
						<td class="hide-sm muted">${esc(r.sector ?? "")}</td>
						<td class="num">${fmtPrice(r.close)}</td>
						<td class="num">${chg(r.changePct)}</td>
						<td class="num hide-sm">${fmtCompact(r.tradedValue)}</td>
						${showRsi ? `<td class="num">${r.rsi14 ?? "—"}</td>` : ""}
					</tr>`,
				)
				.join("")
		: `<tr><td colspan="6">${state.market?.count ? '<div class="empty">No stocks match these filters.</div>' : emptyMarket()}</td></tr>`;
}

// ---------------------------------------------------------------------------
// Security detail drawer
// ---------------------------------------------------------------------------

let lastFocus = null;

async function openSecurity(exchange, symbol) {
	lastFocus = document.activeElement;
	history.replaceState(null, "", `#${exchange}:${symbol}`); // shareable deep link
	const drawer = $("#drawer");
	drawer.hidden = false;
	document.body.style.overflow = "hidden";
	$("#drawer-body").innerHTML =
		'<div class="skeleton" style="width:40%;height:20px"></div><div class="skeleton"></div><div class="skeleton" style="height:200px"></div>';
	$(".drawer-close").focus();
	try {
		const data = await api(`/api/securities/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}`);
		renderSecurity(data);
	} catch (err) {
		$("#drawer-body").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
	}
}

function closeDrawer() {
	$("#drawer").hidden = true;
	history.replaceState(null, "", location.pathname + location.search);
	document.body.style.overflow = "";
	lastFocus?.focus?.();
}

const EXPLAIN = {
	rsi: (v) =>
		v >= 70
			? "Overbought — momentum may be stretched"
			: v <= 30
				? "Oversold — selling may be exhausted"
				: "Neutral momentum",
	macd: (h) => (h >= 0 ? "Bullish momentum (MACD above signal)" : "Bearish momentum (MACD below signal)"),
	vol: () => "Annualised, from the last 21 sessions",
	atr: () => "Average daily price range (14 sessions)",
};

function renderSecurity({ report: r, history, watched }) {
	const s = r.security;
	const i = r.indicators;
	const cur = s.currency === "NGN" ? "₦" : s.currency === "USD" ? "$" : `${s.currency} `;
	const perf = ["1W", "1M", "3M", "6M", "1Y"]
		.map(
			(k) =>
				`<div><span>${k}</span><b class="${(r.performance[k] ?? 0) >= 0 ? "up" : "down"}">${r.performance[k] == null ? '<span class="muted">—</span>' : `${r.performance[k] > 0 ? "+" : ""}${r.performance[k].toFixed(1)}%`}</b></div>`,
		)
		.join("");
	const ind = (label, value, note, extra = "") =>
		`<div class="ind"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}${extra}</div>`;

	$("#drawer-body").innerHTML = `
		<div class="d-head">
			<p class="muted small">${esc(s.exchange)} · ${esc(s.symbol)}${s.sector ? ` · ${esc(s.sector)}` : ""}</p>
			<h2 id="drawer-title">${esc(s.name)}</h2>
		</div>
		<div class="d-price">
			<span class="big">${cur}${fmtPrice(r.latest.close)}</span>${chg(r.latest.changePct)}
			<span class="muted small">${esc(r.latest.date)}</span>
			${r.signal ? `<span class="signal ${r.signal.signal}" title="${esc(r.signal.reason)}">${r.signal.strength.toUpperCase()} ${r.signal.signal}</span>` : ""}
		</div>
		<div class="d-actions">
			<button class="btn" type="button" id="d-watch">${watched ? "★ Watching" : "☆ Add to watchlist"}</button>
			<button class="btn" type="button" id="d-alert">🔔 Alert</button>
			<button class="btn" type="button" id="d-ask">Ask AI about ${esc(s.symbol)}</button>
		</div>
		<div class="chart-wrap" id="chart"></div>
		<div class="legend"><span><i style="background:var(--${(history.at(-1)?.close ?? 0) >= (history[0]?.close ?? 0) ? "up" : "down"})"></i>Close</span><span><i style="background:var(--chart-1)"></i>SMA 20</span><span><i style="background:var(--chart-2)"></i>SMA 50</span></div>
		<div class="perf">${perf}</div>
		<h3>Indicators</h3>
		<div class="indicators">
			${ind("Trend", esc(r.trend), "From 20/50-day moving averages")}
			${ind("RSI (14)", i.rsi14 ?? "—", i.rsi14 == null ? "Needs 15+ sessions" : EXPLAIN.rsi(i.rsi14), i.rsi14 == null ? "" : `<div class="gauge"><i style="left:${i.rsi14}%"></i></div>`)}
			${ind("MACD histogram", i.macd ? i.macd.histogram : "—", i.macd ? EXPLAIN.macd(i.macd.histogram) : "Needs 26+ sessions")}
			${ind("SMA 20 / 50 / 200", [i.sma20, i.sma50, i.sma200].map(fmtPrice).join(" / "), "")}
			${ind("Bollinger (20, 2)", i.bollinger ? `${fmtPrice(i.bollinger.lower)} – ${fmtPrice(i.bollinger.upper)}` : "—", "Typical trading band")}
			${ind("52-week range", r.range52w ? `${fmtPrice(r.range52w.low)} – ${fmtPrice(r.range52w.high)}` : "—", r.range52w ? `Price at ${r.range52w.positionPct}% of range` : "")}
			${ind("Volatility", i.volatilityPct == null ? "—" : `${i.volatilityPct}%`, EXPLAIN.vol())}
			${ind("ATR (14)", fmtPrice(i.atr14), EXPLAIN.atr())}
		</div>
		<h3>Summary</h3>
		<ul class="highlights">${r.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
		<p class="muted small" style="margin-top:16px">Educational analysis based on ${r.bars} sessions. Not investment advice.</p>`;

	renderChart($("#chart"), history);

	$("#d-watch").addEventListener("click", async (e) => {
		try {
			if (watched) await api(`/api/watchlist/${s.exchange}/${encodeURIComponent(s.symbol)}`, { method: "DELETE" });
			else await api("/api/watchlist", { method: "POST", body: { symbol: s.symbol, exchange: s.exchange } });
			watched = !watched;
			e.target.textContent = watched ? "★ Watching" : "☆ Add to watchlist";
			loadWatchlist();
		} catch (err) {
			toast(err.message, "error");
		}
	});
	$("#d-alert").addEventListener("click", () => {
		closeDrawer();
		const form = $("#alert-form");
		form.symbol.value = s.symbol;
		form.dataset.exchange = s.exchange;
		form.condition.value = "below";
		form.threshold.value = (r.latest.close * 0.95).toFixed(2);
		form.threshold.focus();
		form.scrollIntoView({ behavior: "smooth", block: "center" });
	});
	$("#d-ask").addEventListener("click", () => {
		closeDrawer();
		ask(`Give me a quick read on ${s.name} (${s.symbol}): trend, momentum and key levels.`);
	});
}

function smaSeries(values, period) {
	return values.map((_, i) =>
		i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period,
	);
}

function renderChart(container, bars) {
	if (bars.length < 2) {
		container.innerHTML = '<div class="empty">Not enough history to chart yet.</div>';
		return;
	}
	const W = 600;
	const H = 240;
	const pad = { l: 8, r: 52, t: 10, b: 22 };
	const closes = bars.map((b) => b.close);
	const sma20 = smaSeries(closes, 20);
	const sma50 = smaSeries(closes, 50);
	const all = [...closes, ...sma20.filter((v) => v != null), ...sma50.filter((v) => v != null)];
	const min = Math.min(...all);
	const max = Math.max(...all);
	const span = max - min || 1;
	const x = (i) => pad.l + (i / (bars.length - 1)) * (W - pad.l - pad.r);
	const y = (v) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
	// SVG path that lifts the pen over null gaps (e.g. SMA warm-up).
	const path = (series) => {
		let d = "";
		let drawing = false;
		for (const [i, v] of series.entries()) {
			if (v == null) {
				drawing = false;
				continue;
			}
			d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			drawing = true;
		}
		return d;
	};
	const up = closes.at(-1) >= closes[0];
	const colour = up ? "var(--up)" : "var(--down)";
	const ticks = [0, 0.5, 1].map((f) => min + span * f);
	const dateIdx = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];

	container.innerHTML = `
		<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price chart">
			<defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0.18"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>
			${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${W - pad.r + 6}" y="${y(t) + 4}">${fmtPrice(t)}</text>`).join("")}
			${dateIdx.map((i, n) => `<text class="axis" x="${x(i)}" y="${H - 4}" text-anchor="${["start", "middle", "end"][n]}">${esc(bars[i].date)}</text>`).join("")}
			<path d="${path(closes)}L${x(bars.length - 1)},${H - pad.b}L${x(0)},${H - pad.b}Z" fill="url(#fill)" stroke="none"/>
			<path class="sma50" d="${path(sma50)}"/>
			<path class="sma20" d="${path(sma20)}"/>
			<path class="price" d="${path(closes)}" stroke="${colour}"/>
			<line class="cross" id="cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
		</svg>
		<div class="chart-tip" id="tip" hidden></div>`;

	const svg = $("svg", container);
	const tip = $("#tip", container);
	const cross = $("#cross", container);
	const move = (clientX) => {
		const rect = svg.getBoundingClientRect();
		const ratio = (clientX - rect.left) / rect.width;
		const i = Math.max(
			0,
			Math.min(bars.length - 1, Math.round(((ratio * W - pad.l) / (W - pad.l - pad.r)) * (bars.length - 1))),
		);
		const b = bars[i];
		cross.setAttribute("x1", x(i));
		cross.setAttribute("x2", x(i));
		cross.setAttribute("visibility", "visible");
		tip.hidden = false;
		tip.innerHTML = `<b>${fmtPrice(b.close)}</b> ${b.changePct == null ? "" : chg(b.changePct)} <span class="muted">${esc(b.date)}</span>`;
		const left = (x(i) / W) * rect.width;
		tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), rect.width - tip.offsetWidth)}px`;
	};
	svg.addEventListener("pointermove", (e) => move(e.clientX));
	svg.addEventListener("pointerleave", () => {
		tip.hidden = true;
		cross.setAttribute("visibility", "hidden");
	});
}

// ---------------------------------------------------------------------------
// Watchlist & alerts
// ---------------------------------------------------------------------------

async function loadWatchlist() {
	const list = await api("/api/watchlist");
	state.watchlist = list;
	$("#watch-count").textContent = list.length ? `${list.length}` : "";
	$("#watchlist").innerHTML = list.length
		? list
				.map(
					(w) => `<li data-open="${esc(w.exchange)}:${esc(w.symbol)}" tabindex="0">
						<div class="meta"><b>${esc(w.symbol)}</b><span>${esc(w.quote?.name ?? w.exchange)}</span></div>
						${sparkSvg(w.spark)}
						<div class="right"><div>${fmtPrice(w.quote?.close)}</div>${chg(w.quote?.changePct)}</div>
					</li>`,
				)
				.join("")
		: '<li class="empty">Open any stock and tap ☆ to watch it.</li>';
}

async function loadAlerts() {
	const list = await api("/api/alerts");
	$("#alerts").innerHTML = list.length
		? list
				.map(
					(a) => `<li>
						<span class="grow"><b>${esc(a.symbol)}</b> <span class="muted">${esc(a.condition)} ${a.threshold}</span>${a.note ? `<br><span class="muted small">${esc(a.note)}</span>` : ""}</span>
						<span class="status ${a.triggeredAt ? "fired" : "active"}" title="${a.triggeredAt ? `Triggered ${esc(a.triggeredAt)} at ${a.triggerValue}` : "Waiting"}">${a.triggeredAt ? "fired" : "active"}</span>
						<button class="link" type="button" data-delete-alert="${a.id}" aria-label="Delete alert ${a.id}">✕</button>
					</li>`,
				)
				.join("")
		: '<li class="empty">No alerts yet.</li>';
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

const SUGGESTIONS = {
	NGX: ["How did banks do today?", "Which sectors are leading?", "Biggest losers this session"],
	US: ["How is big tech trading?", "Which stocks are oversold?", "Top movers today"],
};

function renderSuggestions() {
	$("#suggestions").innerHTML = SUGGESTIONS[state.exchange]
		.map((s) => `<button type="button" class="chip">${esc(s)}</button>`)
		.join("");
}

async function ask(question) {
	const form = $("#ask-form");
	form.question.value = question;
	const out = $("#answer");
	const button = $("button[type=submit]", form);
	button.disabled = true;
	out.innerHTML =
		'<div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:75%"></div><div class="skeleton" style="width:60%"></div>';
	try {
		const a = await api("/api/ask", { method: "POST", body: { question, exchange: state.exchange } });
		const text = esc(a.answer)
			.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
			.replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>');
		out.innerHTML = `<div class="text">${text}</div>
			${a.sources.length ? `<details><summary>${a.sources.length} source${a.sources.length > 1 ? "s" : ""}</summary><ol>${a.sources.map((s) => `<li>${esc(s.title)} <span class="muted">— ${esc(s.source)}</span></li>`).join("")}</ol></details>` : ""}
			<p class="muted small" style="margin-top:8px">${esc(a.model)} · information only, not investment advice</p>`;
	} catch (err) {
		out.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
	} finally {
		button.disabled = false;
	}
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function setupSearch() {
	const input = $("#search");
	const list = $("#search-results");
	const box = input.closest(".search");
	let items = [];
	let active = -1;

	const close = () => {
		list.hidden = true;
		box.setAttribute("aria-expanded", "false");
		active = -1;
	};
	const highlight = () => {
		for (const [i, li] of $$("li", list).entries()) li.setAttribute("aria-selected", String(i === active));
	};
	const choose = (i) => {
		const s = items[i];
		if (!s) return;
		close();
		input.value = "";
		openSecurity(s.exchange, s.symbol);
	};

	input.addEventListener(
		"input",
		debounce(async () => {
			const q = input.value.trim();
			if (q.length < 1) return close();
			try {
				items = await api(`/api/securities?q=${encodeURIComponent(q)}`);
			} catch {
				items = [];
			}
			list.innerHTML = items.length
				? items
						.map(
							(s, i) =>
								`<li role="option" data-i="${i}"><b>${esc(s.symbol)}</b><span>${esc(s.name)}</span><span class="muted small" style="margin-left:auto">${esc(s.exchange)}</span></li>`,
						)
						.join("")
				: '<li class="muted">No matches — try syncing first</li>';
			list.hidden = false;
			box.setAttribute("aria-expanded", "true");
			active = -1;
		}, 150),
	);
	input.addEventListener("keydown", (e) => {
		if (list.hidden) return;
		if (e.key === "ArrowDown") active = Math.min(items.length - 1, active + 1);
		else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
		else if (e.key === "Enter") {
			e.preventDefault();
			return choose(active === -1 ? 0 : active);
		} else if (e.key === "Escape") return close();
		else return;
		e.preventDefault();
		highlight();
	});
	list.addEventListener("mousedown", (e) => {
		const li = e.target.closest("li[data-i]");
		if (li) choose(Number(li.dataset.i));
	});
	input.addEventListener("blur", () => setTimeout(close, 100));
	document.addEventListener("keydown", (e) => {
		if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
			e.preventDefault();
			input.focus();
		}
	});
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function refreshAll() {
	const results = await Promise.allSettled([loadMarket(), loadWatchlist(), loadAlerts()]);
	await loadScreen().catch(() => undefined);
	const failed = results.find((r) => r.status === "rejected");
	if (failed && failed.reason.message !== "API key required") toast(failed.reason.message, "error");
}

async function loadStatus() {
	const s = await api("/api/status");
	state.status = s;
	const pill = $("#ai-pill");
	pill.textContent = s.features.ai ? s.features.ai.chatModel : "AI off";
	pill.classList.toggle("on", Boolean(s.features.ai));
	pill.title = s.features.ai
		? `${s.features.ai.provider}${s.features.search ? " + document search" : ""}`
		: "Set AI_PROVIDER and AI_API_KEY to enable";
	$("#channels").textContent = s.features.notifications.length
		? `→ ${s.features.notifications.join(", ")}`
		: "in-app only";
	$('#alert-form [name="condition"]').innerHTML = Object.entries(s.alertConditions)
		.map(([k, label]) => `<option value="${esc(k)}" title="${esc(label)}">${esc(k)}</option>`)
		.join("");
}

function selectTab(selector, isSelected) {
	for (const el of $$(selector)) el.setAttribute("aria-selected", String(isSelected(el)));
}

function setExchange(exchange) {
	state.exchange = exchange;
	store.set("nvest.exchange", exchange);
	selectTab("[data-exchange]", (b) => b.dataset.exchange === exchange);
	$('#screen-form [name="sector"]').value = "";
	renderSuggestions();
	refreshAll();
}

function setupTheme() {
	const saved = store.get("nvest.theme", null);
	if (saved) document.documentElement.dataset.theme = saved;
	$("#theme").addEventListener("click", () => {
		const dark = document.documentElement.dataset.theme
			? document.documentElement.dataset.theme === "dark"
			: matchMedia("(prefers-color-scheme: dark)").matches;
		const next = dark ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		store.set("nvest.theme", next);
	});
}

function init() {
	setupTheme();
	setupSearch();
	renderSuggestions();

	for (const b of $$("[data-exchange]")) b.addEventListener("click", () => setExchange(b.dataset.exchange));
	for (const b of $$("[data-movers]")) {
		b.addEventListener("click", () => {
			state.movers = b.dataset.movers;
			selectTab("[data-movers]", (x) => x === b);
			renderMovers();
		});
	}

	// Any element with data-open="EXCHANGE:SYMBOL" opens the detail drawer.
	document.addEventListener("click", (e) => {
		const target = e.target.closest("[data-open]");
		if (target) {
			const [exchange, symbol] = target.dataset.open.split(":");
			openSecurity(exchange, symbol);
		}
		if (e.target.closest("[data-close]")) closeDrawer();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
		if (e.key === "Enter" && e.target.matches("tr[data-open], li[data-open]")) e.target.click();
	});

	const screenForm = $("#screen-form");
	screenForm.addEventListener(
		"input",
		debounce(() => loadScreen().catch((err) => toast(err.message, "error")), 250),
	);
	screenForm.addEventListener("submit", (e) => e.preventDefault());

	$("#ask-form").addEventListener("submit", (e) => {
		e.preventDefault();
		const q = e.target.question.value.trim();
		if (q) ask(q);
	});
	$("#ask-form").question.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#ask-form").requestSubmit();
	});
	$("#suggestions").addEventListener("click", (e) => {
		if (e.target.matches(".chip")) ask(e.target.textContent);
	});

	$("#alert-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const f = e.target;
		try {
			await api("/api/alerts", {
				method: "POST",
				body: {
					symbol: f.symbol.value.trim(),
					exchange: f.dataset.exchange || undefined,
					condition: f.condition.value,
					threshold: Number(f.threshold.value),
				},
			});
			f.reset();
			delete f.dataset.exchange;
			toast("Alert created");
			loadAlerts();
		} catch (err) {
			toast(err.message, "error");
		}
	});
	$("#alerts").addEventListener("click", async (e) => {
		const id = e.target.closest("[data-delete-alert]")?.dataset.deleteAlert;
		if (!id) return;
		await api(`/api/alerts/${id}`, { method: "DELETE" }).catch((err) => toast(err.message, "error"));
		loadAlerts();
	});

	$("#sync").addEventListener("click", async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true;
		btn.classList.add("spinning");
		$("span", btn).textContent = "Syncing…";
		try {
			const r = await api("/api/sync", { method: "POST", body: { exchange: "all" } });
			const summary = r.results.map((x) => `${x.exchange} ${x.bars}`).join(" · ");
			toast(`Synced ${summary}${r.triggered.length ? ` · ${r.triggered.length} alert(s) fired` : ""}`);
			for (const err of r.errors) toast(`${err.exchange}: ${err.error}`, "error");
			await refreshAll();
		} catch (err) {
			toast(err.message, "error");
		} finally {
			btn.disabled = false;
			btn.classList.remove("spinning");
			$("span", btn).textContent = "Sync";
		}
	});

	selectTab("[data-exchange]", (b) => b.dataset.exchange === state.exchange);
	loadStatus().catch(() => undefined);
	refreshAll();

	const deepLink = /^#(NGX|US):([\w.-]+)$/.exec(location.hash);
	if (deepLink) openSecurity(deepLink[1], deepLink[2]);
}

init();

// nVestPadi dashboard. Talks to the REST API in src/server/routes/.
import { renderChart, sparkSvg } from "./chart.js";
import {
	$,
	$$,
	api,
	chg,
	debounce,
	esc,
	fmtCompact,
	fmtDate,
	fmtPrice,
	setupTheme,
	setupUserMenu,
	showVerifyBanner,
	store,
	toast,
	toastError,
} from "./core.js";

const state = {
	exchange: store.get("nvest.exchange", null),
	movers: "gainers",
	market: null,
	status: null,
	account: null,
	watchlist: [],
};

const currency = () => (state.exchange === "NGX" ? "₦" : "$");

// ---------------------------------------------------------------------------
// Market overview
// ---------------------------------------------------------------------------

async function loadMarket() {
	const m = await api(`/api/market?exchange=${state.exchange}&top=8`);
	state.market = m;
	$("#session").textContent = m.date ? `Session ${m.date}` : "";
	$("#session").title = "End-of-day data for the latest trading session";

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
	return state.account?.user.role === "admin"
		? `<div class="empty">No ${state.exchange} data yet. Click <b>Sync</b> to load the latest session.</div>`
		: `<div class="empty">No ${state.exchange} data yet. It appears after the next market sync.</div>`;
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
			toastError(err);
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

// ---------------------------------------------------------------------------
// Watchlist & alerts
// ---------------------------------------------------------------------------

function quotaLabel(used, limit) {
	return limit == null ? (used ? String(used) : "") : `${used} / ${limit}`;
}

async function loadWatchlist() {
	const list = await api("/api/watchlist");
	state.watchlist = list;
	$("#watch-count").textContent = quotaLabel(list.length, state.account?.limits.watchlist);
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
	const active = list.filter((a) => !a.triggeredAt).length;
	$("#alert-count").textContent = quotaLabel(active, state.account?.limits.activeAlerts);
	const labels = state.status?.alertConditions ?? {};
	$("#alerts").innerHTML = list.length
		? list
				.map(
					(a) => `<li>
						<span class="grow"><b>${esc(a.symbol)}</b> <span class="muted" title="${esc(labels[a.condition] ?? "")}">${esc(a.condition)} ${a.threshold}</span>${a.note ? `<br><span class="muted small">${esc(a.note)}</span>` : ""}</span>
						${
							a.triggeredAt
								? `<button class="status fired" type="button" data-rearm-alert="${a.id}" title="Fired ${esc(fmtDate(a.triggeredAt))} at ${a.triggerValue} — click to re-arm">fired ↺</button>`
								: '<span class="status active" title="Checked after every market sync">active</span>'
						}
						<button class="link" type="button" data-delete-alert="${a.id}" aria-label="Delete alert on ${esc(a.symbol)}">✕</button>
					</li>`,
				)
				.join("")
		: '<li class="empty">No alerts yet. Get notified when a price, RSI or volume level hits.</li>';
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

function renderAskQuota() {
	const el = $("#ask-quota");
	const limit = state.account?.limits.aiQuestionsPerDay;
	if (!el) return;
	if (limit == null) {
		el.textContent = "";
		return;
	}
	const left = Math.max(0, limit - state.account.usage.aiQuestionsToday);
	el.textContent = `${left} of ${limit} questions left today`;
	el.classList.toggle("down", left === 0);
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
		out.innerHTML = `<div class="empty">${esc(err.message)}${err.code === "plan_limit" ? ' <a href="/app/settings#plan">See plans</a>' : ""}</div>`;
	} finally {
		button.disabled = false;
		refreshAccount();
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

async function refreshAccount() {
	try {
		state.account = await api("/api/account");
		renderAskQuota();
	} catch {
		/* keep the last known account */
	}
}

async function refreshAll() {
	const results = await Promise.allSettled([loadMarket(), loadWatchlist(), loadAlerts()]);
	await loadScreen().catch(() => undefined);
	const failed = results.find((r) => r.status === "rejected");
	if (failed && failed.reason.status !== 401) toastError(failed.reason);
}

function renderStatus() {
	const s = state.status;
	const pill = $("#ai-pill");
	pill.textContent = s.features.ai ? "AI on" : "AI off";
	pill.classList.toggle("on", Boolean(s.features.ai));
	pill.title = s.features.ai
		? `${s.features.ai.chatModel}${s.features.search ? " + research library" : ""}`
		: "AI answers aren't enabled on this server yet";
	const channels = state.account.notifications.activeChannels;
	$("#channels").innerHTML = channels.length
		? `→ ${esc(channels.join(", "))}`
		: '<a href="/app/settings#notifications">set up delivery</a>';
	$('#alert-form [name="condition"]').innerHTML = Object.entries(s.alertConditions)
		.map(([k, label]) => `<option value="${esc(k)}" title="${esc(label)}">${esc(k)}</option>`)
		.join("");
	$("#sync").hidden = state.account.user.role !== "admin";
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

async function syncNow(btn) {
	btn.disabled = true;
	btn.classList.add("spinning");
	$("span", btn).textContent = "Syncing…";
	try {
		const r = await api("/api/admin/sync", { method: "POST", body: { exchange: "all" } });
		const summary = r.results.map((x) => `${x.exchange} ${x.bars}`).join(" · ");
		toast(`Synced ${summary}${r.triggered ? ` · ${r.triggered} alert(s) fired` : ""}`);
		for (const err of r.errors) toast(`${err.exchange}: ${err.error}`, "error");
		await refreshAll();
	} catch (err) {
		toastError(err);
	} finally {
		btn.disabled = false;
		btn.classList.remove("spinning");
		$("span", btn).textContent = "Sync";
	}
}

function wireEvents() {
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
		debounce(() => loadScreen().catch(toastError), 250),
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
			toast("Alert created — it's checked after every market sync.");
			loadAlerts();
		} catch (err) {
			toastError(err);
		}
	});
	$("#alerts").addEventListener("click", async (e) => {
		const del = e.target.closest("[data-delete-alert]")?.dataset.deleteAlert;
		const rearm = e.target.closest("[data-rearm-alert]")?.dataset.rearmAlert;
		try {
			if (del) await api(`/api/alerts/${del}`, { method: "DELETE" });
			else if (rearm) {
				await api(`/api/alerts/${rearm}/rearm`, { method: "POST" });
				toast("Alert re-armed");
			} else return;
		} catch (err) {
			toastError(err);
		}
		loadAlerts();
	});

	$("#sync").addEventListener("click", (e) => syncNow(e.currentTarget));
}

async function init() {
	setupTheme($("#theme"));
	setupSearch();
	wireEvents();

	try {
		[state.status, state.account] = await Promise.all([api("/api/status"), api("/api/account")]);
	} catch (err) {
		if (err.status !== 401) toastError(err);
		return;
	}
	state.exchange ??= state.account.user.defaultExchange;
	setupUserMenu(state.account, { mode: state.status.mode });
	showVerifyBanner(state.account);
	renderStatus();
	renderAskQuota();
	renderSuggestions();
	selectTab("[data-exchange]", (b) => b.dataset.exchange === state.exchange);
	await refreshAll();

	if (new URLSearchParams(location.search).get("welcome") === "1") {
		toast(`Welcome, ${state.account.user.name.split(" ")[0]}! Open any stock to see its full report.`);
		history.replaceState(null, "", location.pathname + location.hash);
	}
	const deepLink = /^#(NGX|US):([\w.-]+)$/.exec(location.hash);
	if (deepLink) openSecurity(deepLink[1], deepLink[2]);
}

init();

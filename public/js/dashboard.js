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
	signalSide: "BUY",
	signalsAll: false,
	market: null,
	status: null,
	account: null,
	watchlist: [],
};

const currency = () => (state.exchange === "NGX" ? "₦" : "$");
const curOf = (c) => (c === "NGN" ? "₦" : c === "USD" ? "$" : c ? `${c} ` : "");
const isCrypto = () => state.exchange === "CRYPTO";
/** NYSE / Nasdaq badge for US listings (other markets have a single venue). */
const venue = (q) => (q.exchange === "US" && q.venue ? `<span class="venue">${esc(q.venue)}</span>` : "");
/** Chart windows in sessions; crypto trades 7 days a week, so a year is 365 bars. */
const RANGES = { "1M": 21, "3M": 63, "6M": 126, "1Y": 252, "2Y": 520 };

// ---------------------------------------------------------------------------
// Market overview
// ---------------------------------------------------------------------------

async function loadMarket() {
	const m = await api(`/api/market?exchange=${state.exchange}&top=8`);
	state.market = m;
	$("#session").textContent = m.date ? (isCrypto() ? `24h · ${m.date}` : `Session ${m.date}`) : "";
	$("#session").title = isCrypto()
		? "Rolling 24-hour change, refreshed every few minutes"
		: state.exchange === "NGX"
			? "Latest NGX session; refreshed every few minutes during trading hours (delayed)"
			: "Latest US session; refreshed every few minutes during trading hours";

	const total = m.count || 1;
	const [up, flat, down] = $$("#breadth-bar span");
	up.style.flexGrow = m.advancers / total;
	flat.style.flexGrow = m.unchanged / total;
	down.style.flexGrow = m.decliners / total;
	$("#adv").textContent = `▲ ${m.advancers}`;
	$("#unch").textContent = `■ ${m.unchanged}`;
	$("#dec").textContent = `▼ ${m.decliners}`;
	$("#value").textContent = m.count ? `${currency()}${fmtCompact(m.totalValue)}` : "—";
	$("#value-label").textContent = isCrypto() ? "24h volume" : "Value traded";
	$("#volume").textContent = m.count
		? isCrypto()
			? `${m.count} coins tracked`
			: `${fmtCompact(m.totalVolume)} shares`
		: "";

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
	const box = $("#movers");
	if (state.movers === "heatmap") return renderHeatmap(box);
	box.className = "movers";
	const list = state.market?.[state.movers] ?? [];
	box.innerHTML = list.length
		? list
				.map(
					(q) => `<li><button type="button" data-open="${esc(q.exchange)}:${esc(q.symbol)}">
						<b>${esc(q.symbol)}${venue(q)}</b>${chg(q.changePct)}
						<span class="name">${esc(q.name)} · ${currency()}${fmtPrice(q.close)}</span>
					</button></li>`,
				)
				.join("")
		: `<li style="grid-column:1/-1">${emptyMarket()}</li>`;
}

/** Most-traded names as tiles sized by traded value and coloured by the day's move. */
async function renderHeatmap(box) {
	box.className = "heatmap";
	box.innerHTML = '<li class="skeleton" style="grid-column:1/-1;height:160px"></li>';
	const rows = await api(`/api/screen?exchange=${state.exchange}&sort=active&limit=40`).catch(() => []);
	if (state.movers !== "heatmap") return;
	if (!rows.length) {
		box.innerHTML = `<li style="grid-column:1/-1">${emptyMarket()}</li>`;
		return;
	}
	const maxValue = Math.max(...rows.map((r) => r.tradedValue || 0), 1);
	box.innerHTML = rows
		.map((r) => {
			const c = r.changePct ?? 0;
			const strength = Math.min(1, Math.abs(c) / 5);
			const tone = c > 0 ? "up" : c < 0 ? "down" : "flat";
			// Bigger tiles for the most traded names: span 1–3 columns.
			const span = 1 + Math.round(((r.tradedValue || 0) / maxValue) * 2);
			return `<li style="grid-column:span ${span};--s:${(0.15 + strength * 0.85).toFixed(2)}" class="tile ${tone}">
				<button type="button" data-open="${esc(r.exchange)}:${esc(r.symbol)}" title="${esc(r.name)}">
					<b>${esc(r.symbol)}</b><span>${c > 0 ? "+" : ""}${c.toFixed(2)}%</span>
				</button></li>`;
		})
		.join("");
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
	const showCap = rows.some((r) => r.marketCap != null);
	$("#rsi-col").hidden = !showRsi;
	$("#mcap-col").hidden = !showCap;
	$("#screen-count").textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
	$("#screen-body").innerHTML = rows.length
		? rows
				.map(
					(r) => `<tr tabindex="0" data-open="${esc(r.exchange)}:${esc(r.symbol)}">
						<td class="sym"><b>${esc(r.symbol)}${venue(r)}</b><span>${esc(r.name)}</span></td>
						<td class="hide-sm muted">${esc(r.sector ?? "")}</td>
						<td class="num">${fmtPrice(r.close)}</td>
						<td class="num">${chg(r.changePct)}</td>
						<td class="num hide-sm">${fmtCompact(r.tradedValue)}</td>
						${showCap ? `<td class="num hide-sm">${fmtCompact(r.marketCap)}</td>` : ""}
						${showRsi ? `<td class="num">${r.rsi14 ?? "—"}</td>` : ""}
					</tr>`,
				)
				.join("")
		: `<tr><td colspan="7">${state.market?.count ? '<div class="empty">Nothing matches these filters.</div>' : emptyMarket()}</td></tr>`;
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
	stopLive();
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

const signed = (v, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(digits)}%`);

/** "64% · 14 of 22" with a warning tone when there are too few past signals to trust. */
function successBadge(track, minTrades) {
	if (!track || track.trades === 0)
		return '<span class="rate none" title="No completed past signals yet">no record</span>';
	const thin = track.trades < minTrades;
	const beats = track.baseRate != null && track.winRate > track.baseRate;
	const cls = thin ? "thin" : beats ? "good" : "weak";
	const title = `${track.wins} of ${track.trades} past ${track.side} signals ${track.side === "BUY" ? "made money" : "saw the price fall"} after costs${track.baseRate == null ? "" : `; a random ${track.side === "BUY" ? "entry" : "exit"} worked ${track.baseRate}% of the time`}${thin ? ". Too few signals to rely on." : ""}`;
	return `<span class="rate ${cls}" title="${esc(title)}">${track.winRate}% <small>of ${track.trades}</small></span>`;
}

/** "62% chance" coloured by confidence: green = likely beats a random entry, amber = maybe, red = no evidence it does. */
function confidenceBadge(c) {
	if (!c) return "";
	const cls = { high: "good", medium: "thin", low: "weak" }[c.level];
	const title = `Estimated ${c.probability}% chance of a profit after trading costs (90% range ${c.low}–${c.high}%; a random entry: ${c.baseRate ?? "—"}%). ${c.level[0].toUpperCase()}${c.level.slice(1)} confidence, from ${c.basis.own} past signals on this one, ${c.basis.market} across the market and ${c.basis.live} live results.`;
	return `<span class="rate ${cls}" title="${esc(title)}">${c.probability}% <small>${c.level}</small></span>`;
}

function confidenceSentence(c) {
	if (!c) return "";
	const level = {
		high: "the whole range is above a random entry",
		medium: "above a random entry, but the range overlaps it",
		low: "no better than a random entry on the evidence so far",
	}[c.level];
	return `Estimated chance of a profit after costs: ${c.probability}% (likely between ${c.low}% and ${c.high}%; a random entry: ${c.baseRate ?? "—"}%). ${c.level[0].toUpperCase()}${c.level.slice(1)} confidence: ${level}.`;
}

function planText(plan, cur) {
	if (!plan) return '<p class="muted small">Not enough range history to size a stop and target yet.</p>';
	const row = (label, value, note) =>
		`<div><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}</div>`;
	return plan.side === "BUY"
		? `<div class="trade-plan">
				${row("Buy near", `${cur}${fmtPrice(plan.entry)}`, "latest price")}
				${row("Stop loss", `${cur}${fmtPrice(plan.stop)}`, `−${plan.riskPct}%`)}
				${row("Target", `${cur}${fmtPrice(plan.target)}`, `+${plan.rewardPct}%`)}
				${row("Time frame", `~${plan.horizon} sessions`, "then reassess")}
			</div>`
		: `<div class="trade-plan">
				${row("Sell / trim near", `${cur}${fmtPrice(plan.entry)}`, "if you hold it")}
				${row("Wrong above", `${cur}${fmtPrice(plan.stop)}`, `+${plan.riskPct}%`)}
				${row("Downside to", `${cur}${fmtPrice(plan.target)}`, `−${plan.rewardPct}%`)}
				${row("Time frame", `~${plan.horizon} sessions`, "then reassess")}
			</div>`;
}

function trackSentence(t) {
	if (!t || t.trades === 0) return `No completed ${t?.side ?? ""} signals in this history yet.`;
	const verb = t.side === "BUY" ? "made money" : "were followed by a fall";
	return `${t.wins} of ${t.trades} past ${t.side} signals ${verb} after costs (avg ${signed(t.avgReturnPct)}, ${signed(t.grossAvgReturnPct)} before costs, over ~${Math.round(t.avgSessions)} sessions; ${[t.avgWinPct == null ? "" : `wins ${signed(t.avgWinPct)}`, t.avgLossPct == null ? "" : `losses ${signed(t.avgLossPct)}`].filter(Boolean).join(", ")}).${t.baseRate == null ? " Too little history for this one's own random-entry baseline." : ` A random ${t.side === "BUY" ? "entry" : "exit"} worked ${t.baseRate}% of the time.`}`;
}

function signalSection(r, cur, confidence) {
	const rules = r.rules;
	const cost = r.call?.track.costPct ?? r.track.BUY.costPct;
	const how = `<details class="how"><summary>How signals and success rates work</summary>
		<p>A BUY fires when the price closes at a new 50-session high while above its 200-day average (a breakout in an uptrend); a SELL when it closes at a new 50-session low below that average. It's strong when volume is 1.5× its 20-day average. Signals from the last 3 sessions are shown.</p>
		<p>We tested several rule sets on about 10 years of prices. This one beat a random entry on NGX stocks in both older and recent years; on US stocks, crypto and for SELL signals no rule set showed a reliable edge, so judge each one by its own record below.</p>
		<p>The success rate replays every past signal of the same kind on this ${r.security.exchange === "CRYPTO" ? "coin" : "stock"} with the same rules: buy at the next session's open, exit at the stop (${rules.stopAtr}× ATR), the target (${rules.targetAtr}× ATR), an opposite signal, or after ${rules.horizon} sessions. A success means a profit after an estimated ${cost}% round trip in trading costs${r.security.exchange === "NGX" ? " (brokerage, SEC, NGX and CSCS fees, VAT and stamp duty)" : ""}. Fewer than ${rules.minTrades} past signals is too few to rely on.</p>
		<p>The chance of profit blends this ${r.security.exchange === "CRYPTO" ? "coin" : "stock"}'s own record with the rule's record across the market and live results, so one lucky past signal doesn't read as a sure thing. Every signal shown is logged and scored: see the <a href="/track-record?market=${r.security.exchange.toLowerCase()}" target="_blank" rel="noopener">live track record</a>. Past results don't guarantee future ones.</p>
	</details>`;
	if (!r.call) {
		return `<div class="call none">
			<p><b>No buy or sell signal right now.</b> <span class="muted small">Hold / wait for a setup.</span></p>
			<p class="small muted">Track record on this ${r.security.exchange === "CRYPTO" ? "coin" : "stock"}: BUY ${successBadge(r.track.BUY, rules.minTrades)} · SELL ${successBadge(r.track.SELL, rules.minTrades)}</p>
			${how}
		</div>`;
	}
	const c = r.call;
	return `<div class="call ${c.side}">
		<div class="call-head">
			<span class="signal ${c.side}">${c.strength.toUpperCase()} ${c.side}</span>
			<span class="muted small">signal on ${esc(c.date)}</span>
			<span class="grow"></span>
			<span class="muted small">Chance of profit</span> ${confidenceBadge(confidence)}
			<span class="muted small">Past record</span> ${successBadge(c.track, rules.minTrades)}
		</div>
		<p class="small">${esc(c.reason)}</p>
		${planText(c.plan, cur)}
		<p class="small">${esc(confidenceSentence(confidence))}</p>
		<p class="small muted">${esc(trackSentence(c.track))}</p>
		${how}
	</div>`;
}

/** Position sizer: units such that hitting the stop loses the chosen share of capital, after fees. */
function sizerSection(r) {
	const plan = r.call?.side === "BUY" ? r.call.plan : null;
	const level = (v) =>
		v == null ? "" : Number(v.toPrecision(v >= 1 ? Math.max(4, String(Math.trunc(v)).length + 2) : 4));
	const field = (name, label, value, extra = "") =>
		`<label><span>${label}</span><input name="${name}" type="number" step="any" min="0" inputmode="decimal" value="${value ?? ""}" ${extra} /></label>`;
	return `<form id="sizer" class="sizer" novalidate>
		<div class="sizer-fields">
			${field("capital", `Capital (${esc(r.security.currency)})`, store.get("nvest.sizer.capital", ""), 'required placeholder="e.g. 1000000"')}
			${field("riskPct", "Risk per trade %", store.get("nvest.sizer.riskPct", "1"), 'max="100"')}
			${field("stop", "Stop", plan ? level(plan.stop) : "", plan ? "" : 'placeholder="your stop"')}
			${field("target", "Target", plan ? level(plan.target) : "", 'placeholder="optional"')}
		</div>
		<button class="btn" type="submit">Calculate</button>
		<div id="sizer-out" class="sizer-out" aria-live="polite"></div>
		<p class="muted small">${plan ? "Stop and target come from the BUY signal; change them to use your own." : "No BUY signal right now, so enter the price where you'd admit you're wrong."} Sized so being stopped out loses your chosen share of capital, fees included. A price can gap through a stop, so losses can be bigger.</p>
	</form>`;
}

async function runSizer(form, s) {
	const out = $("#sizer-out");
	const v = (name) => form[name].value.trim();
	if (!(Number(v("capital")) > 0)) {
		out.innerHTML = '<p class="small down">Enter your capital first.</p>';
		return;
	}
	store.set("nvest.sizer.capital", v("capital"));
	store.set("nvest.sizer.riskPct", v("riskPct") || "1");
	const params = new URLSearchParams({ symbol: s.symbol, exchange: s.exchange, capital: v("capital") });
	for (const name of ["riskPct", "stop", "target"]) if (v(name)) params.set(name, v(name));
	try {
		const r = await api(`/api/sizing?${params}`);
		const z = r.sizing;
		const cur = r.currency === "NGN" ? "₦" : r.currency === "USD" ? "$" : `${r.currency} `;
		const money = (n) => `${cur}${fmtPrice(n)}`;
		const cell = (label, value, note) =>
			`<div><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}</div>`;
		out.innerHTML = `<div class="trade-plan">
				${cell("Buy", z.units > 0 ? `${z.units.toLocaleString()} units` : "nothing", z.units > 0 ? `${money(z.outlay)} · ${z.positionPct}% of capital` : "")}
				${cell("If stopped", `−${money(z.lossAtStop)}`, `${z.lossAtStopPct}% of capital`)}
				${cell("At target", z.gainAtTarget == null ? "—" : `+${money(z.gainAtTarget)}`, z.rewardRisk == null ? "" : `reward/risk ${z.rewardRisk}`)}
				${cell("Turnover", z.shareOfDailyValue == null ? "—" : z.shareOfDailyValue < 0.1 ? "<0.1%" : `${z.shareOfDailyValue}%`, "of a typical day")}
			</div>
			${z.warnings.map((w) => `<p class="small warn">⚠ ${esc(w)}</p>`).join("")}
			<p class="muted small">Fees: buy ${r.costs.buyPct}%, sell ${r.costs.sellPct}%. Limited by ${esc(z.limitedBy.replace("-", " "))}.</p>`;
	} catch (err) {
		out.innerHTML = `<p class="small down">${esc(err.message)}</p>`;
	}
}

let live = { timer: null, symbol: null };

function stopLive() {
	clearTimeout(live.timer);
	live = { timer: null, symbol: null };
}

function liveLabel(q) {
	const time = q.asOf
		? new Date(q.asOf).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
		: "";
	if (q.freshness === "live")
		return { cls: "live", text: `● Live${time ? ` · ${time}` : ""}`, title: `${q.source} · ${q.session}` };
	if (q.freshness === "delayed") return { cls: "delayed", text: "Delayed", title: `${q.source} · ${q.session}` };
	return { cls: "closed", text: "Market closed", title: `Showing the last close · ${q.session}` };
}

function renderSecurity({ report: r, history, watched, confidence }) {
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
	const ranges = s.exchange === "NGX" ? Object.keys(RANGES) : ["1D", ...Object.keys(RANGES)];
	let mode = store.get("nvest.chartMode", "candles");
	let range = "6M";
	let intraday = [];

	const meta = [s.exchange === "US" ? s.venue : s.exchange, s.symbol, s.sector, s.industry].filter(Boolean);
	$("#drawer-body").innerHTML = `
		<div class="d-head">
			<p class="muted small">${meta.map(esc).join(" · ")}</p>
			<h2 id="drawer-title">${esc(s.name)}</h2>
			${s.marketCap ? `<p class="muted small">Market cap ${cur}${fmtCompact(s.marketCap)}</p>` : ""}
		</div>
		<div class="d-price">
			<span class="big" id="d-last">${cur}${fmtPrice(r.latest.close)}</span><span id="d-chg">${chg(r.latest.changePct)}</span>
			<span class="muted small" id="d-asof">${esc(r.latest.date)}</span>
			<span class="live-pill" id="d-live" hidden></span>
			${r.call ? `<span class="signal ${r.call.side}" title="${esc(r.call.reason)}">${r.call.strength.toUpperCase()} ${r.call.side}</span>` : ""}
		</div>
		<div class="d-actions">
			<button class="btn" type="button" id="d-watch">${watched ? "★ Watching" : "☆ Add to watchlist"}</button>
			<button class="btn" type="button" id="d-alert">🔔 Alert</button>
			<button class="btn" type="button" id="d-hold">+ Portfolio</button>
			<button class="btn" type="button" id="d-ask">Ask AI about ${esc(s.symbol)}</button>
		</div>
		<div class="chart-bar">
			<div class="tabs ranges" role="tablist" aria-label="Chart range">${ranges
				.map((k) => `<button role="tab" type="button" data-range="${k}" aria-selected="${k === range}">${k}</button>`)
				.join("")}</div>
			<div class="tabs" role="tablist" aria-label="Chart type">
				<button role="tab" type="button" data-mode="candles" aria-selected="${mode === "candles"}">Candles</button>
				<button role="tab" type="button" data-mode="line" aria-selected="${mode === "line"}">Line</button>
			</div>
		</div>
		<div class="chart-wrap" id="chart"></div>
		<div class="legend" id="legend"></div>
		<div class="perf">${perf}</div>
		<h3>Signal</h3>
		${signalSection(r, cur, confidence)}
		<h3>How much to buy?</h3>
		${sizerSection(r)}
		${s.exchange === "NGX" ? '<h3>Dividends</h3><div id="d-dividends"><div class="skeleton"></div></div><h3>Filings</h3><div id="d-filings"><div class="skeleton"></div></div>' : ""}
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
		<p class="muted small" style="margin-top:16px">Educational analysis based on ${r.bars} sessions. Signals and success rates describe the past, not the future. Not investment advice.</p>`;

	const draw = () => {
		for (const b of $$("[data-range]")) b.setAttribute("aria-selected", String(b.dataset.range === range));
		for (const b of $$("[data-mode]")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
		let weekly = false;
		if (range === "1D") {
			const bars = intraday.map((c) => ({
				...c,
				date: c.time,
				label: new Date(c.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
				changePct: null,
			}));
			renderChart($("#chart"), bars, { mode, intraday: true });
		} else {
			// Crypto trades daily: scale session counts to calendar days.
			const window = s.exchange === "CRYPTO" ? Math.round((RANGES[range] * 365) / 252) : RANGES[range];
			weekly = renderChart($("#chart"), history, { window, mode, markers: r.trades })?.weekly ?? false;
		}
		const closeOnly = mode === "candles" && range !== "1D" && history.slice(-RANGES[range]).some((b) => b.high == null);
		$("#legend").innerHTML = [
			mode === "candles"
				? `<span><i style="background:var(--up)"></i>${weekly ? "Weekly" : range === "1D" ? "5-min" : "Daily"} candles</span>`
				: `<span><i style="background:var(--${(history.at(-1)?.close ?? 0) >= (history[0]?.close ?? 0) ? "up" : "down"})"></i>Close</span>`,
			range === "1D"
				? ""
				: '<span><i style="background:var(--chart-1)"></i>SMA 20</span><span><i style="background:var(--chart-2)"></i>SMA 50</span>',
			range === "1D"
				? ""
				: '<span class="up">▲</span><span>past BUY</span><span class="down">▼</span><span>past SELL</span>',
			closeOnly
				? '<span class="muted" title="The price source only has closing prices for older sessions: those candles open at the previous close and have no wicks">no wicks = close-only history</span>'
				: "",
		].join("");
	};
	for (const b of $$("[data-range]"))
		b.addEventListener("click", () => {
			range = b.dataset.range;
			draw();
		});
	for (const b of $$("[data-mode]"))
		b.addEventListener("click", () => {
			mode = b.dataset.mode;
			store.set("nvest.chartMode", mode);
			draw();
		});
	draw();

	// Live price: poll while the drawer is open and the market is trading.
	stopLive();
	live.symbol = `${s.exchange}:${s.symbol}`;
	const key = live.symbol;
	const poll = async () => {
		if (live.symbol !== key) return;
		let q = null;
		if (document.visibilityState === "visible") {
			try {
				q = await api(`/api/securities/${s.exchange}/${encodeURIComponent(s.symbol)}/live`);
			} catch {
				/* keep showing the last price */
			}
		}
		if (live.symbol !== key) return;
		if (q) {
			const label = liveLabel(q);
			const pill = $("#d-live");
			pill.hidden = false;
			pill.className = `live-pill ${label.cls}`;
			pill.textContent = label.text;
			pill.title = label.title;
			$("#d-last").textContent = `${cur}${fmtPrice(q.price)}`;
			$("#d-chg").innerHTML = chg(q.changePct);
			if (q.asOf) $("#d-asof").textContent = fmtDate(q.asOf);
			intraday = q.candles ?? [];
			// Fold the live price into today's daily candle.
			const day = q.asOf?.slice(0, 10);
			const last = history.at(-1);
			if (q.freshness === "live" && day && last) {
				if (day === last.date) {
					last.close = q.price;
					if (q.dayHigh != null) last.high = Math.max(last.high ?? q.dayHigh, q.dayHigh);
					if (q.dayLow != null) last.low = Math.min(last.low ?? q.dayLow, q.dayLow);
					last.changePct = q.changePct;
				} else if (day > last.date) {
					history.push({
						...last,
						date: day,
						open: intraday[0]?.open ?? last.close,
						high: q.dayHigh ?? q.price,
						low: q.dayLow ?? q.price,
						close: q.price,
						volume: q.volume,
						changePct: q.changePct,
					});
				}
			}
			draw();
		}
		const open = q ? q.marketOpen : true;
		live.timer = setTimeout(poll, open ? 30_000 : 5 * 60_000);
	};
	poll();

	loadSecurityExtras(s).catch(() => undefined);
	const sizer = $("#sizer");
	sizer.addEventListener("submit", (e) => {
		e.preventDefault();
		runSizer(sizer, s);
	});
	if (sizer.capital.value) runSizer(sizer, s);

	$("#d-hold").addEventListener("click", () => {
		closeDrawer();
		const form = $("#portfolio-form");
		form.symbol.value = s.symbol;
		form.dataset.exchange = s.exchange;
		form.avgCost.value = r.latest.close;
		form.quantity.focus();
		form.scrollIntoView({ behavior: "smooth", block: "center" });
	});

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
		form.condition.value = "signal-buy";
		form.condition.dispatchEvent(new Event("change"));
		form.threshold.focus();
		form.scrollIntoView({ behavior: "smooth", block: "center" });
	});
	$("#d-ask").addEventListener("click", () => {
		closeDrawer();
		ask(`Give me a quick read on ${s.name} (${s.symbol}): trend, momentum, the current signal and key levels.`);
	});
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

async function loadSignals() {
	const box = $("#signals");
	const side = state.signalSide;
	const { ideas, rules, market } = await api(`/api/signals?exchange=${state.exchange}&side=${side}&limit=50`);
	const cur = currency();
	// Evidence-backed ideas lead; the rest (too few past signals, or no better than chance) sit behind a toggle.
	const backed = ideas.filter((i) => i.evidence === "backed");
	const others = ideas.filter((i) => i.evidence !== "backed");
	const shown = state.signalsAll ? [...backed, ...others] : backed;
	const row = (i) => {
		const p = i.call.plan;
		const levels = p
			? side === "BUY"
				? `stop ${cur}${fmtPrice(p.stop)} · target ${cur}${fmtPrice(p.target)}`
				: `wrong above ${cur}${fmtPrice(p.stop)} · down to ${cur}${fmtPrice(p.target)}`
			: "";
		return `<li><button type="button" data-open="${esc(i.exchange)}:${esc(i.symbol)}" title="${esc(i.call.reason)}">
			<span class="sym"><span><b>${esc(i.symbol)}</b><span class="signal ${side} small">${i.call.strength}</span></span><span class="name">${esc(i.name)}</span></span>
			<span class="lv"><span>${cur}${fmtPrice(i.close)} ${chg(i.changePct)}</span><span class="muted small">${levels}</span></span>
			${confidenceBadge(i.confidence)}
		</button></li>`;
	};
	const word = side === "BUY" ? "buy" : "sell";
	let html = shown
		.slice(0, state.signalsAll ? 50 : 12)
		.map(row)
		.join("");
	if (!html) {
		html = !state.market?.count
			? `<li>${emptyMarket()}</li>`
			: ideas.length
				? `<li class="empty">No fresh ${word} signal here has a track record that beats chance right now.</li>`
				: `<li class="empty">No fresh ${word} signals in this market right now.</li>`;
	}
	if (others.length) {
		html += `<li><button type="button" class="link more" id="signals-more">${state.signalsAll ? "Hide" : "Show"} ${others.length} more ${word} signal${others.length === 1 ? "" : "s"} with a thin or poor track record</button></li>`;
	}
	box.innerHTML = html;
	$("#signals-more")?.addEventListener("click", () => {
		state.signalsAll = !state.signalsAll;
		loadSignals().catch(toastError);
	});
	const note = ideas.length
		? `Badge = estimated chance the signal ${side === "BUY" ? "makes money" : "is followed by a fall"} within ${rules.horizon} sessions after ~${rules.costPct}% trading costs, and how confident that estimate is. Based on past results, not a forecast. <a href="/track-record?market=${state.exchange.toLowerCase()}" target="_blank" rel="noopener">Live track record</a>.`
		: "";
	$("#signals-note").innerHTML = [marketRecord(market[side]), note].filter(Boolean).join(" ");
}

/** One honest line on how these rules have done across the whole market vs a random entry. */
function marketRecord(m) {
	if (!m || !m.trades) return "";
	const what = m.side === "BUY" ? "made money" : "were followed by a fall";
	const random = `a random ${m.side === "BUY" ? "entry" : "exit"} (${m.baseRate}%)`;
	const verdict = {
		better: `<b class="up">better than ${random}</b>, by more than luck would explain.`,
		worse: `<b class="down">worse than ${random}</b>, so treat these as ideas to research, not recommendations.`,
		unclear: `<b class="down">not clearly better than ${random}</b>, so treat these as ideas to research, not recommendations.`,
	}[m.verdict];
	return `Across ${m.symbols} ${isCrypto() ? "coins" : "stocks"} here, ${m.trades} past ${m.side} signals ${what} after costs ${m.winRate}% of the time (${m.grossWinRate}% before costs): ${verdict}`;
}

// ---------------------------------------------------------------------------
// Dividends & filings (NGX)
// ---------------------------------------------------------------------------

/** A calendar date (YYYY-MM-DD…) as "27 Nov 2026", the same day in every time zone. */
const fmtDay = (iso) =>
	iso
		? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				timeZone: "UTC",
			})
		: "—";

const DIVIDEND_STATUS = { open: "buy by", qualified: "qualified", paid: "paid", unknown: "dates TBA" };
const dividendAmount = (d) => `${d.currency === "NGN" ? "₦" : "$"}${fmtPrice(d.amount)}`;

async function loadDividends() {
	const card = $("#dividends-card");
	card.hidden = state.exchange !== "NGX";
	if (card.hidden) return;
	const { events } = await api("/api/dividends?exchange=NGX");
	// Still possible to qualify first (soonest deadline first), then announced or awaiting payment.
	const order = { open: 0, unknown: 1, qualified: 2, paid: 3 };
	const list = events.filter((e) => e.status !== "paid").sort((a, b) => order[a.status] - order[b.status]);
	$("#dividends-count").textContent = list.length ? `${list.length} upcoming` : "";
	$("#dividends").innerHTML = list.length
		? list
				.slice(0, 12)
				.map(
					(
						d,
					) => `<li><button type="button" data-open="NGX:${esc(d.symbol)}" title="${esc(`${d.kind} dividend of ${dividendAmount(d)} per share`)}">
				<span class="sym"><span><b>${esc(d.symbol)}</b> <span class="muted small">${esc(d.kind)}</span></span><span class="name">${esc(d.name)}</span></span>
				<span class="lv"><span>${dividendAmount(d)}${d.payoutYieldPct == null ? "" : ` <span class="muted small">${d.payoutYieldPct}%</span>`}</span><span class="muted small">${d.qualificationDate ? `qualify ${fmtDay(d.qualificationDate)} · paid ${d.paymentDate ? fmtDay(d.paymentDate) : "TBA"}` : "dates not announced"}</span></span>
				<span class="rate ${d.status === "open" ? "good" : "none"}">${d.status === "open" ? `buy by ${fmtDay(d.buyBy)}` : DIVIDEND_STATUS[d.status]}</span>
			</button></li>`,
				)
				.join("")
		: '<li class="empty">No upcoming dividends on record right now.</li>';
}

async function loadSecurityExtras(s) {
	if (s.exchange !== "NGX") return;
	const [div, filings] = await Promise.allSettled([
		api(`/api/securities/NGX/${encodeURIComponent(s.symbol)}/dividends`),
		api(`/api/securities/NGX/${encodeURIComponent(s.symbol)}/filings?limit=10`),
	]);
	const dBox = $("#d-dividends");
	if (dBox && div.status === "fulfilled") {
		const d = div.value;
		dBox.innerHTML = d.history.length
			? `<div class="trade-plan">
					<div><span>Past 12 months</span><b>${d.trailingCount ? `₦${fmtPrice(d.trailingAmount)}` : "—"}</b><small>${d.trailingCount} payout${d.trailingCount === 1 ? "" : "s"}</small></div>
					<div><span>Trailing yield</span><b>${d.trailingYieldPct == null ? "—" : `${d.trailingYieldPct}%`}</b><small>at the latest price</small></div>
					<div><span>Next</span><b>${d.next ? dividendAmount(d.next) : "—"}</b><small>${d.next ? (d.next.status === "open" ? `buy by ${fmtDay(d.next.buyBy)}` : DIVIDEND_STATUS[d.next.status]) : "none announced"}</small></div>
					<div><span>Paid</span><b>${d.next?.paymentDate ? fmtDay(d.next.paymentDate) : "—"}</b><small>${d.next?.qualificationDate ? `qualify ${fmtDay(d.next.qualificationDate)}` : ""}</small></div>
				</div>
				<ul class="div-history">${d.history
					.slice(0, 6)
					.map(
						(e) =>
							`<li><span>${e.qualificationDate ? fmtDay(e.qualificationDate) : fmtDay(e.announcedAt.slice(0, 10))}</span><span>${esc(e.kind)}</span><b>${dividendAmount(e)}</b>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" class="muted small">notice</a>` : ""}</li>`,
					)
					.join("")}</ul>`
			: '<p class="muted small">No dividends on record in the past year of NGX notices.</p>';
	}
	const fBox = $("#d-filings");
	if (fBox && filings.status === "fulfilled") {
		fBox.innerHTML = filings.value.length
			? `<ul class="filings">${filings.value
					.map(
						(f) => `<li data-id="${f.id}">
					<div><span class="muted small">${fmtDay(f.publishedAt.slice(0, 10))} · ${esc(f.category || f.kind)}</span>
					<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a></div>
					<p class="small summary">${f.summary ? esc(f.summary) : ""}</p>
					${f.summary || !state.status?.features?.ai ? "" : '<button type="button" class="link small summarize">What changed? (AI)</button>'}
				</li>`,
					)
					.join("")}</ul>`
			: '<p class="muted small">No filings on record yet.</p>';
		for (const b of $$(".summarize", fBox)) {
			b.addEventListener("click", async () => {
				const li = b.closest("li");
				b.disabled = true;
				b.textContent = "Reading the filing…";
				try {
					const f = await api(`/api/filings/${li.dataset.id}/summary`, { method: "POST" });
					$(".summary", li).textContent = f.summary;
					b.remove();
				} catch (err) {
					b.disabled = false;
					b.textContent = "What changed? (AI)";
					toastError(err);
				}
			});
		}
	}
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
						<button class="link unwatch" type="button" data-unwatch="${esc(w.exchange)}:${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)} from watchlist">✕</button>
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
// Portfolio
// ---------------------------------------------------------------------------

/** SELL on a holding = consider selling or trimming; BUY = the signal supports adding. */
function holdingSignal(p) {
	const g = p.signal;
	if (!g) return "";
	const rate = g.trades ? ` Past ${g.side} signals on it worked ${g.winRate}% of the time (${g.trades}).` : "";
	const what = g.side === "SELL" ? "Consider selling or trimming" : "Signal supports adding";
	const stop = g.side === "BUY" && g.stop != null ? ` Stop ${fmtPrice(g.stop)}.` : "";
	return ` <span class="signal ${g.side} small" title="${esc(`${what} (${g.strength}, ${g.date}): ${g.reason}.${stop}${rate}`)}">${g.side}</span>`;
}

async function loadPortfolio() {
	const { positions, totals } = await api("/api/portfolio");
	$("#holding-count").textContent = quotaLabel(positions.length, state.account?.limits.holdings);
	$("#portfolio-totals").innerHTML = totals
		.map(
			(t) => `<div class="pf-total">
				<span class="muted small">${esc(t.currency)} portfolio</span>
				<b>${curOf(t.currency)}${fmtPrice(t.value)}</b>
				<span class="small">Today <span class="${t.dayPnl >= 0 ? "up" : "down"}">${t.dayPnl >= 0 ? "+" : "−"}${curOf(t.currency)}${fmtPrice(Math.abs(t.dayPnl))}</span>
				· Total ${chg(t.pnlPct)}</span>
			</div>`,
		)
		.join("");
	$("#portfolio").innerHTML = positions.length
		? positions
				.map(
					(p) => `<li data-open="${esc(p.exchange)}:${esc(p.symbol)}" tabindex="0">
						<div class="meta"><b>${esc(p.symbol)}${holdingSignal(p)}</b><span>${p.quantity} × ${curOf(p.currency)}${fmtPrice(p.avgCost)}</span></div>
						<div class="right"><div>${curOf(p.currency)}${fmtPrice(p.value ?? p.cost)}</div>${chg(p.pnlPct)}</div>
						<button class="link" type="button" data-remove-holding="${p.id}" aria-label="Remove ${esc(p.symbol)} from portfolio">✕</button>
					</li>`,
				)
				.join("")
		: '<li class="empty">Track what you own: add a position below to see live value and P&amp;L.</li>';
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

const SUGGESTIONS = {
	NGX: ["Which stocks have buy signals?", "How did banks do today?", "Which sectors are leading?"],
	US: ["Which stocks have buy signals?", "How is big tech trading?", "Which stocks are oversold?"],
	CRYPTO: ["Which coins have buy signals?", "How is Bitcoin trending?", "Is Ethereum overbought?"],
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
	const results = await Promise.allSettled([loadMarket(), loadWatchlist(), loadAlerts(), loadPortfolio()]);
	await Promise.allSettled([loadScreen(), loadSignals(), loadDividends()]);
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

	// Inline remove buttons sit inside clickable rows, so handle them first.
	document.addEventListener(
		"click",
		async (e) => {
			const unwatch = e.target.closest("[data-unwatch]")?.dataset.unwatch;
			const holding = e.target.closest("[data-remove-holding]")?.dataset.removeHolding;
			if (!unwatch && !holding) return;
			e.stopPropagation();
			try {
				if (unwatch) {
					const [ex, sym] = unwatch.split(":");
					await api(`/api/watchlist/${ex}/${encodeURIComponent(sym)}`, { method: "DELETE" });
					loadWatchlist();
				} else if (confirm("Remove this position from your portfolio?")) {
					await api(`/api/portfolio/${holding}`, { method: "DELETE" });
					loadPortfolio();
				}
			} catch (err) {
				toastError(err);
			}
		},
		true,
	);

	$("#portfolio-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const f = e.target;
		try {
			await api("/api/portfolio", {
				method: "POST",
				body: {
					symbol: f.symbol.value.trim(),
					exchange: f.dataset.exchange || undefined,
					quantity: Number(f.quantity.value),
					avgCost: Number(f.avgCost.value),
				},
			});
			f.reset();
			delete f.dataset.exchange;
			toast("Position saved");
			loadPortfolio();
		} catch (err) {
			toastError(err);
		}
	});

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
			toast("Alert created — it's checked after every market sync (every few minutes while the market is open).");
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

	for (const b of $$("[data-side]")) {
		b.addEventListener("click", () => {
			state.signalSide = b.dataset.side;
			selectTab("[data-side]", (x) => x === b);
			loadSignals().catch(toastError);
		});
	}

	// Signal alerts take a minimum past success rate instead of a price.
	const alertForm = $("#alert-form");
	alertForm.condition.addEventListener("change", () => {
		const signal = alertForm.condition.value.startsWith("signal-");
		alertForm.threshold.placeholder = signal ? "Min success % (0 = any)" : "Value";
		alertForm.threshold.min = signal ? "0" : "";
		alertForm.threshold.max = signal ? "100" : "";
		if (signal && alertForm.threshold.value === "") alertForm.threshold.value = "0";
	});

	// Keep prices current while the tab is visible (the server re-syncs every few minutes in trading hours).
	setInterval(() => {
		if (document.visibilityState !== "visible" || !state.account) return;
		Promise.allSettled([loadMarket(), loadWatchlist(), loadPortfolio(), loadSignals()]);
	}, 120_000);
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
	const deepLink = /^#(NGX|US|CRYPTO):([\w.-]+)$/.exec(location.hash);
	if (deepLink) openSecurity(deepLink[1], deepLink[2]);
}

init();

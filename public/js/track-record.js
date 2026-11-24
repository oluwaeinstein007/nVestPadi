// Public live track record: how every logged signal has played out, per market.
import { $, $$, api, esc, setupTheme } from "./core.js";

setupTheme($("#theme"));

const VERDICT = {
	better: "better than a random entry",
	worse: "worse than a random entry",
	unclear: "not yet distinguishable from a random entry",
};
const EXIT = { target: "hit target", stop: "stopped out", time: "time limit", signal: "opposite signal" };
const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`);
const tone = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const price = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 6 : 2 }));

let data = null;
let exchange = new URLSearchParams(location.search).get("market")?.toUpperCase() || "NGX";

function sideCard(t, side) {
	const word = side === "BUY" ? "made money" : "were followed by a fall";
	if (!t?.signals)
		return `<article class="record-card"><h3>${side} signals</h3><p class="muted">None logged yet.</p></article>`;
	const body = t.trades
		? `<p class="big ${tone(t.winRate - (t.baseRate ?? 50))}">${t.winRate}%</p>
			<p>${t.wins} of ${t.trades} finished signals ${word} after costs, averaging ${signed(t.avgNetReturnPct)}
			(${t.grossWinRate}% and ${signed(t.avgReturnPct)} before costs).</p>
			<p class="muted small">A random ${side === "BUY" ? "entry" : "exit"} on the same days: ${t.baseRate ?? "—"}% · ${VERDICT[t.verdict]}${t.trades < 30 ? " (too few results to judge yet)" : ""}.</p>`
		: `<p class="big muted">—</p><p>None finished yet.</p>`;
	return `<article class="record-card"><h3>${side} signals</h3>${body}
		<p class="muted small">${t.signals} logged · ${t.open} open · ${t.signals - t.open - t.trades} waiting for entry</p></article>`;
}

function render() {
	for (const b of $$(".record-tabs button")) b.setAttribute("aria-selected", String(b.dataset.exchange === exchange));
	const mine = data.exchanges.find((e) => e.exchange === exchange);
	$("#since").textContent = data.since
		? `Tracking since ${data.since.slice(0, 10)} · rules: ${data.rule}`
		: "Tracking starts with the next market sync.";
	$("#stats").innerHTML = sideCard(mine?.BUY, "BUY") + sideCard(mine?.SELL, "SELL");

	const c = data.calibration;
	const rows = c.buckets
		.map(
			(b) =>
				`<tr><td>${esc(b.label)}</td><td>${b.trades}</td><td>${b.predicted == null ? "—" : `${b.predicted}%`}</td><td>${b.actual == null ? "—" : `${b.actual}%`}</td></tr>`,
		)
		.join("");
	$("#calibration").innerHTML =
		`<thead><tr><th>Stated chance</th><th>Finished</th><th>Average stated</th><th>Actually succeeded</th></tr></thead><tbody>${rows}</tbody>`;
	$("#brier").textContent =
		c.brier == null
			? "All markets combined. No finished signals to check yet."
			: `All markets combined. Brier score ${c.brier} (lower is better) vs ${c.baselineBrier ?? "—"} for always quoting the random-entry rate.`;

	const list = data.recent.filter((s) => s.exchange === exchange);
	$("#signals").innerHTML = list.length
		? `<thead><tr><th>Signal</th><th>Fired</th><th>Stated chance</th><th>Entry</th><th>Exit</th><th>After costs</th><th>Status</th></tr></thead><tbody>${list
				.map((s) => {
					const status =
						s.status === "closed"
							? (EXIT[s.exitReason] ?? s.exitReason)
							: s.status === "open"
								? `open · ${s.sessions} of ${s.horizon} sessions`
								: "enters next session";
					return `<tr>
						<td><span class="pill ${s.side}">${s.side}</span> <b>${esc(s.symbol)}</b></td>
						<td>${esc(s.signalDate)}</td>
						<td>${s.probability == null ? "—" : `${s.probability}% <span class="muted">(${esc(s.confidence ?? "")})</span>`}</td>
						<td>${s.entryDate ? `${price(s.entryPrice)} <span class="muted">${esc(s.entryDate)}</span>` : "—"}</td>
						<td>${s.exitDate ? `${price(s.exitPrice)} <span class="muted">${esc(s.exitDate)}</span>` : "—"}</td>
						<td class="${tone(s.netReturnPct)}">${signed(s.netReturnPct)}${s.status === "open" ? ' <span class="muted">so far</span>' : ""}</td>
						<td>${esc(status)}</td></tr>`;
				})
				.join("")}</tbody>`
		: `<tbody><tr><td class="muted">No ${exchange} signals logged yet.</td></tr></tbody>`;

	const cost = data.costs[exchange];
	const r = data.rules;
	$("#how").innerHTML = [
		"A BUY fires when the price closes at a new 50-session high above its 200-day average, and a SELL at a new 50-session low below it.",
		"A signal is logged the first time the app shows it. The trade is scored from the open of the next session, so a signal spotted late, or mid-session before the close confirmed it, counts from when you could actually have acted.",
		`It exits at the stop or target shown with the signal, on an opposite signal, or after ${r.horizon} sessions, whichever comes first.`,
		`Results are after an estimated ${cost.roundTripPct}% round trip in trading costs (buy ${cost.buyPct}%, sell ${cost.sellPct}%). ${exchange === "NGX" ? "That covers 1% brokerage, SEC, NGX and CSCS fees, VAT and stamp duty." : "Naira–dollar exchange costs are not included."}`,
		"A SELL counts as a success when the price falls by more than the costs of selling and buying back.",
		"Finished signals are never edited. Stops and targets of signals still in play are shown in the app.",
	]
		.map((t) => `<li>${esc(t)}</li>`)
		.join("");
}

for (const b of $$(".record-tabs button")) {
	b.addEventListener("click", () => {
		exchange = b.dataset.exchange;
		history.replaceState(null, "", `?market=${exchange.toLowerCase()}`);
		if (data) render();
	});
}

api("/api/public/track-record")
	.then((d) => {
		data = d;
		render();
	})
	.catch(() => {
		$("#stats").innerHTML = '<p class="muted">The track record couldn\'t be loaded. Try again shortly.</p>';
	});

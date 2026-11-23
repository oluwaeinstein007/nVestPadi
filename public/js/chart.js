// Inline-SVG charts: sparklines and the price chart with SMA overlays and a hover crosshair.
import { $, chg, esc, fmtPrice } from "./core.js";

export function sparkSvg(values, cls = "spark") {
	if (!values || values.length < 2) return `<svg class="${cls}" viewBox="0 0 64 24"></svg>`;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pts = values
		.map((v, i) => `${(i / (values.length - 1)) * 64},${22 - ((v - min) / (max - min || 1)) * 20}`)
		.join(" ");
	const colour = values.at(-1) >= values[0] ? "var(--up)" : "var(--down)";
	return `<svg class="${cls}" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" stroke="${colour}" stroke-width="1.6" fill="none"/></svg>`;
}

function smaSeries(values, period) {
	return values.map((_, i) =>
		i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period,
	);
}

export function renderChart(container, bars) {
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

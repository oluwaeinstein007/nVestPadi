// Inline-SVG charts: sparklines and the price chart (candlesticks or line) with SMA overlays,
// volume bars, past BUY/SELL signal markers and a hover crosshair.
import { $, chg, esc, fmtCompact, fmtPrice } from "./core.js";

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

/**
 * Every bar as a full candle. Sources without an intraday range (older NGX and
 * crypto history) only have closes: those open at the previous close and have no
 * wicks, and are flagged so the tooltip can say so.
 */
function withOhlc(bars) {
	return bars.map((b, i) => {
		const prev = bars[i - 1]?.close ?? b.close;
		const open = b.open ?? prev;
		const ranged = b.high != null && b.low != null;
		return {
			...b,
			open,
			high: Math.max(b.high ?? b.close, open, b.close),
			low: Math.min(b.low ?? b.close, open, b.close),
			ranged,
		};
	});
}

/** Monday of the bar's week (UTC), as YYYY-MM-DD. */
function weekOf(date) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
}

function toWeekly(bars) {
	const weeks = [];
	for (const b of bars) {
		const key = weekOf(b.date);
		const w = weeks.at(-1);
		if (w && w.week === key) {
			w.high = Math.max(w.high, b.high);
			w.low = Math.min(w.low, b.low);
			w.close = b.close;
			w.volume = (w.volume ?? 0) + (b.volume ?? 0);
			w.ranged &&= b.ranged;
			w.lastDate = b.date;
			w.sma20 = b.sma20;
			w.sma50 = b.sma50;
		} else {
			weeks.push({ ...b, week: key, firstDate: b.date, lastDate: b.date });
		}
	}
	for (const [i, w] of weeks.entries()) {
		const prev = weeks[i - 1]?.close;
		w.changePct = prev ? ((w.close - prev) / prev) * 100 : null;
	}
	return weeks;
}

/**
 * @param container element to draw into
 * @param allBars full daily history, oldest first (SMAs are computed over all of it)
 * @param opts.window how many of the most recent bars to show
 * @param opts.mode "candles" | "line"
 * @param opts.markers past signal trades: { side, entryDate, exitDate, returnPct, exitReason }
 * @param opts.intraday bars are intraday candles (label = time); no SMAs or markers
 */
export function renderChart(container, allBars, opts = {}) {
	const mode = opts.mode ?? "candles";
	const intraday = Boolean(opts.intraday);
	if (allBars.length < 2) {
		container.innerHTML = `<div class="empty">${intraday ? "No trades yet in this session." : "Not enough history to chart yet."}</div>`;
		return;
	}
	const closesAll = allBars.map((b) => b.close);
	const sma20All = intraday ? [] : smaSeries(closesAll, 20);
	const sma50All = intraday ? [] : smaSeries(closesAll, 50);
	const start = Math.max(0, allBars.length - (opts.window ?? allBars.length));
	let bars = withOhlc(allBars)
		.map((b, i) => ({ ...b, sma20: sma20All[i] ?? null, sma50: sma50All[i] ?? null }))
		.slice(start);
	// Hundreds of daily candles turn into hairlines; show weeks instead.
	const weekly = mode === "candles" && !intraday && bars.length > 200;
	if (weekly) bars = toWeekly(bars);

	const W = 600;
	const H = 260;
	const pad = { l: 8, r: 52, t: 12, b: 22 };
	const volumes = bars.map((b) => b.volume ?? 0);
	const maxVol = Math.max(...volumes);
	// Volume gets its own band under the price, but only when most bars have it
	// (backfilled history can be close-only, which would leave a few lonely bars).
	const withVolume = volumes.filter((v) => v > 0).length;
	const volH = maxVol > 0 && withVolume >= bars.length * 0.6 ? 44 : 0;
	const priceBottom = H - pad.b - volH - (volH ? 6 : 0);
	const closes = bars.map((b) => b.close);
	const sma20 = bars.map((b) => b.sma20);
	const sma50 = bars.map((b) => b.sma50);
	const priceValues = mode === "candles" ? bars.flatMap((b) => [b.high, b.low]) : closes;
	const all = [...priceValues, ...sma20.filter((v) => v != null), ...sma50.filter((v) => v != null)];
	const min = Math.min(...all);
	const max = Math.max(...all);
	const span = max - min || 1;
	// Make room for the widest price label (e.g. "87,363.76" for Bitcoin).
	pad.r = Math.max(52, Math.max(fmtPrice(max).length, fmtPrice(min).length) * 6.6 + 10);
	const slot = (W - pad.l - pad.r) / bars.length;
	// Candles need half a slot of room at each edge; the line runs edge to edge.
	const x =
		mode === "candles" ? (i) => pad.l + slot * (i + 0.5) : (i) => pad.l + (i / (bars.length - 1)) * (W - pad.l - pad.r);
	const y = (v) => pad.t + (1 - (v - min) / span) * (priceBottom - pad.t);
	const barW = Math.max(1, slot * 0.7);

	const volumeBars = volH
		? bars
				.map((b, i) => {
					const h = ((b.volume ?? 0) / maxVol) * volH;
					const cls = b.close < b.open ? "down" : "up";
					return h > 0
						? `<rect class="vol ${cls}" x="${(x(i) - barW / 2).toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"/>`
						: "";
				})
				.join("")
		: "";

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

	const up = closes.at(-1) >= (mode === "candles" ? bars[0].open : closes[0]);
	const colour = up ? "var(--up)" : "var(--down)";
	let price;
	if (mode === "candles") {
		price = bars
			.map((b, i) => {
				const cls = b.close >= b.open ? "up" : "down";
				const top = y(Math.max(b.open, b.close));
				const h = Math.max(1, Math.abs(y(b.open) - y(b.close)));
				const cx = x(i).toFixed(1);
				return `<g class="candle ${cls}${b.ranged ? "" : " approx"}"><line x1="${cx}" x2="${cx}" y1="${y(b.high).toFixed(1)}" y2="${y(b.low).toFixed(1)}"/><rect x="${(x(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"/></g>`;
			})
			.join("");
	} else {
		price = `<defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0.18"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>
			<path d="${path(closes)}L${x(bars.length - 1)},${priceBottom}L${x(0)},${priceBottom}Z" fill="url(#fill)" stroke="none"/>
			<path class="price" d="${path(closes)}" stroke="${colour}"/>`;
	}

	// Past signals: ▲ under the bar where a BUY was entered, ▼ over a SELL.
	const keyOf = (date) => (weekly ? weekOf(date) : date);
	const indexByKey = new Map(bars.map((b, i) => [weekly ? b.week : b.date, i]));
	const markerAt = new Map();
	for (const m of intraday ? [] : (opts.markers ?? [])) {
		const i = indexByKey.get(keyOf(m.entryDate));
		if (i !== undefined) markerAt.set(i, m);
	}
	const markers = [...markerAt]
		.map(([i, m]) => {
			const b = bars[i];
			const cx = x(i);
			return m.side === "BUY"
				? `<path class="mark buy" d="M${cx.toFixed(1)},${(y(b.low) + 4).toFixed(1)}l4,7h-8z"/>`
				: `<path class="mark sell" d="M${cx.toFixed(1)},${(y(b.high) - 4).toFixed(1)}l4,-7h-8z"/>`;
		})
		.join("");

	const ticks = [0, 0.5, 1].map((f) => min + span * f);
	const label = (b) => (intraday ? b.label : weekly ? b.firstDate : b.date);
	const dateIdx = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];

	container.innerHTML = `
		<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${mode === "candles" ? "Candlestick" : "Line"} price chart${weekly ? ", weekly candles" : ""}">
			${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${W - pad.r + 6}" y="${y(t) + 4}">${fmtPrice(t)}</text>`).join("")}
			${dateIdx.map((i, n) => `<text class="axis" x="${x(i)}" y="${H - 4}" text-anchor="${["start", "middle", "end"][n]}">${esc(label(bars[i]))}</text>`).join("")}
			${volumeBars}
			<path class="sma50" d="${path(sma50)}"/>
			<path class="sma20" d="${path(sma20)}"/>
			${price}
			${markers}
			<line class="cross" id="cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
		</svg>
		<div class="chart-tip" id="tip" hidden></div>`;

	const svg = $("svg", container);
	const tip = $("#tip", container);
	const cross = $("#cross", container);
	const move = (clientX) => {
		const rect = svg.getBoundingClientRect();
		const px = ((clientX - rect.left) / rect.width) * W;
		const i = Math.max(
			0,
			Math.min(
				bars.length - 1,
				mode === "candles"
					? Math.floor((px - pad.l) / slot)
					: Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (bars.length - 1)),
			),
		);
		const b = bars[i];
		cross.setAttribute("x1", x(i));
		cross.setAttribute("x2", x(i));
		cross.setAttribute("visibility", "visible");
		const when = intraday ? b.label : weekly ? `Week of ${b.firstDate}` : b.date;
		const ohlc =
			mode === "candles" && b.ranged
				? `<span class="muted">O ${fmtPrice(b.open)} H ${fmtPrice(b.high)} L ${fmtPrice(b.low)}</span> `
				: "";
		const m = markerAt.get(i);
		const signal = m
			? `<br><span class="${m.side === "BUY" ? "up" : "down"}">${m.side} signal</span> <span class="muted">→ ${m.exitReason === "open" ? "still open" : `${m.returnPct > 0 ? "worked" : "failed"} (${m.returnPct > 0 ? "+" : ""}${m.returnPct}%, ${m.exitReason})`}</span>`
			: "";
		tip.hidden = false;
		tip.innerHTML = `${ohlc}<b>${fmtPrice(b.close)}</b> ${b.changePct == null ? "" : chg(b.changePct)} <span class="muted">${esc(when)}${b.volume ? ` · vol ${fmtCompact(b.volume)}` : ""}${mode === "candles" && !b.ranged && !intraday ? " · close only" : ""}</span>${signal}`;
		const left = (x(i) / W) * rect.width;
		tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), rect.width - tip.offsetWidth)}px`;
	};
	svg.addEventListener("pointermove", (e) => move(e.clientX));
	svg.addEventListener("pointerleave", () => {
		tip.hidden = true;
		cross.setAttribute("visibility", "hidden");
	});
	return { weekly };
}

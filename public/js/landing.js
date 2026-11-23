// Landing page: theme, screenshot theming, signed-in nav, live market teaser, copy buttons.
import { $, $$, api, esc, isDark, setupTheme, toast } from "./core.js";

/** <picture> media queries follow the OS; when the user picks a theme explicitly, pin images to it. */
function syncScreenshots() {
	if (!document.documentElement.dataset.theme) return;
	for (const img of $$("img[data-light]")) {
		for (const source of img.parentElement.querySelectorAll("source")) source.remove();
		img.src = isDark() ? img.dataset.dark : img.dataset.light;
	}
}

setupTheme($("#theme"), syncScreenshots);
syncScreenshots();

// Signed-in visitors get "Open dashboard" instead of the sign-up calls to action.
api("/api/auth/session")
	.then((s) => {
		if (!s.user) return;
		for (const el of $$("[data-guest]")) el.hidden = true;
		for (const el of $$("[data-member]")) el.hidden = false;
	})
	.catch(() => undefined);

// Live teaser from the latest NGX session — hidden if there's no data yet.
api("/api/public/snapshot?exchange=NGX")
	.then((s) => {
		if (!s.count) return;
		$("#pulse-date").textContent = `· session ${s.date}`;
		$("#pulse-breadth").innerHTML =
			`<span class="up">▲ ${s.advancers}</span> <span class="down">▼ ${s.decliners}</span> <span class="muted">■ ${s.unchanged}</span>`;
		$("#pulse-movers").innerHTML = [...s.gainers.slice(0, 3), ...s.losers.slice(0, 2)]
			.map(
				(q) =>
					`<li><b>${esc(q.symbol)}</b> <span class="${(q.changePct ?? 0) >= 0 ? "up" : "down"}">${(q.changePct ?? 0) >= 0 ? "+" : ""}${Number(q.changePct ?? 0).toFixed(2)}%</span></li>`,
			)
			.join("");
		$("#pulse").hidden = false;
	})
	.catch(() => undefined);

for (const button of $$(".copy")) {
	button.addEventListener("click", async () => {
		const text = button.parentElement
			.querySelector("code")
			.textContent.split("\n")
			.filter((line) => !line.trim().startsWith("#"))
			.join("\n");
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select & copy";
		}
		setTimeout(() => {
			button.textContent = "Copy";
		}, 1600);
	});
}

const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

$("#year").textContent = String(new Date().getFullYear());
if (new URLSearchParams(location.search).get("deleted") === "1") {
	toast("Your account and its data have been deleted.");
	history.replaceState(null, "", "/");
}

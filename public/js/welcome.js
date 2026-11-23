// Onboarding: default market → starter watchlist → alert delivery → dashboard.
import { $, $$, api, debounce, esc, setupTheme, store } from "./core.js";

const form = $("#onboard");
const picked = new Set();
let step = 1;
let account = null;

function show(n) {
	step = n;
	for (const s of $$("section[data-step]", form)) s.hidden = Number(s.dataset.step) !== n;
	for (const li of $$(".progress li")) {
		const i = Number(li.dataset.step);
		li.toggleAttribute("aria-current", i === n);
		li.classList.toggle("done", i < n);
	}
	$("#back").hidden = n === 1;
	$("#next").textContent = n === 3 ? "Go to my dashboard" : n === 2 && picked.size === 0 ? "Skip for now" : "Continue";
	if (n === 2) loadSuggestions();
	$(`section[data-step="${n}"] input`, form)?.focus({ preventScroll: true });
}

const exchange = () => new FormData(form).get("exchange");

function pickButton(s) {
	const key = `${s.exchange}:${s.symbol}`;
	return `<button type="button" class="pick" data-key="${esc(key)}" aria-pressed="${picked.has(key)}">
		<b>${esc(s.symbol)}</b><span>${esc(s.name)}</span></button>`;
}

async function loadSuggestions() {
	const box = $("#picks");
	box.innerHTML = '<p class="muted small">Loading popular stocks…</p>';
	try {
		const m = await api(`/api/market?exchange=${exchange()}&top=12`);
		const seen = new Set();
		const list = [...m.mostActive, ...m.gainers].filter((q) => !seen.has(q.symbol) && seen.add(q.symbol)).slice(0, 12);
		box.innerHTML = list.length
			? list.map(pickButton).join("")
			: '<p class="muted small">No market data yet — search for a ticker above, or skip this step.</p>';
	} catch {
		box.innerHTML = '<p class="muted small">Couldn\'t load suggestions. Search for a ticker above.</p>';
	}
}

const search = debounce(async (q) => {
	if (q.length < 1) return loadSuggestions();
	const results = await api(`/api/securities?q=${encodeURIComponent(q)}&exchange=${exchange()}`).catch(() => []);
	$("#picks").innerHTML = results.length
		? results.map(pickButton).join("")
		: `<p class="muted small">No match for “${esc(q)}”. You can add stocks later from the dashboard.</p>`;
}, 200);

function renderChannels() {
	const n = account.notifications;
	const verified = account.user.emailVerified;
	$("#email-channel").innerHTML = `<span class="channel-icon" aria-hidden="true">✉</span>
		<div><b>Email</b><br><span class="muted small">${
			!n.emailDelivers
				? "Email delivery isn't configured on this server."
				: verified
					? `Alerts go to ${esc(account.user.email)}.`
					: `We sent a confirmation link to ${esc(account.user.email)} — click it to turn email alerts on.`
		}</span></div>`;
	$("#telegram-field").hidden = !n.telegramAvailable;
	if (n.telegramLinked) {
		$("#telegram-note").textContent = "Connected ✓";
		$("#telegram-connect").hidden = true;
	}
	const limit = account.limits.watchlist;
	$("#watch-limit").textContent = limit == null ? "" : `Your plan includes ${limit}.`;
}

async function finish(skipped) {
	const error = $(".auth-error", form);
	error.hidden = true;
	$("#next").disabled = true;
	try {
		if (!skipped) {
			await api("/api/account/notifications", { method: "PUT", body: { dailyDigest: form.dailyDigest.checked } });
		}
		await api("/api/account/onboarding", {
			method: "POST",
			body: { defaultExchange: exchange(), symbols: skipped ? [] : [...picked] },
		});
		const wantsPro = store.get("nvest.intent", null) === "pro";
		store.set("nvest.intent", null);
		location.assign(wantsPro && account.plan.id === "free" ? "/app/settings#plan" : "/app?welcome=1");
	} catch (err) {
		error.textContent = err.message;
		error.hidden = false;
		$("#next").disabled = false;
	}
}

async function init() {
	setupTheme($("#theme"));
	try {
		account = await api("/api/account");
	} catch {
		return;
	}
	$("#greeting").textContent = `Welcome, ${account.user.name.split(" ")[0]}!`;
	const preset = form.querySelector(`input[name=exchange][value="${account.user.defaultExchange}"]`);
	if (preset) preset.checked = true;
	renderChannels();

	$("#picks").addEventListener("click", (e) => {
		const btn = e.target.closest(".pick");
		if (!btn) return;
		const key = btn.dataset.key;
		const limit = account.limits.watchlist ?? Number.POSITIVE_INFINITY;
		if (!picked.has(key) && picked.size >= Math.min(limit, 20)) return;
		picked.has(key) ? picked.delete(key) : picked.add(key);
		btn.setAttribute("aria-pressed", String(picked.has(key)));
		$("#next").textContent = picked.size ? `Continue with ${picked.size}` : "Skip for now";
	});
	$("#pick-search").addEventListener("input", (e) => search(e.target.value.trim()));
	form.addEventListener("change", (e) => {
		if (e.target.name === "exchange") picked.clear();
	});
	$("#telegram-connect").addEventListener("click", async () => {
		try {
			const { url } = await api("/api/account/telegram/link", { method: "POST" });
			window.open(url, "_blank", "noopener");
			$("#telegram-note").textContent = "Tap Start in Telegram — we'll take it from there.";
		} catch (err) {
			$("#telegram-note").textContent = err.message;
		}
	});
	$("#back").addEventListener("click", () => show(step - 1));
	$("#skip").addEventListener("click", () => finish(true));
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		if (step < 3) show(step + 1);
		else finish(false);
	});
	show(1);
}

init();

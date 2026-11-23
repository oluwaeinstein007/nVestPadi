// Shared helpers for every nVestPadi page: DOM, formatting, API client, toasts, theme.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const store = {
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

export const esc = (v) =>
	String(v ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

export const fmtPrice = (n) =>
	n == null
		? "—"
		: Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });

export function fmtCompact(n) {
	if (n == null || !Number.isFinite(n)) return "—";
	return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO → "12 Mar 2026, 14:05" in the viewer's timezone. */
export function fmtDate(value, withTime = true) {
	if (!value) return "—";
	const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
	if (Number.isNaN(d.getTime())) return value;
	return d.toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
		...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
	});
}

export function chg(pct) {
	if (pct == null) return '<span class="chg flat">—</span>';
	const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
	return `<span class="chg ${cls}">${pct > 0 ? "+" : ""}${Number(pct).toFixed(2)}%</span>`;
}

export function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

export function initials(name) {
	return (
		String(name ?? "")
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0].toUpperCase())
			.join("") || "?"
	);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export class ApiError extends Error {
	constructor(message, status, code) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/**
 * JSON API call with the session cookie. On pages marked `data-auth="required"`,
 * an expired session sends the user to sign in and come back.
 */
export async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && document.body.dataset.auth === "required") {
		location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
		throw new ApiError("Your session has ended. Please sign in again.", 401, "unauthorized");
	}
	if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
	return data;
}

export async function signOut() {
	await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
	location.assign("/login");
}

/** Only allow same-site relative redirects (`/app…`), never `//evil.com`. */
export function safeNext(value, fallback = "/app") {
	return typeof value === "string" && /^\/(?!\/)/.test(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toastHost() {
	let host = $("#toasts");
	if (!host) {
		host = document.createElement("div");
		host.id = "toasts";
		host.className = "toasts";
		host.setAttribute("aria-live", "assertive");
		document.body.append(host);
	}
	return host;
}

/** `action` = { label, href } renders a link, e.g. an upgrade prompt. */
export function toast(message, kind = "info", action = null) {
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = message;
	if (action) {
		const a = document.createElement("a");
		a.href = action.href;
		a.textContent = action.label;
		el.append(" ", a);
	}
	toastHost().append(el);
	setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}

/** Show an API error; plan limits get an upgrade link. */
export function toastError(err) {
	if (err?.code === "plan_limit") toast(err.message, "error", { label: "See plans", href: "/app/settings#plan" });
	else toast(err?.message ?? String(err), "error");
}

// ---------------------------------------------------------------------------
// Theme (shared by every page via localStorage)
// ---------------------------------------------------------------------------

export function isDark() {
	const root = document.documentElement;
	return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

export function setupTheme(button, onChange) {
	const saved = store.get("nvest.theme", null);
	if (saved) document.documentElement.dataset.theme = saved;
	button?.addEventListener("click", () => {
		const next = isDark() ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		store.set("nvest.theme", next);
		onChange?.();
	});
}

// ---------------------------------------------------------------------------
// Signed-in chrome: user menu + email verification banner
// ---------------------------------------------------------------------------

/** Wire the avatar menu in the top bar. `account` is GET /api/account. */
export function setupUserMenu(account, { mode } = {}) {
	const root = $("#user-menu");
	if (!root) return;
	const { user, plan } = account;
	$(".avatar", root).textContent = initials(user.name);
	$("[data-user-name]", root).textContent = user.name;
	$("[data-user-email]", root).textContent = user.email;
	const badge = $("[data-plan]", root);
	badge.textContent = plan.name;
	badge.dataset.plan = plan.id;
	const upgrade = $("[data-upgrade]", root);
	if (upgrade) upgrade.hidden = !(mode === "cloud" && plan.id === "free");

	const button = $("button.avatar", root);
	const panel = $(".menu", root);
	const close = () => {
		panel.hidden = true;
		button.setAttribute("aria-expanded", "false");
	};
	button.addEventListener("click", (e) => {
		e.stopPropagation();
		panel.hidden = !panel.hidden;
		button.setAttribute("aria-expanded", String(!panel.hidden));
	});
	document.addEventListener("click", (e) => {
		if (!root.contains(e.target)) close();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") close();
	});
	$("[data-signout]", root).addEventListener("click", signOut);
}

export function showVerifyBanner(account) {
	const banner = $("#verify-banner");
	if (!banner || account.user.emailVerified) return;
	banner.hidden = false;
	banner.innerHTML = `<span>Confirm <b>${esc(account.user.email)}</b> to receive alerts by email.</span><button class="link" type="button">Resend link</button>`;
	$("button", banner).addEventListener("click", async (e) => {
		try {
			const r = await api("/api/auth/resend-verification", { method: "POST" });
			toast(r.delivered ? "Verification email sent — check your inbox." : "Link written to the server log.");
			e.target.disabled = true;
		} catch (err) {
			toastError(err);
		}
	});
}

// Settings: profile, alert delivery, plan & billing, security, API tokens, account deletion.
import { $, $$, api, esc, fmtDate, setupTheme, setupUserMenu, showVerifyBanner, toast, toastError } from "./core.js";

let account = null;
let session = null;

/** Disable a form's submit button while `fn` runs. */
function busy(form, fn) {
	return async (e) => {
		e.preventDefault();
		const button = $("button[type=submit]", form);
		button.disabled = true;
		try {
			await fn(new FormData(form), form);
		} catch (err) {
			toastError(err);
		} finally {
			button.disabled = false;
		}
	};
}

// -- Profile -----------------------------------------------------------------------

function renderProfile() {
	const f = $("#profile-form");
	f.name.value = account.user.name;
	f.email.value = account.user.email;
	f.defaultExchange.value = account.user.defaultExchange;
	$("#email-status").innerHTML = account.user.emailVerified
		? '<span class="tag ok">Verified</span>'
		: '<span class="tag warn">Not verified</span> Check your inbox for the confirmation link.';
}

// -- Notifications -----------------------------------------------------------------

function renderNotifications() {
	const n = account.notifications;
	const f = $("#notify-form");
	f.emailAlerts.checked = n.emailAlerts;
	f.telegramChatId.value = n.telegramChatId ?? "";
	f.discordWebhookUrl.value = n.discordWebhookUrl ?? "";

	$("#email-channel-note").textContent = !n.emailDelivers
		? "— email isn't configured on this server"
		: account.user.emailVerified
			? `to ${account.user.email}`
			: "— confirm your email first";
	$("#telegram-field").hidden = !n.telegramAvailable;
	$("#telegram-help").innerHTML =
		"Message the server's bot first, then get your ID from <b>@userinfobot</b> and paste it here.";
	const discordAllowed = account.limits.discordAlerts;
	f.discordWebhookUrl.disabled = !discordAllowed;
	$("#discord-tag").hidden = discordAllowed;
	$("#active-channels").textContent = n.activeChannels.length
		? `Active: ${n.activeChannels.join(", ")}`
		: "No active channel yet";
}

// -- Plan ----------------------------------------------------------------------------

function planFeatures(p) {
	const l = p.limits;
	return [
		`${l.watchlist} watchlist stocks`,
		`${l.activeAlerts} active alerts`,
		`${l.aiQuestionsPerDay} AI questions a day`,
		l.discordAlerts ? "Email, Telegram & Discord alerts" : "Email & Telegram alerts",
	];
}

function meter(label, used, limit) {
	const pct = limit == null ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
	return `<div class="meter"><span class="muted small">${esc(label)}</span><b>${used}${limit == null ? "" : ` / ${limit}`}</b>${
		limit == null
			? '<span class="muted small">Unlimited</span>'
			: `<div class="track"><i style="width:${pct}%"></i></div>`
	}</div>`;
}

function renderPlan() {
	const { plan, usage, limits } = account;
	$("#plan-name").textContent = plan.name;
	$("#plan-name").dataset.plan = plan.id;
	$("#meters").innerHTML = [
		meter("Watchlist", usage.watchlist, limits.watchlist),
		meter("Active alerts", usage.activeAlerts, limits.activeAlerts),
		meter("AI questions today", usage.aiQuestionsToday, limits.aiQuestionsPerDay),
	].join("");

	const actions = $("#plan-actions");
	if (plan.id === "self-hosted") {
		$("#plan-summary").textContent = "You're on a self-hosted server: every feature is unlimited.";
		actions.innerHTML = "";
		return;
	}
	$("#plan-summary").textContent =
		plan.id === "pro"
			? `You're on Pro${plan.renewsAt ? ` · renews ${fmtDate(plan.renewsAt, false)}` : ""}.`
			: "You're on the Free plan.";

	const card = (p) => `<div class="plan${plan.id === p.id ? " current" : ""}">
		<div class="row" style="justify-content:space-between"><b>${esc(p.name)}</b>${plan.id === p.id ? '<span class="tag ok">Current</span>' : ""}</div>
		<span class="price">${esc(p.priceLabel)}</span>
		<span class="muted small">${esc(p.tagline)}</span>
		<ul>${planFeatures(p)
			.map((f) => `<li>${esc(f)}</li>`)
			.join("")}</ul>
		${
			p.id === "pro" && plan.id === "free"
				? session.billing
					? '<button class="btn btn-primary" type="button" id="upgrade">Upgrade to Pro</button>'
					: '<p class="muted small">Upgrades are not available yet.</p>'
				: p.id === "pro" && plan.managed
					? '<button class="btn" type="button" id="manage-billing">Manage billing or cancel</button>'
					: ""
		}
	</div>`;
	actions.innerHTML = `<div class="plans">${session.plans.map(card).join("")}</div>`;

	$("#upgrade")?.addEventListener("click", async (e) => {
		e.target.disabled = true;
		try {
			const { url } = await api("/api/billing/checkout", { method: "POST" });
			location.assign(url);
		} catch (err) {
			toastError(err);
			e.target.disabled = false;
		}
	});
	$("#manage-billing")?.addEventListener("click", async () => {
		try {
			const { url } = await api("/api/billing/portal", { method: "POST" });
			location.assign(url);
		} catch (err) {
			toastError(err);
		}
	});
}

// -- Security ------------------------------------------------------------------------

function describeAgent(ua) {
	if (!ua) return "Unknown device";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Chrome\//.test(ua)
			? "Chrome"
			: /Firefox\//.test(ua)
				? "Firefox"
				: /Safari\//.test(ua)
					? "Safari"
					: ua.split(" ")[0];
	const os = /Windows/.test(ua)
		? "Windows"
		: /Android/.test(ua)
			? "Android"
			: /iPhone|iPad/.test(ua)
				? "iOS"
				: /Mac OS/.test(ua)
					? "macOS"
					: /Linux/.test(ua)
						? "Linux"
						: "";
	return `${browser}${os ? ` on ${os}` : ""}`;
}

async function loadSessions() {
	const list = await api("/api/account/sessions");
	$("#sessions").innerHTML = list
		.map(
			(
				s,
			) => `<li><span class="grow"><b>${esc(describeAgent(s.userAgent))}</b>${s.current ? ' <span class="tag ok">This device</span>' : ""}<br>
				<span class="muted small">Last active ${esc(fmtDate(s.lastSeenAt))}${s.ip ? ` · ${esc(s.ip)}` : ""}</span></span></li>`,
		)
		.join("");
	$("#signout-others").hidden = list.length < 2;
}

// -- API tokens ----------------------------------------------------------------------

async function loadTokens() {
	const list = await api("/api/account/tokens");
	$("#token-list").innerHTML = list.length
		? list
				.map(
					(t) => `<li><span class="grow"><b>${esc(t.name)}</b> <code class="muted small">${esc(t.prefix)}…</code><br>
						<span class="muted small">Created ${esc(fmtDate(t.createdAt, false))} · ${t.lastUsedAt ? `last used ${esc(fmtDate(t.lastUsedAt))}` : "never used"}</span></span>
						<button class="btn" type="button" data-revoke="${t.id}">Revoke</button></li>`,
				)
				.join("")
		: '<li class="muted">No tokens yet.</li>';
}

// -- Wiring --------------------------------------------------------------------------

async function reload() {
	account = await api("/api/account");
	renderProfile();
	renderNotifications();
	renderPlan();
}

function trackSection() {
	const links = $$(".settings-nav a");
	const update = () => {
		const id = location.hash.slice(1) || "profile";
		for (const a of links) a.setAttribute("aria-current", String(a.hash === `#${id}`));
	};
	addEventListener("hashchange", update);
	update();
}

async function init() {
	setupTheme($("#theme"));
	trackSection();
	try {
		[account, session] = await Promise.all([api("/api/account"), api("/api/auth/session")]);
	} catch (err) {
		if (err.status !== 401) toastError(err);
		return;
	}
	setupUserMenu(account, { mode: session.mode });
	showVerifyBanner(account);
	renderProfile();
	renderNotifications();
	renderPlan();
	loadSessions().catch(toastError);
	loadTokens().catch(toastError);

	if (new URLSearchParams(location.search).get("billing") === "success") {
		toast("Payment received — your plan updates within a few seconds.");
		history.replaceState(null, "", `${location.pathname}#plan`);
		setTimeout(() => reload().catch(() => undefined), 4000);
	}
	if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();

	const profile = $("#profile-form");
	profile.addEventListener(
		"submit",
		busy(profile, async (data) => {
			await api("/api/account", {
				method: "PATCH",
				body: { name: data.get("name"), defaultExchange: data.get("defaultExchange") },
			});
			await reload();
			toast("Profile saved");
		}),
	);

	const notify = $("#notify-form");
	notify.addEventListener(
		"submit",
		busy(notify, async (data, form) => {
			await api("/api/account/notifications", {
				method: "PUT",
				body: {
					emailAlerts: form.emailAlerts.checked,
					telegramChatId: account.notifications.telegramAvailable ? data.get("telegramChatId") || null : undefined,
					discordWebhookUrl: account.limits.discordAlerts ? data.get("discordWebhookUrl") || null : undefined,
				},
			});
			await reload();
			toast("Delivery settings saved");
		}),
	);
	$("#test-notify").addEventListener("click", async (e) => {
		e.target.disabled = true;
		try {
			const { results } = await api("/api/account/notifications/test", { method: "POST" });
			for (const r of results)
				toast(r.ok ? `Sent via ${r.channel}` : `${r.channel} failed: ${r.error}`, r.ok ? "info" : "error");
		} catch (err) {
			toastError(err);
		} finally {
			e.target.disabled = false;
		}
	});

	const password = $("#password-form");
	password.addEventListener(
		"submit",
		busy(password, async (data, form) => {
			await api("/api/account/password", {
				method: "POST",
				body: { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") },
			});
			form.reset();
			toast("Password changed. Other sessions were signed out.");
			loadSessions();
		}),
	);
	$("#signout-others").addEventListener("click", async () => {
		try {
			const r = await api("/api/account/sessions", { method: "DELETE" });
			toast(`Signed out ${r.signedOut} other session${r.signedOut === 1 ? "" : "s"}`);
			loadSessions();
		} catch (err) {
			toastError(err);
		}
	});

	const tokenForm = $("#token-form");
	tokenForm.addEventListener(
		"submit",
		busy(tokenForm, async (data, form) => {
			const { token } = await api("/api/account/tokens", { method: "POST", body: { name: data.get("name") } });
			form.reset();
			const box = $("#new-token");
			box.hidden = false;
			box.innerHTML = `<p class="small" style="margin-top:12px"><b>Copy your new token now</b> — you won't see it again.</p>
				<div class="secret"><span style="flex:1">${esc(token)}</span><button class="btn" type="button" id="copy-token">Copy</button></div>`;
			$("#copy-token").addEventListener("click", async (e) => {
				await navigator.clipboard.writeText(token).catch(() => undefined);
				e.target.textContent = "Copied";
			});
			loadTokens();
		}),
	);
	$("#token-list").addEventListener("click", async (e) => {
		const id = e.target.closest("[data-revoke]")?.dataset.revoke;
		if (!id || !confirm("Revoke this token? Scripts using it will stop working.")) return;
		try {
			await api(`/api/account/tokens/${id}`, { method: "DELETE" });
			loadTokens();
		} catch (err) {
			toastError(err);
		}
	});

	const del = $("#delete-form");
	del.addEventListener(
		"submit",
		busy(del, async (data) => {
			if (!confirm("Delete your account and all its data permanently?")) return;
			await api("/api/account", { method: "DELETE", body: { password: data.get("password") } });
			location.assign("/?deleted=1");
		}),
	);
}

init();

// Auth pages: one shell (auth.html) renders the view for the current path.
import { $, api, esc, safeNext, setupTheme, store } from "./core.js";

const params = new URLSearchParams(location.search);
const next = safeNext(params.get("next"));
// Remember "Start with Pro" from the pricing page so onboarding can end at checkout.
if (params.get("plan") === "pro") store.set("nvest.intent", "pro");
const view = $("#view");
let session = null;

const field = (name, label, attrs = "") =>
	`<label class="auth-field"><span>${label}</span><input name="${name}" ${attrs} /></label>`;

const passwordField = (name, label, autocomplete) =>
	`<label class="auth-field"><span>${label}</span><span class="pw">
		<input name="${name}" type="password" required minlength="8" maxlength="128" autocomplete="${autocomplete}" />
		<button type="button" class="pw-toggle" aria-label="Show password">Show</button>
	</span>${autocomplete === "new-password" ? '<small class="muted">At least 8 characters.</small>' : ""}</label>`;

function render(title, html) {
	document.title = `${title} · nVestPadi`;
	view.innerHTML = html;
	for (const btn of view.querySelectorAll(".pw-toggle")) {
		btn.addEventListener("click", () => {
			const input = btn.previousElementSibling;
			const show = input.type === "password";
			input.type = show ? "text" : "password";
			btn.textContent = show ? "Hide" : "Show";
			btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
		});
	}
	view.querySelector("input:not([type=hidden])")?.focus();
}

function showError(message) {
	let box = $(".auth-error", view);
	if (!box) {
		box = document.createElement("p");
		box.className = "auth-error";
		box.setAttribute("role", "alert");
		$("form", view)?.prepend(box);
	}
	box.textContent = message;
}

/** Submit a form to the API; `onDone` receives the response. */
function handle(form, path, toBody, onDone) {
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const button = $("button[type=submit]", form);
		const label = button.textContent;
		button.disabled = true;
		button.textContent = "Please wait…";
		try {
			onDone(await api(path, { method: "POST", body: toBody(new FormData(form)) }));
		} catch (err) {
			showError(err.message);
			button.disabled = false;
			button.textContent = label;
		}
	});
}

const nextQuery = next !== "/app" ? `?next=${encodeURIComponent(next)}` : "";

// -- Views ----------------------------------------------------------------------------

function login() {
	render(
		"Sign in",
		`<h1>Welcome back</h1>
		<p class="muted">Sign in to your nVestPadi account.</p>
		<form>
			${field("email", "Email", 'type="email" required autocomplete="email" inputmode="email"')}
			${passwordField("password", "Password", "current-password")}
			<a class="auth-link-right small" href="/forgot-password">Forgot password?</a>
			<button class="btn btn-primary btn-lg btn-block" type="submit">Sign in</button>
		</form>
		${session.signup.open ? `<p class="auth-switch">New to nVestPadi? <a href="/signup${nextQuery}">Create a free account</a></p>` : '<p class="auth-switch muted small">Need an account? Ask the owner of this server.</p>'}`,
	);
	handle(
		$("form", view),
		"/api/auth/login",
		(d) => ({ email: d.get("email"), password: d.get("password") }),
		(r) => location.assign(r.user.onboarded ? next : "/welcome"),
	);
}

function signup() {
	const { open, needsOwner } = session.signup;
	if (!open) {
		render(
			"Sign up",
			`<h1>Sign-up is closed</h1>
			<p class="muted">This nVestPadi server is private. Ask its owner to create an account for you.</p>
			<a class="btn btn-primary btn-lg btn-block" href="/login">Back to sign in</a>`,
		);
		return;
	}
	const cloud = session.mode === "cloud";
	render(
		needsOwner ? "Set up nVestPadi" : "Create your account",
		`<h1>${needsOwner ? "Create the owner account" : "Create your free account"}</h1>
		<p class="muted">${
			needsOwner
				? "This is a new server. The first account becomes its owner and can manage everything."
				: "Free forever for the essentials. No card required."
		}</p>
		<form>
			${field("name", "Full name", 'required maxlength="80" autocomplete="name"')}
			${field("email", "Email", 'type="email" required autocomplete="email" inputmode="email"')}
			${passwordField("password", "Password", "new-password")}
			${
				cloud
					? `<label class="auth-check"><input type="checkbox" name="acceptTerms" required />
						<span>I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a>, and understand nVestPadi is not investment advice.</span></label>`
					: ""
			}
			<button class="btn btn-primary btn-lg btn-block" type="submit">${needsOwner ? "Create owner account" : "Create account"}</button>
		</form>
		${needsOwner ? "" : `<p class="auth-switch">Already have an account? <a href="/login${nextQuery}">Sign in</a></p>`}`,
	);
	handle(
		$("form", view),
		"/api/auth/signup",
		(d) => ({
			name: d.get("name"),
			email: d.get("email"),
			password: d.get("password"),
			acceptTerms: cloud ? d.get("acceptTerms") === "on" : undefined,
		}),
		() => location.assign("/welcome"),
	);
}

function forgot() {
	render(
		"Reset password",
		`<h1>Reset your password</h1>
		<p class="muted">Enter your account's email and we'll send you a reset link.</p>
		<form>
			${field("email", "Email", 'type="email" required autocomplete="email" inputmode="email"')}
			<button class="btn btn-primary btn-lg btn-block" type="submit">Send reset link</button>
		</form>
		<p class="auth-switch"><a href="/login">Back to sign in</a></p>`,
	);
	handle(
		$("form", view),
		"/api/auth/forgot-password",
		(d) => ({ email: d.get("email") }),
		() =>
			render(
				"Check your email",
				`<h1>Check your email</h1>
				<p class="muted">If an account exists for that address, a reset link is on its way. It expires in 1 hour.</p>
				${session.emailDelivers ? "" : '<p class="auth-note small">This server has no email service configured, so the link was written to the server log. The owner can also run <code>nvest users set-password &lt;email&gt;</code>.</p>'}
				<a class="btn btn-ghost btn-lg btn-block" href="/login">Back to sign in</a>`,
			),
	);
}

function reset() {
	const token = params.get("token");
	if (!token) return invalidLink("reset");
	render(
		"Choose a new password",
		`<h1>Choose a new password</h1>
		<p class="muted">You'll be signed out on every other device.</p>
		<form>
			<input type="text" name="username" autocomplete="username" hidden />
			${passwordField("password", "New password", "new-password")}
			<button class="btn btn-primary btn-lg btn-block" type="submit">Save and sign in</button>
		</form>`,
	);
	handle(
		$("form", view),
		"/api/auth/reset-password",
		(d) => ({ token, password: d.get("password") }),
		(r) => location.assign(r.user.onboarded ? "/app" : "/welcome"),
	);
}

async function verify() {
	const token = params.get("token");
	if (!token) return invalidLink("verification");
	render("Confirming email", "<h1>Confirming your email…</h1>");
	try {
		const r = await api("/api/auth/verify-email", { method: "POST", body: { token } });
		const signedIn = Boolean(session.user);
		render(
			"Email confirmed",
			`<div class="auth-success" aria-hidden="true">✓</div>
			<h1>Email confirmed</h1>
			<p class="muted">Thanks, ${esc(r.user.name.split(" ")[0])}. Alerts can now reach <b>${esc(r.user.email)}</b>.</p>
			<a class="btn btn-primary btn-lg btn-block" href="${signedIn ? (r.user.onboarded ? "/app" : "/welcome") : "/login"}">${signedIn ? "Continue" : "Sign in"}</a>`,
		);
	} catch (err) {
		render(
			"Link expired",
			`<h1>That link didn't work</h1>
			<p class="muted">${esc(err.message)}</p>
			<p class="muted small">Sign in and use “Resend link” in the banner to get a new one.</p>
			<a class="btn btn-primary btn-lg btn-block" href="/login">Sign in</a>`,
		);
	}
}

function invalidLink(kind) {
	render(
		"Invalid link",
		`<h1>This ${kind} link is incomplete</h1>
		<p class="muted">Open the link from your email again, or request a new one.</p>
		<a class="btn btn-primary btn-lg btn-block" href="${kind === "reset" ? "/forgot-password" : "/login"}">Continue</a>`,
	);
}

const VIEWS = {
	"/login": login,
	"/signup": signup,
	"/forgot-password": forgot,
	"/reset-password": reset,
	"/verify-email": verify,
};

async function init() {
	setupTheme($("#theme"));
	try {
		session = await api("/api/auth/session");
	} catch {
		session = { user: null, mode: "self-hosted", signup: { open: false, needsOwner: false }, emailDelivers: false };
	}
	(VIEWS[location.pathname.replace(/\/+$/, "")] ?? login)();
}

init();

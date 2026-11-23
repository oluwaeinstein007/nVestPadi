/** Transactional email templates: plain text plus a minimal, client-safe HTML version. */
import type { EmailMessage } from "./mailer.js";

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
	const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
	const button = action
		? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#0b7a4b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(action.label)}</a></p><p style="margin:0 0 16px;color:#5b6b64;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(action.url)}</span></p>`
		: "";
	return `<!doctype html><html><body style="margin:0;background:#f6f8f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0d1512">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:18px;font-weight:700;margin:0 0 24px">nVest<span style="color:#0b7a4b">Padi</span></p>
<div style="background:#fff;border:1px solid #e4e8e6;border-radius:12px;padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${body}${button}
</div>
<p style="color:#5b6b64;font-size:12px;margin:20px 0 0">nVestPadi is a research tool, not investment advice.</p>
</div></body></html>`;
}

export function verifyEmail(to: string, name: string, url: string): EmailMessage {
	const intro = `Hi ${name}, welcome to nVestPadi! Confirm your email address so we can send you price alerts and account notices.`;
	return {
		to,
		subject: "Confirm your email for nVestPadi",
		text: `${intro}\n\nConfirm your email: ${url}\n\nThe link expires in 48 hours. If you didn't sign up, ignore this email.`,
		html: layout(
			"Confirm your email",
			[intro, "The link expires in 48 hours. If you didn't sign up, ignore this email."],
			{
				label: "Confirm email",
				url,
			},
		),
	};
}

export function passwordReset(to: string, name: string, url: string): EmailMessage {
	const intro = `Hi ${name}, someone (hopefully you) asked to reset your nVestPadi password.`;
	const outro =
		"The link expires in 1 hour and works once. If you didn't ask for this, you can ignore this email; your password won't change.";
	return {
		to,
		subject: "Reset your nVestPadi password",
		text: `${intro}\n\nChoose a new password: ${url}\n\n${outro}`,
		html: layout("Reset your password", [intro, outro], { label: "Choose a new password", url }),
	};
}

export function alertDigest(to: string, name: string, messages: string[], url: string): EmailMessage {
	const subject = messages.length === 1 ? "1 alert triggered" : `${messages.length} alerts triggered`;
	return {
		to,
		subject: `🔔 ${subject} — nVestPadi`,
		text: `Hi ${name},\n\n${messages.join("\n\n")}\n\nOpen nVestPadi: ${url}`,
		html: layout(subject, [`Hi ${name},`, ...messages], { label: "Open dashboard", url }),
	};
}

export function testNotification(to: string, name: string, url: string): EmailMessage {
	return {
		to,
		subject: "nVestPadi test notification",
		text: `Hi ${name}, this is a test. Your alerts will arrive here.\n\n${url}`,
		html: layout("Test notification", [`Hi ${name}, this is a test. Your alerts will arrive here.`], {
			label: "Open settings",
			url,
		}),
	};
}

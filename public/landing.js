// Landing page behaviour: theme toggle (shared with the dashboard), screenshot theming, copy buttons.

const root = document.documentElement;

function readTheme() {
	try {
		return localStorage.getItem("nvest.theme");
	} catch {
		return null;
	}
}

function isDark() {
	return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/** <picture> media queries follow the OS; when the user picks a theme explicitly, pin images to it. */
function syncScreenshots() {
	if (!root.dataset.theme) return;
	for (const img of document.querySelectorAll("img[data-light]")) {
		for (const source of img.parentElement.querySelectorAll("source")) source.remove();
		img.src = isDark() ? img.dataset.dark : img.dataset.light;
	}
}

const saved = readTheme();
if (saved) root.dataset.theme = saved;
syncScreenshots();

document.getElementById("theme").addEventListener("click", () => {
	const next = isDark() ? "light" : "dark";
	root.dataset.theme = next;
	try {
		localStorage.setItem("nvest.theme", next);
	} catch {
		/* preference just won't persist */
	}
	syncScreenshots();
});

for (const button of document.querySelectorAll(".copy")) {
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

const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

document.getElementById("year").textContent = String(new Date().getFullYear());

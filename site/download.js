/*
 * Points the download button at the latest release.
 *
 * The release assets carry their version in the filename
 * (`datagripe-desktop-v0.0.1-macos-arm64.tar.gz`), which is useful in a
 * downloads folder and means GitHub's fixed
 * `/releases/latest/download/<name>` redirect cannot be used. So the
 * page asks the API instead.
 *
 * Everything here upgrades markup that already works: the button ships
 * pointing at the releases page, so no JavaScript, a rate-limited API or
 * an outage all degrade to a page you can still download from.
 */

const REPO = "rick-the-alien/datagripe";

const PLATFORMS = [
	{ key: "macos-arm64", label: "macOS (Apple silicon)" },
	{ key: "win-x64", label: "Windows" },
	{ key: "linux-x64", label: "Linux" },
];

/** Which build this visitor most likely wants, or null when unsure. */
function detectPlatform() {
	const hint = navigator.userAgentData?.platform ?? "";
	const agent = `${hint} ${navigator.userAgent}`.toLowerCase();
	if (agent.includes("mac")) {
		// There is no Intel Mac build, so do not offer one as *the*
		// download; an Intel visitor still gets the full list.
		return agent.includes("intel") ? null : "macos-arm64";
	}
	if (agent.includes("win")) {
		return "win-x64";
	}
	// Android reports "linux" and has no desktop build.
	if (agent.includes("linux") && !agent.includes("android")) {
		return "linux-x64";
	}
	return null;
}

function assetFor(assets, platformKey) {
	return assets.find((asset) => asset.name.includes(platformKey));
}

/** One `<li><a>` for the download list. */
function linkItem(href, text) {
	const item = document.createElement("li");
	const link = document.createElement("a");
	link.href = href;
	link.textContent = text;
	item.append(link);
	return item;
}

function render(release) {
	const assets = release.assets ?? [];
	const version = release.tag_name ?? "";

	// Built as nodes rather than innerHTML: these strings come off the
	// network, and a marketing page is no place to start trusting them.
	const items = [];
	for (const platform of PLATFORMS) {
		const asset = assetFor(assets, platform.key);
		if (asset !== undefined) {
			items.push(linkItem(asset.browser_download_url, platform.label));
		}
	}
	const web = assets.find((asset) => asset.name.includes("-web-"));
	if (web !== undefined) {
		items.push(linkItem(web.browser_download_url, "Web bundle"));
	}
	items.push(
		linkItem(`https://github.com/${REPO}/releases/latest`, "Release notes"),
	);
	document.getElementById("download-all").replaceChildren(...items);

	const detected = detectPlatform();
	const preferred = detected === null ? undefined : assetFor(assets, detected);
	const meta = document.getElementById("download-meta");
	if (preferred === undefined) {
		meta.textContent = `${version} · free and open source, MIT.`;
		return;
	}

	const label = PLATFORMS.find((platform) => platform.key === detected)?.label;
	const button = document.getElementById("download-primary");
	button.href = preferred.browser_download_url;
	button.textContent = `Download for ${label}`;
	const megabytes = Math.round(preferred.size / 1024 / 1024);
	meta.textContent = `${version} · ${megabytes} MB · free and open source, MIT.`;
}

async function loadLatestRelease() {
	const response = await fetch(
		`https://api.github.com/repos/${REPO}/releases/latest`,
		{ headers: { Accept: "application/vnd.github+json" } },
	);
	if (!response.ok) {
		throw new Error(`GitHub API ${response.status}`);
	}
	return response.json();
}

loadLatestRelease()
	.then(render)
	.catch(() => {
		// The markup already points at the releases page: leave a working
		// link rather than an error the visitor cannot act on.
	});

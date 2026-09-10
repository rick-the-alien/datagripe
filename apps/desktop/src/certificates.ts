import { existsSync } from "node:fs";

/**
 * Point the runtime at the system's certificate authorities.
 *
 * Cottontail does not find them on its own. Measured on one machine, same
 * URL, same moment: system Bun fetches
 * `https://github.com/.../stable-linux-x64-update.json` and returns 200,
 * and the cottontail the app actually runs on fails with `unable to get
 * local issuer certificate`. So every update check failed — quietly, in
 * the log, exactly as designed for a network problem, which is why it
 * looked like one user's proxy rather than the updater being dead for
 * everybody.
 *
 * Setting `NODE_EXTRA_CA_CERTS` fixes it, and it has to be done through
 * `process.env` rather than the libc `setenv` used for WebKit in
 * `rendering.ts`: the two are read by different things at different
 * times. WebKit reads the real environment through `g_getenv`, and Bun
 * reads its own JS-side copy when a fetch needs a trust store — which is
 * late enough that assigning here works, and native enough that the FFI
 * route does not. Both were tried; only this one comes back 200.
 *
 * `NODE_EXTRA_CA_CERTS` adds to whatever the runtime already trusts
 * rather than replacing it, so naming a bundle can only widen trust to
 * the set the operating system already ships.
 */

/** Where distributions keep the bundle, in rough order of prevalence. */
const CA_BUNDLES = [
	// Debian, Ubuntu, Arch, Alpine
	"/etc/ssl/certs/ca-certificates.crt",
	// Fedora, RHEL, Rocky
	"/etc/pki/tls/certs/ca-bundle.crt",
	// openSUSE
	"/etc/ssl/ca-bundle.pem",
	// FreeBSD, and macOS with the ports bundle
	"/etc/ssl/cert.pem",
];

export function useSystemCertificates(): void {
	// Somebody who set it has already decided, including on purpose to
	// point at a corporate root.
	if (Bun.env.NODE_EXTRA_CA_CERTS !== undefined) {
		return;
	}
	const bundle = CA_BUNDLES.find((path) => existsSync(path));
	if (bundle === undefined) {
		// Not fatal: the runtime may well have its own roots on this
		// platform, and an app that refuses to open because it could not
		// find a certificate file is worse than one that cannot update.
		console.log("[desktop] no system CA bundle found; leaving TLS as it is");
		return;
	}
	process.env.NODE_EXTRA_CA_CERTS = bundle;
}

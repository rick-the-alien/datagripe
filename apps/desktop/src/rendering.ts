import { dlopen, FFIType } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The white-screen setting.
 *
 * On some Linux GPU setups — NVIDIA rendering the window is the reported
 * one — WebKit's DMABUF renderer cannot allocate a buffer, and the app
 * opens as a blank rectangle. The server is fine, the page has loaded and
 * is answering; nothing is drawn. The log says so, twice:
 *
 *     Failed to create GBM buffer of size 1440x900: Invalid argument
 *
 * `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes it, and a terminal can set
 * that. A desktop icon cannot, which is the actual gap: the people who
 * hit this meet a blank window with no way to act on it.
 *
 * Deliberately NOT automatic. The obvious trigger — an NVIDIA driver
 * being present — misfires: a hybrid laptop with an RTX card and the open
 * kernel module renders perfectly through its Intel iGPU, and turning off
 * hardware compositing there would cost something for nothing. Whether
 * the NVIDIA GPU is the one drawing is not a question two files under
 * /proc can answer, so this is a setting rather than a guess.
 */

/** `settings.json` beside the cluster and the local secrets. */
export interface DesktopSettings {
	/**
	 * Set true if the window opens blank. Costs hardware-accelerated
	 * compositing; buys a window you can see.
	 */
	disableDmabufRenderer?: boolean;
}

const SETTINGS_FILE = "settings.json";
const DMABUF_ENV = "WEBKIT_DISABLE_DMABUF_RENDERER";

export function readSettings(userData: string): DesktopSettings {
	const file = path.join(userData, SETTINGS_FILE);
	if (!existsSync(file)) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return {};
		}
		return parsed as DesktopSettings;
	} catch (error) {
		// A malformed settings file must not stop the app opening; that is
		// the opposite of what this file is for.
		console.log(
			`[desktop] ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

/**
 * Set a variable where native code will find it.
 *
 * `process.env.X = "1"` is not enough, and that is measured rather than
 * assumed: after assigning it, `getenv("X")` through FFI still returns
 * null, because Bun keeps its own copy and never calls libc. GTK and
 * WebKit read this through `g_getenv`, so a JS-side copy is invisible to
 * them — and the WebKit process they spawn inherits the real environment,
 * not Bun's. Hence libc directly.
 */
function setNativeEnv(name: string, value: string): boolean {
	try {
		const libc = dlopen("libc.so.6", {
			setenv: {
				args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		const result = libc.symbols.setenv(
			Buffer.from(`${name}\0`),
			Buffer.from(`${value}\0`),
			1,
		);
		return result === 0;
	} catch (error) {
		console.log(
			`[desktop] could not set ${name}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Apply the rendering settings. Call before the first window is created:
 * WebKit reads this when it builds a backing store, which happens then.
 *
 * Import order is not relied on for that — biome may reorder imports, and
 * a guarantee that depends on where a line sits in an import block is not
 * one.
 */
export function applyRenderingSettings(settings: DesktopSettings): void {
	if (process.platform !== "linux") {
		return;
	}
	// Someone who set it in the environment has already decided.
	if (Bun.env[DMABUF_ENV] !== undefined) {
		return;
	}
	if (settings.disableDmabufRenderer !== true) {
		return;
	}
	if (setNativeEnv(DMABUF_ENV, "1")) {
		console.log(`[desktop] ${DMABUF_ENV}=1 (${SETTINGS_FILE})`);
	}
}

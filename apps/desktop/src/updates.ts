import { Updater, Utils } from "electrobun/main";

/**
 * Offer updates, and install the ones that are accepted.
 *
 * Electrobun does the work. `checkForUpdate` reads
 * `<release.baseUrl>/<channel>-<os>-<arch>-update.json` — published by
 * the release workflow out of `apps/desktop/artifacts/` — and compares
 * its hash with the one in `Resources/version.json`. `downloadUpdate`
 * stages the new bundle, and `applyUpdate` hands off to a detached helper
 * that replaces the installed app and relaunches it.
 *
 * Dev builds opt themselves out: the updater refuses the `dev` channel,
 * so nothing here has to know which build it is in.
 */

/** Late enough that opening the app is never met with a modal. */
const FIRST_CHECK_DELAY_MS = 10_000;
/** An app people leave open for days should still notice a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Progress is for the log, not a progress bar; every quarter is plenty. */
const PROGRESS_LOG_STEP = 25;

export interface UpdateHooks {
	/**
	 * Stop the server and wait for it to actually be gone. PostgreSQL
	 * holds a lock on its data directory and the relaunched app opens the
	 * same one, so an update that outran its own backend would come back
	 * to `FATAL: lock file "postmaster.pid" already exists`.
	 */
	stopServer: () => Promise<void>;
}

/** Update hashes already put to the user, so a decline asks once a run. */
const offered = new Set<string>();
let inProgress = false;

function logStatus(): void {
	let lastLoggedPercent = -1;
	Updater.onStatusChange((entry) => {
		if (entry.status === "download-progress") {
			const percent =
				Math.floor((entry.details?.progress ?? 0) / PROGRESS_LOG_STEP) *
				PROGRESS_LOG_STEP;
			if (percent === lastLoggedPercent) {
				return;
			}
			lastLoggedPercent = percent;
		}
		console.log(`[desktop] update: ${entry.status} — ${entry.message}`);
	});
}

async function offerUpdate(hooks: UpdateHooks): Promise<void> {
	if (inProgress) {
		return;
	}
	inProgress = true;
	try {
		const info = await Updater.checkForUpdate();
		// A check that could not reach the manifest is a bad network, not
		// something to interrupt anyone about.
		if (info.error !== "" || !info.updateAvailable || offered.has(info.hash)) {
			return;
		}
		offered.add(info.hash);

		const local = await Updater.getLocalInfo();
		// What is compared is the build hash, so two builds can share a
		// version — a local one against a release, or a re-tagged release.
		// Saying "0.0.3 is available, you are running 0.0.3" in that case
		// reads as a bug in the updater rather than a difference in builds.
		const sameVersion = info.version === local.version;
		const build = (hash: string) => hash.slice(0, 8);
		const { response } = await Utils.showMessageBox({
			type: "question",
			title: "Update DataGripe",
			message: sameVersion
				? `A different build of DataGripe ${info.version} is available.`
				: `DataGripe ${info.version} is available.`,
			detail: sameVersion
				? `You are running build ${build(local.hash)} and this is ${build(info.hash)}. Installing closes DataGripe and reopens it on the other build.`
				: `You are running ${local.version}. Installing closes DataGripe and reopens it on the new version.`,
			buttons: ["Install and Restart", "Later"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response !== 0) {
			return;
		}

		// Download first and stop the server second: a download that fails
		// should leave a working app behind, not a headless one.
		await Updater.downloadUpdate();
		if (Updater.updateInfo().error !== "") {
			throw new Error(Updater.updateInfo().error);
		}
		await hooks.stopServer();
		await Updater.applyUpdate();

		// `applyUpdate` starts a graceful quit rather than blocking on one,
		// so returning here is normal. Its recorded error is the signal.
		const failure = Updater.updateInfo().error;
		if (failure !== "") {
			await Utils.showMessageBox({
				type: "error",
				title: "Update failed",
				message: "DataGripe could not install the update.",
				detail: `${failure}\n\nDataGripe will close. Reopen it to carry on with this version.`,
				buttons: ["Close"],
			});
			Utils.quit(1);
		}
	} catch (error) {
		console.log(
			`[desktop] update failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		inProgress = false;
	}
}

/**
 * Start checking. Never throws and never blocks startup: an app that
 * cannot reach its update manifest is an app that still has to open.
 */
export function scheduleUpdateChecks(hooks: UpdateHooks): void {
	if (Bun.env.DATAGRIPE_DISABLE_UPDATES === "true") {
		console.log("[desktop] update checks off (DATAGRIPE_DISABLE_UPDATES)");
		return;
	}
	logStatus();
	setTimeout(() => void offerUpdate(hooks), FIRST_CHECK_DELAY_MS);
	setInterval(() => void offerUpdate(hooks), CHECK_INTERVAL_MS);
}

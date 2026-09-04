import { registerSW } from "virtual:pwa-register";
import { usePwaStore } from "./stores/pwa";

// Re-check for a new build hourly and whenever the window regains focus;
// registerType is "prompt", so detection never reloads the page by itself —
// it only surfaces the refresh button (stores/pwa.ts, StatusBar).
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function registerAppServiceWorker(): void {
	const updateSW = registerSW({
		immediate: true,
		onNeedRefresh() {
			usePwaStore.setState({ updateAvailable: true });
		},
		onRegisteredSW(_swUrl, registration) {
			if (registration === undefined) {
				return;
			}
			setInterval(() => {
				void registration.update();
			}, UPDATE_CHECK_INTERVAL_MS);
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible") {
					void registration.update();
				}
			});
		},
	});
	usePwaStore.setState({
		applyUpdate: () => {
			void updateSW(true);
		},
	});
}

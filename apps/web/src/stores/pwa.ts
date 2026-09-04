import { create } from "zustand";

/**
 * PWA update state. pwa.ts (service-worker registration) flips
 * `updateAvailable` when a new build's service worker is waiting; the
 * StatusBar surfaces `applyUpdate` as a refresh button. `applyUpdate` tells
 * the waiting worker to activate and reloads the page onto the new assets.
 */
interface PwaState {
	updateAvailable: boolean;
	applyUpdate: (() => void) | null;
}

export const usePwaStore = create<PwaState>(() => ({
	updateAvailable: false,
	applyUpdate: null,
}));

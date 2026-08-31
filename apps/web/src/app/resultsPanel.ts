/**
 * Results-panel opener seam: the Workspace registers the Dockview-aware
 * opener; the executions store calls it before running so the panel is
 * visible without the store knowing Dockview.
 */
let opener: (() => void) | null = null;

export function registerResultsOpener(fn: () => void): void {
	opener = fn;
}

export function ensureResultsPanel(): void {
	opener?.();
}

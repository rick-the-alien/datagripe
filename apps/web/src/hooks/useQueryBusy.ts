import { useEffect, useState } from "react";
import { useExecutionsStore } from "../stores/runtime";

/** Milliseconds the busy signal is held back so fast queries do not flash
 * the activity bar (brand-system.md "Motion": hold idle for 200ms). */
const BUSY_DELAY_MS = 200;

/**
 * True while any statement is queued or running, brand-adjusted: the busy
 * edge only appears after 200ms of continuous work and clears immediately.
 */
export function useQueryBusy(): boolean {
	const anyBusy = useExecutionsStore((state) =>
		Object.values(state.executions).some(
			(execution) =>
				execution.status === "queued" || execution.status === "running",
		),
	);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!anyBusy) {
			setBusy(false);
			return;
		}
		const timer = setTimeout(() => setBusy(true), BUSY_DELAY_MS);
		return () => clearTimeout(timer);
	}, [anyBusy]);

	return busy;
}

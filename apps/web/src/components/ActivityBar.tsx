import { useEffect, useRef } from "react";
import { useQueryBusy } from "../hooks/useQueryBusy";

/**
 * The brand rule at the top edge of the window is also the activity
 * indicator (brand-system.md "Motion"): static while idle, drifting while
 * a statement executes. Structure and timing live in styles/tokens.css —
 * the three invariants (palindrome, plateaus, multiply-only layers) are
 * enforced there, not here.
 */
export function ActivityBar() {
	const busy = useQueryBusy();
	const barRef = useRef<HTMLDivElement | null>(null);
	const busySinceRef = useRef<number | null>(null);

	// Long queries calm down: playbackRate eases 1.0 → 0.4 across the first
	// ten minutes via WAAPI (rewriting animation-duration would jump the bar).
	useEffect(() => {
		const bar = barRef.current;
		if (bar === null) {
			return;
		}
		if (!busy) {
			busySinceRef.current = null;
			for (const node of bar.querySelectorAll("*")) {
				for (const animation of node.getAnimations()) {
					animation.playbackRate = 1;
				}
			}
			return;
		}
		busySinceRef.current = Date.now();
		const timer = setInterval(() => {
			const since = busySinceRef.current;
			if (since === null) {
				return;
			}
			const t = Math.min((Date.now() - since) / 1000, 600) / 600;
			const rate = 1 - 0.6 * (t * t * (3 - 2 * t)); // smoothstep
			for (const node of bar.querySelectorAll("*")) {
				for (const animation of node.getAnimations()) {
					animation.playbackRate = rate;
				}
			}
		}, 5000);
		return () => clearInterval(timer);
	}, [busy]);

	return (
		<div
			ref={barRef}
			className={busy ? "dg-abar" : "dg-abar is-idle"}
			role="status"
			aria-label={busy ? "A statement is executing" : "Idle"}
		>
			<div className="dg-abar__colour" />
			<div className="dg-abar__wave" />
			<div className="dg-abar__wave2" />
		</div>
	);
}

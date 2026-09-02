/**
 * MOCK — flat SVG placeholder for the mascot (docs/brand/brand-system.md
 * "Mascot"): the drawn flat-SVG rig is an open item, so this is a
 * hand-drawn cylinder with the default scowl, not the final asset.
 * Never smiling, never waving.
 */
export type MascotExpression =
	| "scowl"
	| "side-eye"
	| "eyes-closed"
	| "approval";

export function Mascot(props: {
	size?: number;
	expression?: MascotExpression;
}) {
	const size = props.size ?? 64;
	const expression = props.expression ?? "scowl";

	// Pupils shift right for side-eye; eyes become arcs when closed.
	const pupilDx = expression === "side-eye" ? 1.2 : 0;
	const eyesClosed = expression === "eyes-closed";
	// Faint approval: one brow raised, mouth level.
	const approval = expression === "approval";

	return (
		<svg
			className="dg-mascot"
			width={size}
			height={size}
			viewBox="0 0 64 64"
			role="img"
			aria-label="Datagripe mascot (mock asset)"
		>
			<title>Datagripe mascot — mock asset</title>
			{/* shadow */}
			<ellipse cx="32" cy="57" rx="16" ry="3" fill="#000000" opacity="0.35" />
			{/* body */}
			<path
				d="M14 16c0-4.4 8-8 18-8s18 3.6 18 8v32c0 4.4-8 8-18 8s-18-3.6-18-8Z"
				fill="var(--dg-raised)"
				stroke="var(--dg-green)"
				strokeWidth="2"
			/>
			{/* rim */}
			<ellipse
				cx="32"
				cy="16"
				rx="18"
				ry="8"
				fill="var(--dg-panel)"
				stroke="var(--dg-cyan)"
				strokeWidth="2"
			/>
			{/* brows — the scowl lives here */}
			{approval ? (
				<>
					<path
						d="M20 30l7-3"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
					<path
						d="M37 24.5l7 2.5"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
				</>
			) : eyesClosed ? (
				<>
					<path
						d="M20 28h7"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
					<path
						d="M37 28h7"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
				</>
			) : (
				<>
					<path
						d="M20 25.5l7 3"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
					<path
						d="M44 25.5l-7 3"
						stroke="var(--dg-ink)"
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
				</>
			)}
			{/* eyes */}
			{eyesClosed ? (
				<>
					<path
						d="M21 33.5c1-1.6 4-1.6 5 0"
						fill="none"
						stroke="var(--dg-ink)"
						strokeWidth="2"
						strokeLinecap="round"
					/>
					<path
						d="M38 33.5c1-1.6 4-1.6 5 0"
						fill="none"
						stroke="var(--dg-ink)"
						strokeWidth="2"
						strokeLinecap="round"
					/>
				</>
			) : (
				<>
					<circle cx="23.5" cy="33.5" r="3" fill="var(--dg-ink)" />
					<circle cx="40.5" cy="33.5" r="3" fill="var(--dg-ink)" />
					<circle cx={23.5 + pupilDx} cy="33.5" r="1.3" fill="var(--dg-void)" />
					<circle cx={40.5 + pupilDx} cy="33.5" r="1.3" fill="var(--dg-void)" />
				</>
			)}
			{/* mouth — level for approval, turned down otherwise */}
			{approval ? (
				<path
					d="M26 43h12"
					stroke="var(--dg-ink)"
					strokeWidth="2.2"
					strokeLinecap="round"
				/>
			) : (
				<path
					d="M26 44.5c2-2.2 10-2.2 12 0"
					fill="none"
					stroke="var(--dg-ink)"
					strokeWidth="2.2"
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

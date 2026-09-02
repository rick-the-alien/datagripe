/** MOCK chip: marks a surface as a branding placeholder until the real
 * implementation lands (docs/brand/brand-system.md). */
export function MockBadge() {
	return (
		<span className="dg-mock-badge" title="Mock — implementation follows">
			mock
		</span>
	);
}

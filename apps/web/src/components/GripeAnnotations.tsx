import type { Finding, ObjectTab } from "@datagripe/contracts";
import { MESSAGES, renderFinding, renderFooter } from "@datagripe/gripes";
import { useBrandingStore } from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { SeverityIcon } from "./icons";

/**
 * Object-scoped gripes, annotating the tab their subject lives in
 * (docs/spec/gripes.md, and the shape in
 * docs/brand/mocks/tree-interactions.html: a block above the tab's
 * table, with a severity border and a factual footer).
 *
 * Above the content rather than replacing it — the tab still has a job,
 * and a finding about an index is best read next to the indexes.
 */

export function GripeAnnotations(props: {
	findings: Finding[];
	tab: ObjectTab;
}) {
	const currentWorkspaceId = useSessionStore(
		(state) => state.currentWorkspaceId,
	);
	const attitude = useBrandingStore((state) =>
		state.attitudeFor(currentWorkspaceId),
	);

	// A finding with no tab shows on every tab; one with a tab shows only
	// there, so an index complaint does not follow you to `grants`.
	const forTab = props.findings.filter(
		(finding) =>
			finding.at.kind === "object" &&
			(finding.at.tab === undefined || finding.at.tab === props.tab),
	);
	if (forTab.length === 0) {
		return null;
	}

	return (
		<div className="dg-ov-gripes">
			{forTab.map((finding) => (
				<div
					key={finding.ruleId}
					className={`dg-gripe dg-gripe-${finding.severity} dg-ov-gripe`}
				>
					<span className="dg-gripe-glyph">
						<SeverityIcon severity={finding.severity} />
					</span>
					<span className="dg-gripe-body">
						<span className="dg-gripe-text">
							{renderFinding(finding, attitude, MESSAGES)}
						</span>
						<span className="dg-gripe-footer">{renderFooter(finding)}</span>
					</span>
				</div>
			))}
		</div>
	);
}

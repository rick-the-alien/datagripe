import type {
	AttitudeLevel,
	Dismissal,
	Finding,
	GripeSeverity,
} from "@datagripe/contracts";
import { ATTITUDE_LEVELS, isDismissed } from "@datagripe/contracts";
import {
	DISCLAIMER,
	lineOfOffset,
	MESSAGES,
	renderFinding,
	renderFooter,
} from "@datagripe/gripes";
import { revealInEditor } from "../app/editorPanels";
import { useBrandingStore } from "../stores/branding";
import { useDocumentsStore } from "../stores/documents";
import { hiddenCount, useGripesStore } from "../stores/gripes";
import { useSessionStore } from "../stores/session";
import { GripeDismiss } from "./GripeDismiss";
import { Mascot } from "./Mascot";

/**
 * Gripes panel (docs/spec/gripes.md, brand-system.md "Attitude levels").
 *
 * Severity is a 3px left border with a ~4% tint, square corners because
 * the border is single-sided, and a severity glyph so meaning survives
 * without colour — all four accents sit at similar lightness, so colour
 * alone never distinguishes two states.
 *
 * The mascot appears only in the empty state. Tier 3 is "empty state
 * only — never per-gripe": one on every finding stops being funny
 * within a day.
 */

/** The non-colour cue. Colour alone never carries meaning. */
const SEVERITY_GLYPH: Record<GripeSeverity, string> = {
	blocker: "▲",
	warning: "◆",
	style: "●",
};

const ATTITUDE_BLURB: Record<AttitudeLevel, string> = {
	notice: "No profanity. Dry, still critical.",
	warning: "Default. Blunt, swears when earned.",
	fatal: "Unfiltered. Opt-in.",
	panic: "Deliberately excessive. A joke.",
};

function GripeRow(props: {
	finding: Finding;
	attitude: AttitudeLevel;
	documentTitle: string | undefined;
	line: number | undefined;
	onDismiss: (dismissal: Dismissal) => void;
}) {
	const { finding } = props;
	// Wording is chosen here, at render, from the reader's attitude — the
	// finding itself has no prose in it.
	const text = renderFinding(finding, props.attitude, MESSAGES);
	const footer = renderFooter(
		finding,
		props.line === undefined ? {} : { line: props.line },
	);

	return (
		<div className={`dg-gripe dg-gripe-${finding.severity}`}>
			<button
				type="button"
				className="dg-gripe-main"
				onClick={() => {
					if (finding.at.kind === "document") {
						revealInEditor(finding.at.documentId, finding.at.start);
					}
				}}
			>
				<span className="dg-gripe-glyph" aria-hidden="true">
					{SEVERITY_GLYPH[finding.severity]}
				</span>
				<span className="dg-gripe-body">
					<span className="dg-gripe-text">{text}</span>
					<span className="dg-gripe-footer">
						{props.documentTitle !== undefined && `${props.documentTitle} · `}
						{footer}
					</span>
				</span>
			</button>
			<GripeDismiss finding={props.finding} onDismiss={props.onDismiss} />
		</div>
	);
}

export function GripesPanel() {
	const currentWorkspaceId = useSessionStore(
		(state) => state.currentWorkspaceId,
	);
	const attitude = useBrandingStore((state) =>
		state.attitudeFor(currentWorkspaceId),
	);
	const setAttitude = useBrandingStore((state) => state.setAttitude);
	const byDocument = useGripesStore((state) => state.byDocument);
	const dismissals = useGripesStore((state) => state.dismissals);
	const hidden = useGripesStore((state) => hiddenCount(state));
	const dismiss = useGripesStore((state) => state.dismiss);
	const restore = useGripesStore((state) => state.restore);
	const documents = useDocumentsStore((state) => state.documents);

	const groups = Object.entries(byDocument)
		.map(([documentId, findings]) => ({
			documentId,
			title: documents[documentId]?.title,
			content: documents[documentId]?.currentContent ?? "",
			findings: findings.filter((finding) => !isDismissed(finding, dismissals)),
		}))
		.filter((group) => group.findings.length > 0)
		.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));

	const total = groups.reduce((sum, group) => sum + group.findings.length, 0);

	return (
		<div className="dg-gripes">
			{total === 0 ? (
				<div className="dg-gripes-empty">
					<Mascot size={72} expression="approval" />
					<p>{hidden === 0 ? "No gripes." : "No gripes left to show."}</p>
					<p className="dg-header-meta">
						{hidden === 0
							? "Nothing worth complaining about in what is open. Give it time."
							: "Everything found here has been dismissed."}
					</p>
				</div>
			) : (
				<div className="dg-gripes-list dg-scroll">
					{groups.map((group) => (
						<div key={group.documentId} className="dg-gripe-group">
							{group.findings.map((finding) => (
								<GripeRow
									key={`${finding.ruleId}:${
										finding.at.kind === "document" ? finding.at.start : 0
									}`}
									finding={finding}
									attitude={attitude}
									onDismiss={(dismissal) => void dismiss(dismissal)}
									documentTitle={group.title}
									line={
										finding.at.kind === "document"
											? lineOfOffset(group.content, finding.at.start)
											: undefined
									}
								/>
							))}
						</div>
					))}
				</div>
			)}
			{hidden > 0 && (
				<div className="dg-gripes-hidden">
					<span>
						{hidden} hidden by {dismissals.length} dismissal
						{dismissals.length === 1 ? "" : "s"}
					</span>
					<button type="button" onClick={() => void restore()}>
						show all again
					</button>
				</div>
			)}
			<div className="dg-gripes-attitude">
				<span>Attitude</span>
				<select
					aria-label="Attitude level"
					value={attitude}
					disabled={currentWorkspaceId === null}
					onChange={(event) =>
						currentWorkspaceId !== null &&
						setAttitude(currentWorkspaceId, event.target.value as AttitudeLevel)
					}
				>
					{ATTITUDE_LEVELS.map((level) => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
				</select>
				<span>{ATTITUDE_BLURB[attitude]}</span>
			</div>
			<p className="dg-gripes-disclaimer">{DISCLAIMER}</p>
		</div>
	);
}

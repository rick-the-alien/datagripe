import type { Dismissal, DismissalScope, Finding } from "@datagripe/contracts";
import { objectTargetKey } from "@datagripe/contracts";
import { useEffect, useRef, useState } from "react";

/**
 * The dismiss control on a gripe row (docs/spec/gripes.md "Dismissal").
 *
 * Three scopes, coarsest last, phrased as what they mean rather than as
 * their names — "not in this file" is the thing someone wants; "target
 * scope" is the thing the database calls it.
 */

const SCOPE_LABEL: Record<DismissalScope, string> = {
	occurrence: "not here",
	target: "not in this file",
	project: "never in this project",
};

const OBJECT_SCOPE_LABEL: Record<DismissalScope, string> = {
	occurrence: "not here",
	target: "not on this object",
	project: "never in this project",
};

/**
 * The dismissal a scope means for this finding, or null when the scope
 * cannot apply — an occurrence dismissal needs a fingerprint, which a
 * finding with no statement behind it does not have.
 */
export function dismissalFor(
	finding: Finding,
	scope: DismissalScope,
): Dismissal | null {
	if (scope === "project") {
		return { ruleId: finding.ruleId, scope, key: null };
	}
	if (scope === "occurrence") {
		return finding.fingerprint === undefined
			? null
			: { ruleId: finding.ruleId, scope, key: finding.fingerprint };
	}
	if (finding.at.kind === "document") {
		return { ruleId: finding.ruleId, scope, key: finding.at.documentId };
	}
	if (finding.at.kind === "object") {
		return {
			ruleId: finding.ruleId,
			scope,
			key: objectTargetKey(finding.at.schema, finding.at.name),
		};
	}
	return null;
}

export function GripeDismiss(props: {
	finding: Finding;
	onDismiss: (dismissal: Dismissal) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (rootRef.current?.contains(event.target as Node) === true) {
				return;
			}
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const labels =
		props.finding.at.kind === "object" ? OBJECT_SCOPE_LABEL : SCOPE_LABEL;
	const scopes: DismissalScope[] = ["occurrence", "target", "project"];

	return (
		<span className="dg-gripe-dismiss" ref={rootRef}>
			<button
				type="button"
				className="dg-tv-ico"
				aria-expanded={open}
				aria-label={`Dismiss ${props.finding.ruleId}`}
				title="Dismiss"
				onClick={(event) => {
					// The row itself reveals the finding in the editor.
					event.stopPropagation();
					setOpen((value) => !value);
				}}
			>
				×
			</button>
			{open && (
				<div className="dg-exp-fmt dg-gripe-dismiss-menu dg-scroll" role="menu">
					<div className="dg-exp-fmt-hd">stop telling me</div>
					{scopes.map((scope) => {
						const dismissal = dismissalFor(props.finding, scope);
						return (
							<button
								key={scope}
								type="button"
								role="menuitem"
								className="dg-exp-fmt-it"
								disabled={dismissal === null}
								onClick={(event) => {
									event.stopPropagation();
									setOpen(false);
									if (dismissal !== null) {
										props.onDismiss(dismissal);
									}
								}}
							>
								<span className="dg-exp-fmt-tick" />
								{labels[scope]}
							</button>
						);
					})}
				</div>
			)}
		</span>
	);
}

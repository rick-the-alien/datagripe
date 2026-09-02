import type { IDockviewPanelProps } from "dockview-react";
import { useRef, useState } from "react";
import { readViewPanelParams } from "../app/viewPanels";
import {
	PROJECT_CLASS_COLORS,
	type ProjectClass,
	useBrandingStore,
} from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { MockBadge } from "./MockBadge";

const STRUCTURE_TABS = [
	"columns",
	"indexes",
	"constraints",
	"triggers",
	"grants",
	"statistics",
	"ddl",
] as const;

const TAB_BLURBS: Record<(typeof STRUCTURE_TABS)[number], string> = {
	columns: "Column names, types, nullability, defaults and comments.",
	indexes: "Index definitions, sizes, usage and bloat estimates.",
	constraints: "Primary keys, foreign keys, uniques and checks.",
	triggers: "Triggers with their timing, events and functions.",
	grants: "Who can do what to this object.",
	statistics: "Planner statistics and histogram summaries.",
	ddl: "The full CREATE statement, ready to copy.",
};

/**
 * Danger zone gating (brand-system.md "Danger zone"), implemented for
 * real because the interaction is the spec: reveal → type the object
 * name (production: the project name) → execute enables on exact match.
 * Execution itself is a mock no-op until the server supports it.
 */
function DangerAction(props: {
	action: "truncate" | "drop";
	objectName: string;
	projectClass: ProjectClass;
	projectName: string;
}) {
	const [typed, setTyped] = useState("");
	const [done, setDone] = useState(false);
	const expected =
		props.projectClass === "production" ? props.projectName : props.objectName;
	const armed = typed === expected;

	return (
		<details className="dg-danger-action">
			<summary>
				{props.action} {props.objectName}
			</summary>
			<div className="dg-danger-detail">
				{props.action === "truncate" ? (
					<span>
						Removes every row and keeps the structure. Cascades to referencing
						tables. Nothing here is undoable.
					</span>
				) : (
					<span>
						Removes the object and everything that depends on it. Nothing here
						is undoable.
					</span>
				)}
				<span>
					Type <code>{expected}</code> to confirm
					{props.projectClass === "production" &&
						" — production confirms with the project name, not the table"}
					.
				</span>
				<input
					value={typed}
					onChange={(event) => {
						setTyped(event.target.value);
						setDone(false);
					}}
					placeholder={expected}
					aria-label={`Type ${expected} to confirm ${props.action}`}
				/>
				<button
					type="button"
					className="dg-danger-execute"
					disabled={!armed}
					onClick={() => {
						setDone(true);
						setTyped("");
					}}
				>
					{props.action}
				</button>
				{done && (
					<span className="dg-modal-hint">
						Mock — nothing happened. Execution lands with the real table view.
					</span>
				)}
			</div>
		</details>
	);
}

/**
 * MOCK — object view (brand-system.md "Table view and object view"):
 * structure tabs with the danger zone pushed to the right edge. Tab
 * content is placeholder; the danger-zone gating interaction is real.
 */
export function ObjectView(props: IDockviewPanelProps) {
	const params = readViewPanelParams(props.params);
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const projectClass = useBrandingStore((state) =>
		state.classFor(currentWorkspace?.id ?? null),
	);
	const initialTab = params.tab ?? "columns";
	const [tab, setTab] = useState<string>(
		[...STRUCTURE_TABS, "danger"].includes(
			initialTab as (typeof STRUCTURE_TABS)[number] | "danger",
		)
			? initialTab
			: "columns",
	);

	// Deep-links (context menu → indexes) retarget an already-open panel —
	// but only when the param actually changes, otherwise the deep link
	// would override every manual tab switch.
	const appliedDeepLink = useRef(params.tab);
	if (params.tab !== appliedDeepLink.current) {
		appliedDeepLink.current = params.tab;
		if (
			params.tab !== undefined &&
			[...STRUCTURE_TABS, "danger"].includes(
				params.tab as (typeof STRUCTURE_TABS)[number] | "danger",
			)
		) {
			setTab(params.tab);
		}
	}

	const readOnly = projectClass === "analytics";

	return (
		<div className="dg-mockview">
			<div className="dg-mockview-tabs" role="tablist">
				{STRUCTURE_TABS.map((value) => (
					<button
						key={value}
						type="button"
						className="dg-mockview-tab"
						role="tab"
						aria-selected={tab === value}
						onClick={() => setTab(value)}
					>
						{value}
					</button>
				))}
				<button
					type="button"
					className="dg-mockview-tab dg-mockview-tab-danger"
					role="tab"
					aria-selected={tab === "danger"}
					disabled={readOnly}
					title={readOnly ? "Read-only replica — writes are blocked" : ""}
					onClick={() => setTab("danger")}
				>
					danger zone
				</button>
			</div>
			<div className="dg-mockview-body dg-scroll">
				{tab !== "danger" ? (
					<>
						<p>
							<MockBadge /> {params.name} · {tab}
						</p>
						<p>{TAB_BLURBS[tab as (typeof STRUCTURE_TABS)[number]]}</p>
						<p>
							Content lands with the real object view. There is deliberately no
							data tab — rows live in the table view.
						</p>
					</>
				) : (
					<>
						<p>
							<MockBadge /> Danger zone ·{" "}
							<span style={{ color: PROJECT_CLASS_COLORS[projectClass] }}>
								{projectClass}
							</span>{" "}
							project
						</p>
						{readOnly ? (
							<p>
								Disabled — this is a read-only analytics replica. Write
								statements are blocked outright.
							</p>
						) : (
							<div className="dg-danger-list">
								<DangerAction
									action="truncate"
									objectName={params.name}
									projectClass={projectClass}
									projectName={currentWorkspace?.name ?? ""}
								/>
								<DangerAction
									action="drop"
									objectName={params.name}
									projectClass={projectClass}
									projectName={currentWorkspace?.name ?? ""}
								/>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

import { type ReactNode, useState } from "react";

/**
 * The tab rail (docs/brand/mocks/datasource-settings.html "Width").
 *
 * A form column plus a rail that earns the leftover space, rather than a
 * capped column with a dead band beside it. The rail is what turns a
 * wide pane from "this form is unfinished" into "this pane is wide for a
 * reason".
 *
 * Two kinds of pane live here and any tab may have either or both:
 *
 * - **info** — live state about the thing on screen. Connection status,
 *   the resolved connection string, the test log.
 * - **help** — what the fields mean and how the tab fits with the
 *   others. Every tab can carry one, and where a tab has both the rail
 *   toggles between them rather than stacking two columns.
 *
 * The rail collapses below `--dg-rail-breakpoint` of *pane* width — a
 * container query, not a viewport one, because a tab docked at a third
 * of the window is narrow no matter how wide the monitor is. Nothing is
 * lost when it collapses; it stacks under the form.
 *
 * It can also be folded away by hand, with the chevron that sits in the
 * divider. The divider is the handle: a rail you cannot dismiss is a
 * rail that eventually annoys, and a dismiss button somewhere else in
 * the chrome would be one more thing to find. Folding is only offered in
 * the two-column layout — stacked, there is no side to fold it away to,
 * so the rail stays and the handle is not rendered.
 */

/** One shell per tab, so a fixed id is enough for `aria-controls`. */
const RAIL_ID = "dg-tab-rail";

export interface RailPane {
	/** Stable id, also the toggle's label. */
	id: string;
	label: string;
	node: ReactNode;
}

export function TabShell(props: {
	/** Panes in order; the first is the default. Empty renders no rail. */
	rail?: RailPane[];
	className?: string;
	children: ReactNode;
}) {
	const panes = props.rail ?? [];
	const [activeId, setActiveId] = useState<string | null>(null);
	const [folded, setFolded] = useState(false);
	const active = panes.find((pane) => pane.id === activeId) ?? panes[0] ?? null;

	return (
		<div className="dg-form dg-scroll">
			<div
				className={[
					"dg-tabshell",
					panes.length === 0 ? "dg-tabshell-bare" : "",
					folded ? "dg-tabshell-folded" : "",
				]
					.filter((name) => name !== "")
					.join(" ")}
			>
				<div className={props.className ?? "dg-form-body"}>
					{props.children}
				</div>
				{active !== null && (
					<button
						type="button"
						className="dg-rail-handle"
						aria-expanded={!folded}
						aria-controls={RAIL_ID}
						aria-label={folded ? "Show the rail" : "Hide the rail"}
						title={folded ? "Show the rail" : "Hide the rail"}
						onClick={() => setFolded((value) => !value)}
					>
						<span className="dg-rail-handle-chev">{folded ? "‹" : "›"}</span>
					</button>
				)}
				{/* Rendered even when folded, and hidden in CSS: folding is a
				    two-column affordance, so a pane that narrows back to the
				    stacked layout shows its rail again rather than losing it
				    behind a handle that is no longer there. */}
				{active !== null && (
					<aside className="dg-rail" id={RAIL_ID} aria-label="Tab rail">
						{/* One pane needs no chooser: a toggle with a single option
						    is a label that looks clickable. */}
						{panes.length > 1 && (
							<div className="dg-rail-switch" role="tablist">
								{panes.map((pane) => (
									<button
										key={pane.id}
										type="button"
										role="tab"
										aria-selected={pane.id === active.id}
										className={
											pane.id === active.id
												? "dg-rail-tab dg-rail-tab-on"
												: "dg-rail-tab"
										}
										onClick={() => setActiveId(pane.id)}
									>
										{pane.label}
									</button>
								))}
							</div>
						)}
						<div className="dg-rail-body">{active.node}</div>
					</aside>
				)}
			</div>
		</div>
	);
}

/** A rail section heading. */
export function RailSection(props: { title: string; children: ReactNode }) {
	return (
		<section className="dg-rail-section">
			<h4>{props.title}</h4>
			{props.children}
		</section>
	);
}

/** A label/value line in an info rail. */
export function RailFact(props: {
	label: string;
	value: ReactNode;
	/** Explicit `undefined` allowed so a caller can compute it inline
	 * under `exactOptionalPropertyTypes`. */
	tone?: "ok" | "bad" | "dim" | undefined;
}) {
	return (
		<div className="dg-rail-kv">
			<span>{props.label}</span>
			<b
				className={
					props.tone === undefined ? undefined : `dg-rail-${props.tone}`
				}
			>
				{props.value}
			</b>
		</div>
	);
}

/**
 * Help prose. Deliberately plain product voice, not the gripe voice —
 * "if the whole interface is sarcastic then nothing is".
 */
export function RailHelp(props: { children: ReactNode }) {
	return <div className="dg-rail-help">{props.children}</div>;
}

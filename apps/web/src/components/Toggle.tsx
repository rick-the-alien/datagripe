/**
 * A labelled toggle (docs/brand/mocks/datasource-settings.html
 * "behaviour").
 *
 * Replaces the bare checkbox for settings that need explaining. The mock
 * names the problem it solves: read-only and show-all-schemas were both
 * checkboxes, but one is a connection constraint and the other a display
 * preference — same control, different meaning, no grouping, and the
 * explanation orphaned somewhere below. Here the description is attached
 * to the control and capped to a reading measure.
 *
 * A real `<button aria-pressed>` rather than a styled `<input>`: the
 * switch has no indeterminate state and the whole row is the target.
 */
export function Toggle(props: {
	on: boolean;
	title: string;
	description: string;
	disabled?: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<div className="dg-tog">
			<button
				type="button"
				className="dg-sw"
				aria-pressed={props.on}
				aria-label={props.title}
				disabled={props.disabled ?? false}
				onClick={() => props.onChange(!props.on)}
			>
				<i />
			</button>
			<div className="dg-tog-tx">
				<b>{props.title}</b>
				<span>{props.description}</span>
			</div>
		</div>
	);
}

import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import {
	PROJECT_CLASS_COLORS,
	PROJECT_CLASSES,
	type ProjectClass,
	useBrandingStore,
} from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { MockBadge } from "./MockBadge";

/**
 * New-project form as a dock tab (docs/brand/mocks/
 * datasource-selector.html — forms are tabs, not modals). Creating a
 * project switches straight into it; the class is the mock branding
 * field that decides the project accent colour.
 */
export function NewProjectForm(props: IDockviewPanelProps) {
	const setClass = useBrandingStore((state) => state.setClass);
	const [name, setName] = useState("");
	const [projectClass, setProjectClass] = useState<ProjectClass>("local");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const workspace = await useSessionStore
				.getState()
				.createWorkspace(name.trim());
			setClass(workspace.id, projectClass);
			// The workspace switch replaces the layout wholesale; close the
			// tab explicitly for the edge case where the switch no-ops.
			props.api.close();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Create failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="dg-form dg-scroll">
			<form
				className="dg-form-body"
				onSubmit={(event) => {
					event.preventDefault();
					if (name.trim().length > 0 && !busy) {
						void create();
					}
				}}
			>
				<h3 className="dg-form-title">New project</h3>
				<p className="dg-form-lead">
					A project holds datasources, shared files and members. Rename it and
					add people later in project settings.
				</p>

				<div className="dg-fgrid">
					<label className="dg-field">
						<span>Name</span>
						<input
							value={name}
							ref={(input) => input?.focus()}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
				</div>

				<fieldset className="dg-field">
					<legend>
						Class <MockBadge />
					</legend>
					<div className="dg-cls">
						{PROJECT_CLASSES.map((value) => (
							<button
								key={value}
								type="button"
								style={
									{
										"--cc": PROJECT_CLASS_COLORS[value],
									} as React.CSSProperties
								}
								aria-pressed={projectClass === value}
								onClick={() => setProjectClass(value)}
							>
								<span className="dg-cls-sw" />
								{value}
							</button>
						))}
					</div>
					<p className="dg-form-note">
						The class sets the project accent — production is magenta, so the
						safety colour is visible before a statement runs.
					</p>
				</fieldset>

				{error !== null && <p className="dg-test-failed">{error}</p>}
				<div className="dg-frow">
					<button
						type="submit"
						className="dg-btn dg-btn-pri"
						disabled={name.trim().length === 0 || busy}
					>
						{busy ? "creating…" : "create project"}
					</button>
				</div>
			</form>
		</div>
	);
}

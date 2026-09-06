import { type AttitudeLevel, useBrandingStore } from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { Mascot } from "./Mascot";
import { MockBadge } from "./MockBadge";

const ATTITUDE_LEVELS: AttitudeLevel[] = [
	"notice",
	"warning",
	"fatal",
	"panic",
];

/**
 * MOCK — gripes panel (brand-system.md "Mascot" tier 3, "Attitude
 * levels"; designed in docs/spec/gripes.md). The rule catalogue does not
 * exist yet, so this is the empty state: faint approval, and the
 * attitude selector that will govern it.
 */
export function GripesPanel() {
	const currentWorkspaceId = useSessionStore(
		(state) => state.currentWorkspaceId,
	);
	const attitude = useBrandingStore((state) =>
		state.attitudeFor(currentWorkspaceId),
	);
	const setAttitude = useBrandingStore((state) => state.setAttitude);

	return (
		<div className="dg-gripes">
			<div className="dg-gripes-empty">
				<Mascot size={72} expression="approval" />
				<p>
					No gripes. <MockBadge />
				</p>
				<p className="dg-header-meta">
					The linter has opinions and no manners. Once the rule catalogue ships,
					they show up here.
				</p>
			</div>
			<div className="dg-gripes-attitude">
				<span>
					Attitude <MockBadge />
				</span>
				<select
					aria-label="Attitude level (mock)"
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
				<span>
					{attitude === "notice" && "No profanity. Dry, still critical."}
					{attitude === "warning" && "Default. Blunt, swears when earned."}
					{attitude === "fatal" && "Unfiltered. Opt-in."}
					{attitude === "panic" && "Deliberately excessive. A joke."}
				</span>
			</div>
		</div>
	);
}

/**
 * The painted mascot set (docs/brand/brand-system.md "Two asset sets, not
 * one"): the rendered illustrations, for chrome that never animates —
 * empty states, splash, error pages. `Mascot` is the other set, the flat
 * rig meant for animation, and the two are deliberately not the same
 * asset.
 *
 * Every pose lives here so the set is registered in one place, and each
 * is loaded by URL out of `public/mascot/` (a copy of `brand/mascot/`,
 * see brand/README.md) rather than inlined. Inlining
 * would put ~90kB of paths per pose into the bundle whether or not it
 * renders, collide the poses' gradient ids with each other, and buy
 * nothing back: the paint is baked, so there is no custom property for
 * CSS to reach.
 */

/** Intrinsic size per pose, so an empty state does not reflow on load. */
const POSES = {
	/** Heavy lids, unimpressed. Nothing is wrong, nothing is happening. */
	"nothing-open": { width: 482, height: 542 },
	/** Resigned. Nothing to complain about, and not thrilled about it. */
	"no-gripes": { width: 534, height: 536 },
	/** Facepalm. */
	"oh-my": { width: 514, height: 534 },
	shocked: { width: 566, height: 550 },
	shouting: { width: 566, height: 522 },
} as const;

export type MascotPose = keyof typeof POSES;

export function MascotArt(props: {
	pose: MascotPose;
	/** Rendered height in px; width follows the pose's own ratio. */
	size?: number;
	/**
	 * Empty by default: these appear beside text that already says what
	 * the state is, and a screen reader reading the barrel's mood twice
	 * is worse than not reading it at all. Pass one when the mascot is
	 * the only thing carrying the meaning.
	 */
	alt?: string;
}) {
	const height = props.size ?? 120;
	const pose = POSES[props.pose];
	const width = Math.round((pose.width / pose.height) * height);

	return (
		<img
			className="dg-mascot-art"
			src={`/mascot/${props.pose}.svg`}
			alt={props.alt ?? ""}
			width={width}
			height={height}
			draggable={false}
		/>
	);
}

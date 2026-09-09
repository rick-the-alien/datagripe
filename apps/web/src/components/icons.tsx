import type { GripeSeverity } from "@datagripe/contracts";
import {
	ArrowDown,
	ArrowDownToLine,
	ArrowUp,
	Check,
	ChevronDown,
	ChevronRight,
	Circle,
	Copy,
	Diamond,
	Download,
	Ellipsis,
	FolderSync,
	Group,
	Image,
	KeyRound,
	LayoutGrid,
	LoaderCircle,
	type LucideIcon,
	type LucideProps,
	Pencil,
	Play,
	Plus,
	RotateCcw,
	RotateCw,
	Settings,
	SkipForward,
	Table2,
	Trash,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactElement } from "react";

/**
 * The icon family (docs/brand/brand-system.md "Icons"): Lucide, ISC, a
 * line family drawn on a 24px grid.
 *
 * Every call site imports from here and never from `lucide-react`
 * directly. Two reasons: the set is a brand decision and this module is
 * the one place it can be swapped, and the names here say what the mark
 * *means* in Datagripe — `IconAccess`, not `KeyRound` — so a later swap
 * is a change to this file rather than forty call sites.
 *
 * The tree's per-kind type icons are *not* from this family. Those are
 * hand-drawn at 16px in `Explorer.tsx` (cylinder, table, view, sequence)
 * because a database object's mark is brand, not chrome.
 */

/** Chrome scale. The grid is drawn for 24px; our densest rows run at 14. */
const SIZE = 14;

/**
 * Lucide's 2px default is drawn for 24px. Held at 14px on Void the
 * counters close up and every icon reads as the same grey blob, so the
 * whole family runs lighter.
 */
const STROKE = 1.5;

function icon(Glyph: LucideIcon, defaults: LucideProps = {}) {
	function Wrapped({ className, ...rest }: LucideProps) {
		return (
			<Glyph
				aria-hidden={true}
				size={SIZE}
				strokeWidth={STROKE}
				{...defaults}
				{...rest}
				className={className === undefined ? "dg-icon" : `dg-icon ${className}`}
			/>
		);
	}
	return Wrapped;
}

export type IconComponent = (props: LucideProps) => ReactElement;

/* ---- disclosure ------------------------------------------------------ */

export const IconChevronDown = icon(ChevronDown, { size: 12 });
export const IconChevronRight = icon(ChevronRight, { size: 12 });

/* ---- acts ------------------------------------------------------------ */

export const IconAdd = icon(Plus);
export const IconClose = icon(X, { size: 13 });
export const IconRefresh = icon(RotateCw);
export const IconEdit = icon(Pencil, { size: 13 });
export const IconSettings = icon(Settings);
export const IconMore = icon(Ellipsis);
export const IconCheck = icon(Check, { size: 12 });
export const IconDownload = icon(Download);
export const IconCopy = icon(Copy);
/** Reading a datasource *out of* a repository, as opposed to typing one. */
export const IconImport = icon(ArrowDownToLine);
export const IconRun = icon(Play, { size: 13 });
export const IconRunAll = icon(SkipForward, { size: 13 });
/** Undo a staged drop — the column comes back. */
export const IconUndo = icon(RotateCcw, { size: 13 });
export const IconDrop = icon(Trash, { size: 13 });

/* ---- state ----------------------------------------------------------- */

/** Spins. Used where a click has been registered but not yet answered. */
export const IconSpinner = icon(LoaderCircle, {
	size: 12,
	className: "dg-icon-spin",
});
export const IconRunning = icon(Circle, { size: 8 });
export const IconSortAsc = icon(ArrowUp, { size: 11 });
export const IconSortDesc = icon(ArrowDown, { size: 11 });
export const IconAhead = icon(ArrowUp, { size: 11 });
export const IconBehind = icon(ArrowDown, { size: 11 });

/* ---- the nouns of the app -------------------------------------------- */

export const IconDomains = icon(Group);
export const IconSync = icon(FolderSync);
export const IconAccess = icon(KeyRound);
export const IconTable = icon(Table2);
export const IconObject = icon(LayoutGrid);
export const IconImage = icon(Image);

/* ---- severity -------------------------------------------------------- */

/**
 * The non-colour cue for severity (brand-system.md "Colour"): all four
 * accents sit at similar lightness, so colour alone never distinguishes
 * two states. Shape carries the meaning; the accent only reinforces it.
 *
 * One record, shared by the gripes panel, the object-view annotation and
 * the tab mark — three copies of this drifted apart once already.
 */
const SEVERITY_ICONS: Record<GripeSeverity, IconComponent> = {
	blocker: icon(TriangleAlert, { size: 12 }),
	warning: icon(Diamond, { size: 12 }),
	style: icon(Circle, { size: 12 }),
};

export function SeverityIcon({
	severity,
	...rest
}: { severity: GripeSeverity } & LucideProps) {
	const Glyph = SEVERITY_ICONS[severity];
	return <Glyph {...rest} />;
}

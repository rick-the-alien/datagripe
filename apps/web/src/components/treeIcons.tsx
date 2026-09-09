import type { SchemaNode } from "@datagripe/contracts";
import type { ReactNode } from "react";

/**
 * The tree's per-kind type marks.
 *
 * These are **not** from the Lucide family in `icons.tsx` (see
 * docs/brand/brand-system.md "Icons"): a database object's mark is brand,
 * drawn at 16px against the row it labels and coloured by kind. The
 * schema tree and the domain tree show the same objects, so they share
 * this module rather than each inventing a glyph.
 */

/** Brand tree colouring: categories carry the accent, leaves stay
 * neutral so a wide schema does not turn into confetti. */
export const KIND_COLORS: Record<SchemaNode["kind"], string> = {
	schema: "#5EEAD4",
	tables: "#8B5CF6",
	views: "#FF3EA5",
	functions: "#5EEAD4",
	procedures: "#5EEAD4",
	sequences: "#5EEAD4",
	table: "#9AA5B6",
	view: "#9AA5B6",
	function: "#9AA5B6",
	procedure: "#9AA5B6",
	sequence: "#9AA5B6",
	column: "#3D4759",
	db: "#9AA5B6",
	prefix: "#8B5CF6",
	key: "#A78BFA",
};

function CylinderIcon({ color }: { color: string }) {
	return (
		<>
			<path
				d="M8 2.5c-3.04 0-5.5.9-5.5 2v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7c0-1.1-2.46-2-5.5-2Z"
				fill={color}
				fillOpacity="0.25"
				stroke={color}
				strokeWidth="1.2"
			/>
			<path
				d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2"
				fill="none"
				stroke={color}
				strokeWidth="1.2"
			/>
		</>
	);
}

function FolderIcon({ color }: { color: string }) {
	return (
		<path
			d="M2 4.8c0-.9.7-1.6 1.6-1.6h2.9l1.4 1.7h4.5c.9 0 1.6.7 1.6 1.6v4.9c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6Z"
			fill={color}
			fillOpacity="0.2"
			stroke={color}
			strokeWidth="1.2"
		/>
	);
}

function TableIcon({ color }: { color: string }) {
	return (
		<>
			<rect
				x="2"
				y="3"
				width="12"
				height="10"
				rx="1.5"
				fill={color}
				fillOpacity="0.2"
				stroke={color}
				strokeWidth="1.2"
			/>
			<path
				d="M2 6.3h12M2 9.6h12M7 3v10"
				fill="none"
				stroke={color}
				strokeWidth="1.2"
			/>
		</>
	);
}

function ViewIcon({ color }: { color: string }) {
	return (
		<>
			<path
				d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z"
				fill={color}
				fillOpacity="0.15"
				stroke={color}
				strokeWidth="1.2"
			/>
			<circle cx="8" cy="8" r="1.8" fill={color} />
		</>
	);
}

function TextIcon({ color, text }: { color: string; text: string }) {
	return (
		<text
			x="8"
			y="12"
			textAnchor="middle"
			fontSize="9"
			fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
			fontWeight="700"
			fill={color}
		>
			{text}
		</text>
	);
}

function SequenceIcon({ color }: { color: string }) {
	return (
		<path
			d="M2 4h3.5M2 8h3.5M2 12h3.5M8.5 4H14M8.5 8H14M8.5 12H14"
			fill="none"
			stroke={color}
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	);
}

function ColumnIcon({ color }: { color: string }) {
	return (
		<path
			d="M4.5 3.5v9M8 3.5v6M11.5 3.5v3"
			fill="none"
			stroke={color}
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	);
}

function KeyIcon({ color }: { color: string }) {
	return (
		<>
			<circle
				cx="5"
				cy="5.5"
				r="2.5"
				fill="none"
				stroke={color}
				strokeWidth="1.3"
			/>
			<path
				d="M6.8 7.3 13 13.5M10.5 10.5l2-2M12.5 12.5l1.5-1.5"
				fill="none"
				stroke={color}
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
		</>
	);
}

/**
 * The per-kind type mark. Hand-drawn rather than taken from the icon
 * family in `icons.tsx`: a database object's mark is brand (brand-system.md
 * "Tree"), and the domain tree shows the same objects, so it shows the
 * same marks.
 */
export function TreeIcon(props: { kind: SchemaNode["kind"]; color?: string }) {
	const color = props.color ?? KIND_COLORS[props.kind];
	let body: ReactNode;
	switch (props.kind) {
		case "db":
		case "schema":
			body = <CylinderIcon color={color} />;
			break;
		case "tables":
		case "views":
		case "functions":
		case "procedures":
		case "sequences":
		case "prefix":
			body = <FolderIcon color={color} />;
			break;
		case "table":
			body = <TableIcon color={color} />;
			break;
		case "view":
			body = <ViewIcon color={color} />;
			break;
		case "function":
			body = <TextIcon color={color} text="fx" />;
			break;
		case "procedure":
			body = <TextIcon color={color} text="pr" />;
			break;
		case "sequence":
			body = <SequenceIcon color={color} />;
			break;
		case "key":
			body = <KeyIcon color={color} />;
			break;
		default:
			body = <ColumnIcon color={color} />;
	}
	return (
		<svg className="dg-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
			{body}
		</svg>
	);
}

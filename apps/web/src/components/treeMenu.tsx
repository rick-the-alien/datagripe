import type {
	DomainTarget,
	ObjectKind,
	SchemaNode,
} from "@datagripe/contracts";
import {
	domainTargetKey,
	isRelationKind,
	tabsForKind,
} from "@datagripe/contracts";
import { useEffect, useState } from "react";
import type { ObjectTarget } from "../app/viewPanels";
import {
	openDomainManager,
	openObjectView,
	openTableView,
} from "../app/viewPanels";
import {
	domainColourVar,
	selectDomains,
	useDomainsStore,
} from "../stores/domains";
import { useTreeUi } from "../stores/treeUi";
import { IconCheck, IconChevronRight } from "./icons";

/**
 * The tree context menu, shared by both sidebar modes.
 *
 * Its own module because there are two trees. The schema tree and the
 * grouped tree show the same objects and owe the same menu — the grouped
 * tree shipped without one, and "right click does nothing here" is the
 * kind of gap a user reads as the feature being half-built.
 */

/* ---- context menu ----------------------------------------------------
 * Structural entries deep-link into the object view (brand-system.md
 * "Context menu").
 */

/** Narrow a tree node kind to the object kinds the object view takes. */
export function objectKindOf(kind: SchemaNode["kind"]): ObjectKind {
	switch (kind) {
		case "view":
		case "function":
		case "procedure":
		case "sequence":
			return kind;
		default:
			return "table";
	}
}

/**
 * The `domain ▸` submenu (docs/spec/domains.md "Context menu").
 *
 * Each item carries its own colour rail and a check on the current
 * domain. `untag` appears only when the object is tagged, because an
 * item that does nothing is worse than no item.
 */
function DomainSubmenu(props: {
	connectionRef: string;
	target: ObjectTarget;
	onClose: () => void;
}) {
	const domains = useDomainsStore(selectDomains(props.connectionRef));
	const currentId = useDomainsStore(
		(state) =>
			state.tagsByConnection[props.connectionRef]?.[
				domainTargetKey({
					schema: props.target.schema,
					name: props.target.name,
					kind: props.target.kind,
				})
			] ?? null,
	);
	const tag = useDomainsStore((state) => state.tag);
	const multiSelected = useTreeUi((state) => state.multiSelected);
	const clearMulti = useTreeUi((state) => state.clearMulti);
	const [open, setOpen] = useState(false);

	const own: DomainTarget = {
		schema: props.target.schema,
		name: props.target.name,
		kind: props.target.kind,
	};
	// With a multi-selection live the submenu applies to all of it. The
	// right-clicked row joins in even if it was not part of the selection,
	// because it is what the pointer is on.
	const selection = Object.values(multiSelected);
	const targets =
		selection.length === 0
			? [own]
			: selection.some(
						(entry) => domainTargetKey(entry) === domainTargetKey(own),
					)
				? selection
				: [...selection, own];

	const assign = (domainId: string | null) => {
		props.onClose();
		clearMulti();
		void tag(props.connectionRef, targets, domainId);
	};

	return (
		<div
			className="dg-context-sub"
			role="none"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				className="dg-context-item"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{targets.length > 1 ? `domain (${targets.length} objects)` : "domain"}{" "}
				<span className="dg-context-chevron">
					<IconChevronRight />
				</span>
			</button>
			{open && (
				<div className="dg-context-menu dg-context-submenu" role="menu">
					{domains.length === 0 && (
						<div className="dg-context-note">no domains yet</div>
					)}
					{domains.map((domain) => (
						<button
							key={domain.id}
							type="button"
							className="dg-context-item dg-context-domain"
							role="menuitemradio"
							aria-checked={targets.length === 1 && domain.id === currentId}
							style={
								{
									"--dg-domain-rail": domainColourVar(domain.colour),
								} as React.CSSProperties
							}
							onClick={() => assign(domain.id)}
						>
							{domain.name}
							{/* Mixed current domains show no check: a tick that only
							    described one of seven objects would be a lie. */}
							{targets.length === 1 && domain.id === currentId && <IconCheck />}
						</button>
					))}
					{(currentId !== null || targets.length > 1) && (
						<>
							<div className="dg-context-separator" />
							<button
								type="button"
								className="dg-context-item"
								role="menuitem"
								onClick={() => assign(null)}
							>
								untag
							</button>
						</>
					)}
					<div className="dg-context-separator" />
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openDomainManager(props.connectionRef);
						}}
					>
						new domain…
					</button>
				</div>
			)}
		</div>
	);
}

export function ContextMenu(props: {
	x: number;
	y: number;
	target: ObjectTarget;
	onClose: () => void;
}) {
	const relation = isRelationKind(props.target.kind);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				props.onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mousedown", props.onClose);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mousedown", props.onClose);
		};
	}, [props.onClose]);

	return (
		<div
			className="dg-context-menu"
			role="menu"
			style={{ top: props.y, left: props.x }}
			onMouseDown={(event) => event.stopPropagation()}
		>
			{relation && (
				<>
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openTableView(props.target);
						}}
					>
						view rows <kbd>dbl click</kbd>
					</button>
					<div className="dg-context-separator" />
				</>
			)}
			{tabsForKind(props.target.kind).map((tab) => (
				<button
					key={tab}
					type="button"
					className="dg-context-item"
					role="menuitem"
					onClick={() => {
						props.onClose();
						openObjectView(props.target, tab);
					}}
				>
					{tab}
					{!relation && tab === "ddl" && <kbd>dbl click</kbd>}
				</button>
			))}
			<div className="dg-context-separator" />
			<DomainSubmenu
				connectionRef={props.target.connectionId}
				target={props.target}
				onClose={props.onClose}
			/>
			<button
				type="button"
				className="dg-context-item"
				role="menuitem"
				onClick={() => {
					props.onClose();
					void navigator.clipboard.writeText(props.target.name);
				}}
			>
				copy name
			</button>
			{relation && (
				<>
					<div className="dg-context-separator" />
					<button
						type="button"
						className="dg-context-item dg-context-danger"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openObjectView(props.target, "danger");
						}}
					>
						danger zone…
					</button>
				</>
			)}
		</div>
	);
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The right-click menu over a grid cell (docs/spec/table-view.md
 * "The cell menu"). Presentation only: the caller builds the item list,
 * so the menu never has to know what a cell, a row or an edit is.
 */

export interface CellMenuItem {
	label: string;
	/** The keyboard route to the same action, when there is one. */
	kbd?: string | undefined;
	onSelect: () => void;
	disabled?: boolean | undefined;
	danger?: boolean | undefined;
	/** A rule above this item, grouping what follows. */
	separatorBefore?: boolean | undefined;
	/** Why the item is disabled, or what it will do. */
	title?: string | undefined;
}

/** Kept off the viewport edge by this much when the menu is flipped. */
const EDGE_GAP = 8;

export function CellMenu(props: {
	x: number;
	y: number;
	items: CellMenuItem[];
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState({ x: props.x, y: props.y });

	// A cell near the right or bottom edge would open a menu that runs off
	// screen, and the grid is a scroll container, so it cannot be scrolled
	// into view. Measure once and flip back over the click point.
	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (menu === null) {
			return;
		}
		const { width, height } = menu.getBoundingClientRect();
		setPosition({
			x:
				props.x + width > window.innerWidth - EDGE_GAP
					? Math.max(EDGE_GAP, props.x - width)
					: props.x,
			y:
				props.y + height > window.innerHeight - EDGE_GAP
					? Math.max(EDGE_GAP, props.y - height)
					: props.y,
		});
	}, [props.x, props.y]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				props.onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mousedown", props.onClose);
		window.addEventListener("resize", props.onClose);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mousedown", props.onClose);
			window.removeEventListener("resize", props.onClose);
		};
	}, [props.onClose]);

	// Dockview panels set `contain: layout`, which would make `position:
	// fixed` panel-relative rather than viewport-relative — so the menu is
	// portalled to the body and positioned from the click's viewport
	// coordinates (same reason as the results panel's target popover).
	return createPortal(
		<div
			ref={menuRef}
			className="dg-context-menu dg-cell-menu"
			role="menu"
			style={{ top: position.y, left: position.x }}
			onMouseDown={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.preventDefault()}
		>
			{props.items.map((item) => (
				<div key={item.label} className="dg-cell-menu-slot">
					{item.separatorBefore === true && (
						<div className="dg-context-separator" />
					)}
					<button
						type="button"
						role="menuitem"
						className={
							item.danger === true
								? "dg-context-item dg-context-danger"
								: "dg-context-item"
						}
						disabled={item.disabled === true}
						title={item.title}
						onClick={() => {
							props.onClose();
							item.onSelect();
						}}
					>
						{item.label}
						{item.kbd !== undefined && <kbd>{item.kbd}</kbd>}
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
}

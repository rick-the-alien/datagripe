import type { ConnectionMetadata } from "@datagripe/contracts";
import { useEffect, useRef, useState } from "react";
import { openConnectionForm } from "../app/viewPanels";
import {
	defaultNamespace,
	ENGINE_CHIPS,
	NAMESPACE_LABELS,
	useDatasourceStore,
} from "../stores/datasource";
import {
	nodeKey,
	useConnectionsStore,
	useExplorerStore,
} from "../stores/runtime";

/**
 * Datasource and namespace selector (docs/brand/mocks/
 * datasource-selector.html): two independent breadcrumb segments above
 * the tree. Segment one switches datasource (relisting disconnected
 * entries normally — selecting one connects it), segment two switches
 * schema / database / keyspace / file per engine. Engine chips are
 * neutral monograms; status is shape + colour (filled = connected,
 * hollow = disconnected, magenta ring = errored).
 */

type PopoverState = "datasource" | "namespace" | null;

function useDismiss(open: PopoverState, close: () => void) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (open === null) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (
				rootRef.current !== null &&
				!rootRef.current.contains(event.target as Node)
			) {
				close();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				close();
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close]);
	return rootRef;
}

export function DatasourceBreadcrumb() {
	const connections = useConnectionsStore((state) => state.connections);
	const activeConnectionId = useDatasourceStore(
		(state) => state.activeConnectionId,
	);
	const setActive = useDatasourceStore((state) => state.setActive);
	const namespaceByConnection = useDatasourceStore(
		(state) => state.namespaceByConnection,
	);
	const setNamespace = useDatasourceStore((state) => state.setNamespace);
	const ensure = useExplorerStore((state) => state.ensure);
	const refresh = useExplorerStore((state) => state.refresh);
	const removeConnection = useConnectionsStore((state) => state.remove);

	const active =
		connections.find((connection) => connection.id === activeConnectionId) ??
		null;

	// Default to the first datasource once connections load.
	useEffect(() => {
		const first = connections[0];
		if (active === null && first !== undefined) {
			setActive(first.id);
		}
	}, [active, connections, setActive]);

	// Namespaces are the datasource's root children; loading them is also
	// what "connecting" a lazy connection means here.
	const rootKey = active === null ? null : nodeKey(active.id, []);
	const rootChildren = useExplorerStore((state) =>
		rootKey === null ? undefined : state.children[rootKey],
	);
	useEffect(() => {
		if (active !== null && rootChildren === undefined) {
			void ensure(active.id, []);
		}
	}, [active, rootChildren, ensure]);

	const namespaces =
		rootChildren?.status === "loaded"
			? rootChildren.nodes
					.filter((node) => node.kind === "schema" || node.kind === "db")
					.map((node) => node.name)
			: [];

	// Switching datasource resets the second segment to the engine default
	// rather than preserving `public` where it may not exist.
	const chosenNamespace =
		active === null ? undefined : namespaceByConnection[active.id];
	useEffect(() => {
		if (
			active !== null &&
			namespaces.length > 0 &&
			(chosenNamespace === undefined || !namespaces.includes(chosenNamespace))
		) {
			const fallback = defaultNamespace(namespaces);
			if (fallback !== undefined) {
				setNamespace(active.id, fallback);
			}
		}
	}, [active, namespaces, chosenNamespace, setNamespace]);

	const [popover, setPopover] = useState<PopoverState>(null);
	const [dsFilter, setDsFilter] = useState("");
	const [popAnchor, setPopAnchor] = useState<{
		top: number;
		left: number;
	} | null>(null);
	const rootRef = useDismiss(popover, () => setPopover(null));

	const openPopover = (which: Exclude<PopoverState, null>) => {
		if (popover === which) {
			setPopover(null);
			return;
		}
		if (which === "datasource") {
			setDsFilter("");
		}
		// Fixed positioning: the sidebar clips absolutely-positioned overflow.
		const rect = rootRef.current?.getBoundingClientRect();
		setPopAnchor(
			rect === undefined ? null : { top: rect.bottom + 4, left: rect.left + 4 },
		);
		setPopover(which);
	};

	if (active === null) {
		return (
			<div className="dg-crumb">
				<span className="dg-crumb-empty">no datasource</span>
				<button
					type="button"
					className="dg-crumb-action"
					title="New datasource"
					onClick={() => openConnectionForm(null)}
				>
					＋
				</button>
			</div>
		);
	}

	const namespaceLabel = NAMESPACE_LABELS[active.adapter];

	const statusOf = (connection: ConnectionMetadata): "on" | "off" | "err" => {
		const children =
			useExplorerStore.getState().children[nodeKey(connection.id, [])];
		if (children?.status === "loaded") {
			return "on";
		}
		if (children?.status === "error") {
			return "err";
		}
		return "off";
	};

	const visibleDatasources = connections.filter((connection) =>
		connection.name.toLowerCase().includes(dsFilter.trim().toLowerCase()),
	);

	return (
		<div className="dg-crumb" ref={rootRef}>
			<button
				type="button"
				className="dg-crumb-seg"
				aria-expanded={popover === "datasource"}
				aria-haspopup="true"
				onClick={() => openPopover("datasource")}
			>
				<span className="dg-crumb-chip">{ENGINE_CHIPS[active.adapter]}</span>
				<span className="dg-crumb-name">{active.name}</span>
				<span className="dg-crumb-chev">▾</span>
			</button>
			<span className="dg-crumb-slash">/</span>
			<button
				type="button"
				className="dg-crumb-seg"
				aria-expanded={popover === "namespace"}
				aria-haspopup="true"
				disabled={namespaces.length === 0}
				title={`${namespaceLabel} selector`}
				onClick={() => openPopover("namespace")}
			>
				<span className="dg-crumb-name">
					{chosenNamespace ??
						(rootChildren === undefined || rootChildren.status === "loading"
							? "…"
							: "—")}
				</span>
				<span className="dg-crumb-chev">▾</span>
			</button>
			<button
				type="button"
				className="dg-crumb-action"
				title={`Refresh ${active.name}`}
				aria-label={`Refresh ${active.name}`}
				onClick={() =>
					void refresh(active.id, treeRootPath(active, chosenNamespace))
				}
			>
				⟳
			</button>

			{popover === "datasource" && (
				<div
					className="dg-crumb-pop dg-scroll"
					role="menu"
					style={
						popAnchor === null
							? undefined
							: { position: "fixed", top: popAnchor.top, left: popAnchor.left }
					}
				>
					{connections.length > 8 && (
						<input
							className="dg-crumb-search"
							placeholder="filter datasources…"
							aria-label="Filter datasources"
							value={dsFilter}
							onChange={(event) => setDsFilter(event.target.value)}
						/>
					)}
					<div className="dg-crumb-pop-hd">
						{visibleDatasources.length} datasource
						{visibleDatasources.length === 1 ? "" : "s"}
					</div>
					{visibleDatasources.map((connection) => {
						const status = statusOf(connection);
						return (
							<div
								key={connection.id}
								className={`dg-crumb-item${
									connection.id === active.id ? " dg-crumb-item-cur" : ""
								}`}
							>
								<button
									type="button"
									role="menuitem"
									className="dg-crumb-item-main"
									onClick={() => {
										setPopover(null);
										if (connection.id !== active.id) {
											setActive(connection.id);
										}
									}}
								>
									<span className={`dg-crumb-dot dg-crumb-dot-${status}`} />
									<span className="dg-crumb-chip">
										{ENGINE_CHIPS[connection.adapter]}
									</span>
									{connection.name}
									<span className="dg-crumb-sub">{connection.adapter}</span>
								</button>
								<span className="dg-crumb-item-actions">
									<button
										type="button"
										title={connection.source === "predefined" ? "View" : "Edit"}
										aria-label={`${connection.source === "predefined" ? "View" : "Edit"} ${connection.name}`}
										onClick={() => {
											setPopover(null);
											openConnectionForm(connection);
										}}
									>
										✎
									</button>
									{connection.source === "managed" && (
										<button
											type="button"
											title="Delete"
											aria-label={`Delete ${connection.name}`}
											onClick={() => {
												if (
													window.confirm(
														`Delete connection "${connection.name}"?`,
													)
												) {
													setPopover(null);
													void removeConnection(connection.id);
												}
											}}
										>
											×
										</button>
									)}
								</span>
							</div>
						);
					})}
					<div className="dg-crumb-div" />
					<button
						type="button"
						role="menuitem"
						className="dg-crumb-act"
						onClick={() => {
							setPopover(null);
							openConnectionForm(null);
						}}
					>
						<span className="dg-crumb-plus">＋</span>new datasource…
					</button>
					<button
						type="button"
						role="menuitem"
						className="dg-crumb-act dg-crumb-act-mut"
						onClick={() => {
							setPopover(null);
							openConnectionForm(active);
						}}
					>
						<span className="dg-crumb-plus">⚙</span>manage datasource…
					</button>
				</div>
			)}

			{popover === "namespace" && (
				<div
					className="dg-crumb-pop dg-scroll"
					role="menu"
					style={
						popAnchor === null
							? undefined
							: { position: "fixed", top: popAnchor.top, left: popAnchor.left }
					}
				>
					<div className="dg-crumb-pop-hd">
						{active.name} · {namespaces.length} {namespaceLabel}
						{namespaces.length === 1 ? "" : "s"}
					</div>
					{namespaces.map((name) => (
						<button
							key={name}
							type="button"
							role="menuitem"
							className={`dg-crumb-item dg-crumb-item-main${
								name === chosenNamespace ? " dg-crumb-item-cur" : ""
							}`}
							onClick={() => {
								setPopover(null);
								setNamespace(active.id, name);
							}}
						>
							{name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Tree root path for the selected datasource + namespace: `[]` when the
 * datasource shows every schema as a tree level (the namespace stays the
 * query default but no longer scopes the tree), otherwise `[schema]` on
 * SQL engines, `[db]` on Redis. Exported for the Explorer. */
export function treeRootPath(
	connection: ConnectionMetadata,
	namespace: string | undefined,
): { kind: "schema" | "db"; name: string }[] | null {
	if (connection.showAllSchemas) {
		return [];
	}
	if (namespace === undefined) {
		return null;
	}
	return [
		{
			kind: connection.adapter === "redis" ? "db" : "schema",
			name: namespace,
		},
	];
}

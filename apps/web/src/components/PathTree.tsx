import type { DatasourcePath, FileEntry } from "@datagripe/contracts";
import { useEffect, useState } from "react";
import type { EditorDocument } from "../stores/documents";
import { useDocumentsStore } from "../stores/documents";
import { dirKey, useFilesStore } from "../stores/files";
import { useViewsStore } from "../stores/views";

/**
 * One datasource path, as a file tree in the sidebar
 * (docs/spec/datasource-paths.md). The section frame owns the heading —
 * the pair's nicename — so this renders only what is inside the box.
 *
 * Directories load when you expand them, never before: a checkout is
 * deep, mostly irrelevant, and walking it on open would stall the
 * sidebar for the one file you actually wanted.
 */

export interface PathTreeProps {
	connectionRef: string;
	path: DatasourcePath;
	onOpen: (doc: EditorDocument) => void;
}

/** Row indent per level, matching the schema tree's gutter. */
const INDENT = 14;

function join(parent: string, name: string): string {
	return parent === "" ? name : `${parent}/${name}`;
}

export function PathTree(props: PathTreeProps) {
	const { connectionRef, path } = props;
	const rootKey = dirKey(path.id, "");
	const rootLoaded = useFilesStore((state) => state.entries[rootKey]);
	const rootError = useFilesStore((state) => state.errors[rootKey]);
	const loadingRoot = useFilesStore((state) => state.loading[rootKey] === true);
	const [opening, setOpening] = useState<string | null>(null);
	const [openError, setOpenError] = useState<string | null>(null);

	useEffect(() => {
		void useFilesStore.getState().load(connectionRef, path.id, "");
	}, [connectionRef, path.id]);

	const open = async (filePath: string) => {
		setOpening(filePath);
		setOpenError(null);
		try {
			const doc = await useDocumentsStore.getState().openFile({
				connectionRef,
				pathId: path.id,
				filePath,
			});
			if (doc !== null) {
				props.onOpen(doc);
			}
		} catch (cause) {
			setOpenError(
				cause instanceof Error ? cause.message : "Could not open that file",
			);
		} finally {
			setOpening(null);
		}
	};

	if (rootError !== undefined) {
		return (
			<div className="dg-path-tree">
				{/* The directory is configured but unreachable: say which one,
					    because "not readable" on its own sends people to the wrong
					    machine. */}
				<p className="dg-sidebar-empty">{rootError}</p>
				<p className="dg-path-root" title={path.path}>
					{path.path}
				</p>
				<button
					type="button"
					className="dg-doc-new"
					onClick={() => {
						useFilesStore.getState().invalidate(path.id);
						void useFilesStore
							.getState()
							.load(connectionRef, path.id, "", true);
					}}
				>
					try again
				</button>
			</div>
		);
	}

	return (
		<div className="dg-path-tree">
			{openError !== null && (
				<p className="dg-sidebar-empty dg-test-failed">{openError}</p>
			)}
			{rootLoaded === undefined ? (
				<p className="dg-sidebar-empty">
					{loadingRoot ? "Reading…" : "Not loaded."}
				</p>
			) : rootLoaded.length === 0 ? (
				<p className="dg-sidebar-empty">Nothing in this directory yet.</p>
			) : (
				<ul className="dg-path-list">
					{rootLoaded.map((entry) => (
						<Row
							key={entry.name}
							connectionRef={connectionRef}
							pathId={path.id}
							parent=""
							entry={entry}
							depth={0}
							opening={opening}
							onOpenFile={open}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function Row(props: {
	connectionRef: string;
	pathId: string;
	parent: string;
	entry: FileEntry;
	depth: number;
	opening: string | null;
	onOpenFile: (filePath: string) => void;
}) {
	const { entry, pathId, parent, depth } = props;
	const full = join(parent, entry.name);
	const key = dirKey(pathId, full);
	const expanded = useFilesStore((state) => state.expanded[key] === true);
	const children = useFilesStore((state) => state.entries[key]);
	const error = useFilesStore((state) => state.errors[key]);
	const loading = useFilesStore((state) => state.loading[key] === true);

	// The open document for this file, if any — so the row can carry the
	// same dirty dot the tab and the workspace-files list do.
	const doc = useDocumentsStore((state) =>
		Object.values(state.documents).find(
			(candidate) =>
				candidate.origin !== null &&
				candidate.origin.pathId === pathId &&
				candidate.origin.filePath === full,
		),
	);
	const activeViewId = useViewsStore((state) => state.activeViewId);
	const activeDocumentId = useViewsStore((state) =>
		activeViewId === null ? undefined : state.views[activeViewId]?.documentId,
	);

	if (entry.kind === "dir") {
		return (
			<li>
				<div
					className="dg-tree-row"
					style={{ paddingLeft: 10 + depth * INDENT }}
				>
					<button
						type="button"
						className="dg-path-row-button"
						aria-expanded={expanded}
						onClick={() =>
							useFilesStore.getState().toggle(props.connectionRef, pathId, full)
						}
					>
						<span className="dg-tree-glyph" aria-hidden="true">
							{expanded ? "▾" : "▸"}
						</span>
						<span className="dg-tree-label">{entry.name}</span>
					</button>
				</div>
				{expanded && (
					<ul className="dg-path-list">
						{error !== undefined && (
							<li
								className="dg-sidebar-empty"
								style={{ paddingLeft: 10 + (depth + 1) * INDENT }}
							>
								{error}
							</li>
						)}
						{error === undefined && children === undefined && (
							<li
								className="dg-sidebar-empty"
								style={{ paddingLeft: 10 + (depth + 1) * INDENT }}
							>
								{loading ? "Reading…" : "…"}
							</li>
						)}
						{children?.length === 0 && (
							<li
								className="dg-sidebar-empty"
								style={{ paddingLeft: 10 + (depth + 1) * INDENT }}
							>
								empty
							</li>
						)}
						{children?.map((child) => (
							<Row
								key={child.name}
								connectionRef={props.connectionRef}
								pathId={pathId}
								parent={full}
								entry={child}
								depth={depth + 1}
								opening={props.opening}
								onOpenFile={props.onOpenFile}
							/>
						))}
					</ul>
				)}
			</li>
		);
	}

	const isActive = doc !== undefined && doc.id === activeDocumentId;
	return (
		<li>
			<div
				className={`dg-tree-row${isActive ? " dg-tree-row-selected" : ""}`}
				style={{ paddingLeft: 10 + depth * INDENT }}
			>
				<button
					type="button"
					className="dg-path-row-button"
					disabled={!entry.openable}
					title={
						entry.openable
							? full
							: `${full} — too large for the editor (${Math.round((entry.size ?? 0) / 1024)} KB)`
					}
					onClick={() => props.onOpenFile(full)}
				>
					<span className="dg-tree-glyph" aria-hidden="true">
						{props.opening === full ? "◌" : "·"}
					</span>
					<span className="dg-tree-label">
						{doc?.dirty === true && <span className="dg-tab-dirty" />}
						{entry.name}
					</span>
				</button>
			</div>
		</li>
	);
}

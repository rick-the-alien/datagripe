import { type ReactNode, useState } from "react";
import { IconChevronDown, IconChevronRight } from "./icons";

/**
 * VSCode-style sidebar sections: expanded sections size to their
 * content (capped — see .dg-sidebar-section in index.css) and shrink
 * when space runs out; the explorer tree absorbs whatever is left.
 * Collapsing a section docks its header at the bottom.
 */

export interface SidebarSection {
	id: string;
	title: ReactNode;
	body: ReactNode;
	/**
	 * Start collapsed until somebody expands it (docs/spec/mcp.md
	 * "The panel"). An id absent from storage renders expanded, so
	 * "collapsed by default" has to be said here — and once a person has
	 * expanded or collapsed it, the stored list wins like everywhere
	 * else.
	 */
	defaultCollapsed?: boolean;
}

const STORAGE_KEY = "dg.sidebar.collapsed";
/** Ids a person has expanded, so a default-collapsed one stays open. */
const EXPANDED_KEY = "dg.sidebar.expanded";

function readIds(key: string): string[] {
	try {
		const raw = localStorage.getItem(key);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v) => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

function writeIds(key: string, ids: string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(ids));
	} catch {
		// Storage blocked — collapse state just stops persisting.
	}
}

export function SidebarSections(props: { sections: SidebarSection[] }) {
	const [collapsed, setCollapsed] = useState<string[]>(() =>
		readIds(STORAGE_KEY),
	);
	const [expandedIds, setExpandedIds] = useState<string[]>(() =>
		readIds(EXPANDED_KEY),
	);

	/**
	 * Whether a section is open. Two lists rather than one because the
	 * default differs per section: a collapse has to be remembered for a
	 * normally-open section, and an expand for a normally-closed one.
	 */
	const isOpen = (section: SidebarSection) =>
		section.defaultCollapsed === true
			? expandedIds.includes(section.id)
			: !collapsed.includes(section.id);

	const toggle = (section: SidebarSection) => {
		const open = isOpen(section);
		if (section.defaultCollapsed === true) {
			const next = open
				? expandedIds.filter((value) => value !== section.id)
				: [...expandedIds, section.id];
			setExpandedIds(next);
			writeIds(EXPANDED_KEY, next);
			return;
		}
		const next = open
			? [...collapsed, section.id]
			: collapsed.filter((value) => value !== section.id);
		setCollapsed(next);
		writeIds(STORAGE_KEY, next);
	};

	const expanded = props.sections.filter(isOpen);
	const docked = props.sections.filter((section) => !isOpen(section));

	const header = (section: SidebarSection, isExpanded: boolean) => (
		<button
			key={section.id}
			type="button"
			className="dg-section-header"
			aria-expanded={isExpanded}
			onClick={() => toggle(section)}
		>
			<span className="dg-section-chevron">
				{isExpanded ? <IconChevronDown /> : <IconChevronRight />}
			</span>
			{section.title}
		</button>
	);

	return (
		<>
			{expanded.map((section) => (
				<section key={section.id} className="dg-sidebar-section">
					{header(section, true)}
					<div className="dg-sidebar-section-body dg-scroll">
						{section.body}
					</div>
				</section>
			))}
			{docked.length > 0 && (
				<div className="dg-sidebar-docked">
					{docked.map((s) => header(s, false))}
				</div>
			)}
		</>
	);
}

import { type ReactNode, useState } from "react";

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
}

const STORAGE_KEY = "dg.sidebar.collapsed";

function readCollapsed(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v) => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

export function SidebarSections(props: { sections: SidebarSection[] }) {
	const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);

	const toggle = (id: string) => {
		const next = collapsed.includes(id)
			? collapsed.filter((value) => value !== id)
			: [...collapsed, id];
		setCollapsed(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Storage blocked — collapse state just stops persisting.
		}
	};

	const expanded = props.sections.filter(
		(section) => !collapsed.includes(section.id),
	);
	const docked = props.sections.filter((section) =>
		collapsed.includes(section.id),
	);

	const header = (section: SidebarSection, isExpanded: boolean) => (
		<button
			key={section.id}
			type="button"
			className="dg-section-header"
			aria-expanded={isExpanded}
			onClick={() => toggle(section.id)}
		>
			<span className="dg-section-chevron">{isExpanded ? "▾" : "▸"}</span>
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

import type { IDockviewPanelProps } from "dockview-react";
import { readViewPanelParams } from "../app/viewPanels";
import { MockBadge } from "./MockBadge";

/**
 * MOCK — table view (brand-system.md "Table view and object view").
 * Chrome line (refresh, where filter, row limit, export) and layout are
 * per spec; the grid is a placeholder until the real data path lands.
 */
export function TableView(props: IDockviewPanelProps) {
	const params = readViewPanelParams(props.params);
	return (
		<div className="dg-mockview">
			<div className="dg-mockview-chrome">
				<button type="button" title="Refresh (mock)" disabled>
					⟳
				</button>
				<input placeholder="where …" aria-label="Row filter (mock)" disabled />
				<select aria-label="Row limit (mock)" disabled defaultValue="100">
					<option value="100">100 rows</option>
					<option value="500">500 rows</option>
					<option value="1000">1,000 rows</option>
				</select>
				<button type="button" disabled>
					Export
				</button>
				<MockBadge />
			</div>
			<div className="dg-mockview-body dg-scroll">
				<p>
					Table view for <code>{params.name}</code>.
				</p>
				<p>
					One line of chrome, then rows: default limit 100, sticky header, row
					numbers, primary key in magenta, numerics right-aligned and coloured,
					footer stating “n of total rows”. The data path is not implemented yet
					— this tab exists so the interaction (double click, middle click,
					“view rows”) already has somewhere to land.
				</p>
			</div>
		</div>
	);
}

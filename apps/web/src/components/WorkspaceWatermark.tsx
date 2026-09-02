import type { IWatermarkPanelProps } from "dockview-react";
import { openEditorPanel } from "../app/editorPanels";
import { Mascot } from "../components/Mascot";
import { useDocumentsStore } from "../stores/documents";

/** Shown by Dockview when no panels are open. */
export function WorkspaceWatermark(props: IWatermarkPanelProps) {
	return (
		<div className="dg-watermark">
			<Mascot size={80} />
			<p>No editors open.</p>
			<button
				type="button"
				onClick={() => {
					const doc = useDocumentsStore.getState().createDocument();
					openEditorPanel(props.containerApi, doc);
				}}
			>
				New query
			</button>
		</div>
	);
}

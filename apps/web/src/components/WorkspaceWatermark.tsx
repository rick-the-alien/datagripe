import type { IWatermarkPanelProps } from "dockview-react";
import { openEditorPanel } from "../app/editorPanels";
import { useDocumentsStore } from "../stores/documents";

/** Shown by Dockview when no panels are open. */
export function WorkspaceWatermark(props: IWatermarkPanelProps) {
	return (
		<div className="dg-watermark">
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

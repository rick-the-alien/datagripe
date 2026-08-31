import {
	checkpointDraft,
	draftDebouncer,
	useDocumentsStore,
} from "../stores/documents";
import { createModelRegistry } from "./modelRegistry";
import { monaco } from "./monacoSetup";

/**
 * The live registry binding Monaco models to the document store.
 * `onLastRelease` cancels any pending debounced checkpoint (which may hold
 * an older content snapshot) and writes the final content synchronously
 * before the model is disposed.
 */
export const modelRegistry = createModelRegistry<monaco.editor.ITextModel>({
	createModel: (uri, content, language) =>
		monaco.editor.createModel(content, language, monaco.Uri.parse(uri)),
	onLastRelease: (documentId) => {
		draftDebouncer.cancel(documentId);
		const doc = useDocumentsStore.getState().documents[documentId];
		if (doc !== undefined) {
			void checkpointDraft(doc);
		}
	},
});

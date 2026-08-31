import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

/**
 * Monaco bundled locally (no CDN loader). SQL is the only language we
 * register workers for; the base editor worker covers everything else.
 */
self.MonacoEnvironment = {
	getWorker: () => new editorWorker(),
};

monaco.editor.defineTheme("datagripe-dark", {
	base: "vs-dark",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#1e1f24",
	},
});

export { monaco };

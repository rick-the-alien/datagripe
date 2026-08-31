import { useEffect } from "react";
import { AuthScreen } from "../components/AuthScreen";
import { useSessionStore } from "../stores/session";
import { Workspace } from "./Workspace";

export function App() {
	const bootstrap = useSessionStore((state) => state.bootstrap);
	const load = useSessionStore((state) => state.load);

	useEffect(() => {
		void load();
	}, [load]);

	if (bootstrap === null) {
		return <div className="dg-loading">Loading…</div>;
	}
	if (bootstrap.user === null) {
		return <AuthScreen />;
	}
	return <Workspace />;
}

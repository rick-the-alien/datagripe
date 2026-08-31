import { useQuery } from "@tanstack/react-query";

/**
 * Phase 0 shell: proves the browser → Vite proxy → Bun server path.
 * The Dockview workspace lands in Phase 1.
 */
export function App() {
	const health = useQuery({
		queryKey: ["health"],
		queryFn: async () => {
			const res = await fetch("/health");
			if (!res.ok) {
				throw new Error(`Server responded ${res.status}`);
			}
			return (await res.json()) as { ok: boolean };
		},
	});

	return (
		<main className="shell">
			<h1>DataGripe</h1>
			<p>
				Server:{" "}
				{health.isPending
					? "connecting…"
					: health.isError
						? "unreachable"
						: "ok"}
			</p>
		</main>
	);
}

import { userColor } from "../editor/remoteCursors";
import { useDocumentsStore } from "../stores/documents";
import { usePresenceStore } from "../stores/presence";
import { useSessionStore } from "../stores/session";

/**
 * Online members of the workspace (6b): who is connected and which
 * document they have open, with an opt-in Follow (6c).
 */
export function PresenceSidebar() {
	const users = usePresenceStore((state) => state.users);
	const documents = useDocumentsStore((state) => state.documents);
	const followingUserId = usePresenceStore((state) => state.followingUserId);
	const myUserId = useSessionStore((state) => state.bootstrap?.user?.id);
	const follow = usePresenceStore((state) => state.follow);
	const unfollow = usePresenceStore((state) => state.unfollow);

	const others = users.filter((user) => user.userId !== myUserId);
	if (others.length === 0) {
		return null;
	}

	return (
		<div className="dg-presence">
			<div className="dg-sidebar-heading">Online</div>
			<ul className="dg-document-list">
				{others.map((user) => {
					const activeDoc =
						user.activeDocumentId !== null
							? documents[user.activeDocumentId]?.title
							: undefined;
					const following = followingUserId === user.userId;
					return (
						<li key={user.userId}>
							<div className="dg-document-row">
								<span
									className="dg-presence-dot"
									style={{ background: userColor(user.userId) }}
								/>
								<span className="dg-document-open dg-presence-name">
									{user.email}
									{activeDoc !== undefined && (
										<span className="dg-presence-doc"> · {activeDoc}</span>
									)}
								</span>
								<button
									type="button"
									className="dg-follow-button"
									aria-pressed={following}
									disabled={user.activeDocumentId === null && !following}
									onClick={() => (following ? unfollow() : follow(user.userId))}
								>
									{following ? "Unfollow" : "Follow"}
								</button>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

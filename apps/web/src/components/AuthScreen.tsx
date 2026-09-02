import { useState } from "react";
import { useSessionStore } from "../stores/session";
import { Mascot } from "./Mascot";

/**
 * Login / signup screen. Bootstrap mode (zero users) asks for the first
 * account; otherwise signup shows only when the server allows it.
 */
export function AuthScreen() {
	const bootstrap = useSessionStore((state) => state.bootstrap);
	const error = useSessionStore((state) => state.error);
	const busy = useSessionStore((state) => state.busy);
	const login = useSessionStore((state) => state.login);
	const signup = useSessionStore((state) => state.signup);

	const canSignup =
		bootstrap?.bootstrap === true || bootstrap?.allowSignup === true;
	const [mode, setMode] = useState<"login" | "signup">(
		bootstrap?.bootstrap === true ? "signup" : "login",
	);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const submit = () => {
		if (mode === "login") {
			void login(email, password);
		} else {
			void signup(email, password);
		}
	};

	return (
		<div className="dg-auth">
			<form
				className="dg-auth-card"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<h1 className="dg-auth-brand">
					<Mascot size={72} />
					<span className="dg-auth-lockup">
						Data<b>gripe</b>
					</span>
				</h1>
				<p className="dg-auth-subtitle">
					{mode === "signup"
						? bootstrap?.bootstrap === true
							? "Create the first account"
							: "Create an account"
						: "Sign in"}
				</p>
				<label className="dg-field">
					<span>Email</span>
					<input
						type="email"
						required
						autoComplete="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</label>
				<label className="dg-field">
					<span>Password</span>
					<input
						type="password"
						required
						minLength={mode === "signup" ? 12 : 1}
						autoComplete={
							mode === "signup" ? "new-password" : "current-password"
						}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</label>
				{mode === "signup" && (
					<p className="dg-modal-hint">At least 12 characters.</p>
				)}
				{error !== null && <p className="dg-test-failed">{error}</p>}
				<button type="submit" disabled={busy}>
					{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
				</button>
				{canSignup && (
					<button
						type="button"
						className="dg-auth-switch"
						onClick={() =>
							setMode((current) => (current === "login" ? "signup" : "login"))
						}
					>
						{mode === "login"
							? "Need an account? Sign up"
							: "Have an account? Sign in"}
					</button>
				)}
			</form>
		</div>
	);
}

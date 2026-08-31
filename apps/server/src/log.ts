type LogFields = Record<string, unknown>;

function write(
	level: "info" | "warn" | "error",
	message: string,
	fields?: LogFields,
): void {
	const entry = {
		level,
		msg: message,
		time: new Date().toISOString(),
		...fields,
	};
	// Never log secrets: callers must not pass credentials in fields.
	const line = JSON.stringify(entry);
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

export const log = {
	info: (message: string, fields?: LogFields) => write("info", message, fields),
	warn: (message: string, fields?: LogFields) => write("warn", message, fields),
	error: (message: string, fields?: LogFields) =>
		write("error", message, fields),
	/** Security-relevant events (auth, mutations, policy blocks). Never
	 * passwords, secrets, or result values. */
	audit: (event: string, fields?: LogFields) =>
		write("info", "audit", { event, ...fields }),
	debug: (message: string, fields?: LogFields) => {
		if (process.env.NODE_ENV !== "production") {
			write("info", message, fields);
		}
	},
};

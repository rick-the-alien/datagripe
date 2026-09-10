-- `verify-ca`, so a pasted `sslmode` has somewhere to land.
--
-- The three original values were enough while every connection was typed
-- in by hand. They stop being enough the moment a connection string is
-- pasted, because a provider's URL carries `?sslmode=` with any of
-- libpq's six. `verify-ca` is the one worth adding: chain must validate,
-- hostname need not match, which is exactly what a certificate issued for
-- an internal name behind a load balancer needs. Bun's driver takes
-- libpq's spellings verbatim, so the column now stores what the driver is
-- handed rather than a vocabulary that has to be mapped both ways.
--
-- libpq's `allow` and `prefer` are still not here, and that is measured
-- rather than assumed: against a non-TLS PostgreSQL on Bun 1.4, `disable`
-- connects and the three TLS modes fail immediately with "Server does not
-- support SSL", but `allow` and `prefer` hang until the connection
-- timeout. There is no negotiated fallback behind them, so storing either
-- would be storing a ten-second stall. The parser raises them to
-- `require` and says so.
--
-- The original CHECK was declared inline, so PostgreSQL named it; drop it
-- by that name and add the widened one back named explicitly so the next
-- change to it does not have to guess. 0006_adapters.sql already dropped
-- NOT NULL here, so null stays valid and keeps meaning "unset".
ALTER TABLE connections
	DROP CONSTRAINT IF EXISTS connections_tls_mode_check;

ALTER TABLE connections
	ADD CONSTRAINT connections_tls_mode_check
	CHECK (tls_mode IN ('disable', 'require', 'verify-ca', 'verify-full'));

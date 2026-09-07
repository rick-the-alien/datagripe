-- Demo database objects for the gripes showcase.
--
-- Every rule in the object half of the catalogue has a subject here that
-- fires and a neighbour that does not, because a demo where everything
-- is broken proves nothing. The silent ones are the point: they are what
-- make a gripe worth reading when it does appear.
--
-- Reproducible and idempotent — the whole `shop` schema is rebuilt, so
-- this can be re-run after a machine reset:
--   psql -h 127.0.0.1 -U datagripe -d demo -f scripts/demo/schema.sql

-- Scratch fixtures from earlier testing, folded into the set below.
drop table if exists public.keyless_demo cascade;
drop function if exists public.unsafe_total() cascade;
drop function if exists public.plain_total() cascade;

drop schema if exists shop cascade;
create schema shop;

-- ---------------------------------------------------------------- clean

-- No gripes at all: a primary key, no redundant index, nothing to say.
create table shop.customers (
	id bigserial primary key,
	email text not null,
	-- Nullable on purpose: `status <> 'churned'` in a query over this
	-- table is what trips column.nullable-inequality.
	status text,
	signed_up_at timestamptz not null default now()
);

create table shop.products (
	id bigserial primary key,
	sku text not null,
	title text not null,
	price_cents integer not null,
	created_at timestamptz not null default now()
);

-- index.duplicate must NOT fire on this pair. The unique index enforces
-- something the wider index does not, so dropping it would change
-- behaviour rather than just save writes.
create unique index products_sku_key on shop.products (sku);
create index idx_products_sku_title on shop.products (sku, title);

-- ------------------------------------------------- table.no-primary-key

-- A log table nobody gave a key. Every row is indistinguishable from its
-- twin, and there is no way to delete just one of them.
create table shop.event_log (
	occurred_at timestamptz not null default now(),
	actor text,
	action text not null,
	detail jsonb
);

-- ----------------------------------------------------- index.duplicate

create table shop.orders (
	id bigserial primary key,
	customer_id bigint not null references shop.customers (id),
	-- Nullable, and compared with <> in the demo queries.
	status text,
	total_cents integer not null default 0,
	placed_at timestamptz not null default now(),
	cancelled_at timestamptz
);

-- idx_orders_customer is a prefix of idx_orders_customer_placed: it
-- costs writes and buys nothing a query could not get from the wider one.
create index idx_orders_customer on shop.orders (customer_id);
create index idx_orders_customer_placed on shop.orders (customer_id, placed_at);

create table shop.order_items (
	id bigserial primary key,
	order_id bigint not null references shop.orders (id),
	product_id bigint not null references shop.products (id),
	quantity integer not null check (quantity > 0)
);

-- Different leading column, so neither covers the other.
create index idx_order_items_order on shop.order_items (order_id);
create index idx_order_items_product on shop.order_items (product_id);

-- ------------------------------------- routine.definer-no-search-path

-- Fires, and it is the only blocker in the object half. A definer
-- routine runs with the owner's privileges but resolves unqualified
-- names using the *caller's* search_path, so anyone who can create a
-- schema can shadow `orders` and have their version run as the owner.
--
-- plpgsql on purpose. A `language sql` body is parsed and its names
-- resolved when the function is created, so Postgres refuses to create
-- this one at all with an unqualified `orders` — and once resolved, the
-- name cannot be shadowed later. plpgsql resolves at call time, which is
-- where the escalation actually lives.
create function shop.grant_discount(order_id bigint, pct integer)
	returns void
	language plpgsql
	security definer
as $$
begin
	update orders set total_cents = total_cents - (total_cents * pct / 100)
	where id = order_id;
end;
$$;

-- Does not fire: same privileges, but the search_path is pinned, so
-- `orders` cannot be shadowed.
create function shop.safe_discount(order_id bigint, pct integer)
	returns void
	language sql
	security definer
	set search_path = shop, pg_temp
as $$
	update shop.orders set total_cents = total_cents - (total_cents * pct / 100)
	where id = order_id;
$$;

-- --------------------------------- routine.volatile-but-readonly

-- Fires (style): reads only, but left volatile, so the planner must
-- call it per row and cannot use it in an index.
create function shop.order_total(oid bigint)
	returns bigint
	language sql
as $$
	select sum(oi.quantity * p.price_cents)
	from shop.order_items oi
	join shop.products p on p.id = oi.product_id
	where oi.order_id = oid;
$$;

-- Does not fire: identical body, correctly marked.
create function shop.order_total_stable(oid bigint)
	returns bigint
	language sql
	stable
as $$
	select sum(oi.quantity * p.price_cents)
	from shop.order_items oi
	join shop.products p on p.id = oi.product_id
	where oi.order_id = oid;
$$;

-- Does not fire: the body writes, so volatile is correct.
create function shop.log_event(what text)
	returns void
	language sql
as $$
	insert into shop.event_log (action) values (what);
$$;

-- Does not fire, and this one is a "cannot tell" rather than a "no". A
-- plpgsql body can write through dynamic SQL that reading the text will
-- never reveal, so the rule declines to judge it.
create function shop.recalc_totals()
	returns integer
	language plpgsql
as $$
declare
	touched integer;
begin
	update shop.orders o
	set total_cents = coalesce(shop.order_total_stable(o.id), 0);
	get diagnostics touched = row_count;
	return touched;
end;
$$;

-- --------------------------------------------------------------- views

-- Named columns: adding a column to orders does not silently change it.
create view shop.order_summary as
select o.id, o.status, o.total_cents, c.email
from shop.orders o
join shop.customers c on c.id = o.customer_id;

-- Defined with a star, so its column list was frozen the moment it was
-- created. Add a column to orders and this view will never show it.
create view shop.recent_orders as
select * from shop.orders where placed_at > now() - interval '30 days';

-- ---------------------------------------------------------------- data

insert into shop.customers (email, status) values
	('ada@example.com', 'active'),
	('grace@example.com', 'active'),
	('alan@example.com', null),
	('katherine@example.com', 'churned');

insert into shop.products (sku, title, price_cents) values
	('DG-001', 'Ergonomic keyboard', 8900),
	('DG-002', 'Mechanical keyboard', 14900),
	('DG-003', 'Standing desk', 49900),
	('DG-004', 'Monitor arm', 12900);

insert into shop.orders (customer_id, status, placed_at) values
	(1, 'shipped', now() - interval '2 days'),
	(1, null, now() - interval '1 day'),
	(2, 'shipped', now() - interval '10 days'),
	(3, 'cancelled', now() - interval '40 days'),
	(4, 'pending', now());

insert into shop.order_items (order_id, product_id, quantity) values
	(1, 1, 1), (1, 4, 2), (2, 2, 1), (3, 3, 1), (4, 1, 3), (5, 2, 1);

insert into shop.event_log (actor, action, detail) values
	('ada@example.com', 'order.placed', '{"order_id": 1}'),
	('grace@example.com', 'order.shipped', '{"order_id": 3}'),
	(null, 'nightly.recalc', '{"touched": 5}');

select shop.recalc_totals();
analyze;

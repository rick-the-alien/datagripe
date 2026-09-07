-- index.not-concurrent and view.select-star — warnings
--
-- Two statements that are completely fine on the four rows in this demo
-- and are how you take production down.

-- CREATE INDEX holds a lock that blocks every write to the table until
-- the build finishes. On four rows that is instant. On forty million it
-- is an outage, and the statement is identical.

create index idx_orders_status on shop.orders (status);

-- CONCURRENTLY builds it without blocking writes. Slower, and the only
-- version that is safe on a table anyone is using.

create index concurrently idx_orders_status on shop.orders (status);

-- A star in a view is not a standing instruction. Postgres expands it
-- once, when the view is created, and records the result. Add a column
-- to shop.orders tomorrow and this view will never show it.

create view shop.orders_today as
select * from shop.orders where placed_at > current_date;

-- Named columns, so the view says what it returns and keeps saying it.

create view shop.orders_today as
select id, customer_id, status, total_cents, placed_at
from shop.orders
where placed_at > current_date;

-- `qty * price` is multiplication, not a projection star. Not a finding,
-- which is the sort of thing that would have made the whole feature
-- untrustworthy if it were.

create view shop.item_totals as
select oi.order_id, oi.quantity * p.price_cents as total_cents
from shop.order_items oi
join shop.products p on p.id = oi.product_id;

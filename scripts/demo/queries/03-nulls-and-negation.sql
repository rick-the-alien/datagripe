-- column.nullable-inequality and subquery.not-in — warnings
--
-- Both of these are about null, and both are silent in production: the
-- query does not fail, it just answers fewer rows than you asked for.

-- shop.orders.status is nullable, and one order has no status. Read as
-- English this asks for everything that is not shipped, and a null
-- status is obviously not shipped. Read as SQL, the comparison is
-- unknown for that row, so it is dropped.

select id, status from shop.orders where status <> 'shipped';

-- Says what it means, and includes the null row.

select id, status from shop.orders
where status is distinct from 'shipped';

-- Equality is not a finding. Most columns are nullable and everyone
-- reads `= 'shipped'` correctly, so griping here would fire on half the
-- queries in the tool and earn nothing.

select id, status from shop.orders where status = 'shipped';

-- NOT IN against a subquery. If any customer_id in shop.orders were
-- null, this would return no rows at all — no error, no clue.

select email from shop.customers
where id not in (select customer_id from shop.orders);

-- NOT EXISTS is the fix, and is never a finding.

select c.email from shop.customers c
where not exists (
	select 1 from shop.orders o where o.customer_id = c.id
);

-- A written-out list is not a finding either: a null in there would be
-- visible to whoever reads it.

select email from shop.customers where id not in (1, 2, 3);

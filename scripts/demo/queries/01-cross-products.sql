-- join.no-condition — blocker
--
-- A join with no ON and no USING is a cross product however it was
-- meant. Four customers and five orders is twenty rows, and the number
-- is a product, so it grows the way products grow.

select c.email, o.total_cents
from shop.customers c
join shop.orders o;

-- The same query, joined properly. No gripe.

select c.email, o.total_cents
from shop.customers c
join shop.orders o on o.customer_id = c.id;

-- CROSS JOIN says cross product out loud, so it is not a finding. The
-- tool is not against cross products; it is against accidental ones.

select c.email, p.title
from shop.customers c
cross join shop.products p;

-- NATURAL JOIN derives its condition from the column names, so it has
-- one. Also silent.

select * from shop.orders natural join shop.order_items;

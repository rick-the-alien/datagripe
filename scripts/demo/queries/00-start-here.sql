-- Datagripe demo project
--
-- Every file in this project is wired to trip a specific gripe, with the
-- fixed version of the same query underneath it. The point is not the
-- complaint — it is watching the tool go quiet when the query is right.
--
-- Findings appear in the gutter, as a squiggle, on the right-hand rail,
-- and in the Gripes panel. The status bar counts them. Anything you
-- disagree with can be dismissed for this occurrence, this target, or
-- the whole project.
--
-- The connection is read-only, so the writes in these files are safe to
-- leave sitting here. Gripes are static analysis; nothing runs to find
-- them.

select c.email, count(*) as orders
from shop.customers c
join shop.orders o on o.customer_id = c.id
group by c.email
order by orders desc;

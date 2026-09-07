-- The control.
--
-- Real queries against the demo schema, none of which have anything
-- wrong with them. The status bar should read "no gripes" with only this
-- file open. A gripes engine is only worth having if it is quiet by
-- default.

select c.email, count(o.id) as order_count, sum(o.total_cents) as spent
from shop.customers c
left join shop.orders o on o.customer_id = c.id
group by c.email
order by spent desc nulls last;

select p.title, sum(oi.quantity) as units
from shop.order_items oi
join shop.products p on p.id = oi.product_id
group by p.title
having sum(oi.quantity) > 1
order by units desc;

select o.id, o.placed_at, shop.order_total_stable(o.id) as computed
from shop.orders o
where o.status is distinct from 'cancelled'
order by o.placed_at desc
limit 20;

update shop.orders
set status = 'shipped', cancelled_at = null
where id = 5;

delete from shop.event_log
where occurred_at < now() - interval '1 year';

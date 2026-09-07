-- delete.no-where and update.no-where — blockers
--
-- The whole table, not the row. These are the two statements most worth
-- catching before you press run, because there is no undo and the
-- statement looks perfectly ordinary.

delete from shop.event_log;

update shop.orders set status = 'cancelled';

-- Qualified, and silent.

delete from shop.event_log where occurred_at < now() - interval '90 days';

update shop.orders set status = 'cancelled' where id = 4;

-- Looks like the finding and is not. The verb here is `create`; the
-- `delete` is an event name, and a trigger has no WHERE clause. If this
-- fired, it would fire on every trigger in the database.

create trigger log_order_delete
after delete on shop.orders
for each row execute function shop.log_event('order.deleted');

-- Also not a finding: a grant of the DELETE privilege.

grant delete on shop.event_log to public;

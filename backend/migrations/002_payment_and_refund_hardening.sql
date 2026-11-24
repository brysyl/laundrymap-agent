-- At most one PENDING payment per order. Concurrent initializePayment calls can no
-- longer create two live references for the same order.
CREATE UNIQUE INDEX payments_one_pending_per_order ON payments (order_id) WHERE status = 'PENDING';

-- Supports the refund retry sweep.
CREATE INDEX refunds_unsettled_idx ON refunds (created_at) WHERE status IN ('RECORDED','FAILED');

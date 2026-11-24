-- Refund submission claims, backoff and attempt cap.
-- A submitter claims a refund by moving it to SUBMITTING, bumping attempts and setting
-- next_attempt_at to the end of a lease. A crashed submitter's claim becomes reclaimable once the lease ends.
ALTER TABLE refunds ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE refunds ADD COLUMN last_error text;

ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('RECORDED','SUBMITTING','SUBMITTED','FAILED','EXHAUSTED'));

-- Refunds of mismatched charges are keyed by payment, so one order can have a mismatch refund and a normal one.
ALTER TABLE refunds DROP CONSTRAINT refunds_kind_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_kind_check
  CHECK (kind IN ('AUTO_TIMEOUT','AUTO_REJECT','ADMIN','LATE_PAYMENT','MISMATCH'));
ALTER TABLE refunds DROP CONSTRAINT refunds_order_id_key;
ALTER TABLE refunds ADD CONSTRAINT refunds_payment_id_key UNIQUE (payment_id);
CREATE INDEX refunds_order_idx ON refunds (order_id);

DROP INDEX refunds_unsettled_idx;
CREATE INDEX refunds_unsettled_idx ON refunds (next_attempt_at, created_at)
  WHERE status IN ('RECORDED','FAILED','SUBMITTING');

-- Mismatched charges: remember what the gateway reported and allow a resolved state.
ALTER TABLE payments ADD COLUMN received_kobo bigint CHECK (received_kobo > 0);
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('PENDING','PAID','FAILED','MISMATCH','MISMATCH_REFUNDED'));

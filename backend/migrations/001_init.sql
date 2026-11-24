-- LaundryMap initial schema. Money columns are BIGINT integer kobo.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL,
  phone         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('CUSTOMER','VENDOR','COURIER','ADMIN')),
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE vendors (
  id               uuid PRIMARY KEY,
  owner_id         uuid NOT NULL UNIQUE REFERENCES users(id),
  name             text NOT NULL,
  address          text NOT NULL,
  location         geography(Point, 4326) NOT NULL,
  unit_price_kobo  bigint NOT NULL CHECK (unit_price_kobo > 0),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_location_gix ON vendors USING gist (location);

CREATE TABLE couriers (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL UNIQUE REFERENCES users(id),
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  location    geography(Point, 4326),
  location_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id                uuid PRIMARY KEY,
  customer_id       uuid NOT NULL REFERENCES users(id),
  vendor_id         uuid NOT NULL REFERENCES vendors(id),
  courier_id        uuid REFERENCES users(id),
  status            text NOT NULL CHECK (status IN ('PENDING_PAYMENT','AWAITING_VENDOR','ACCEPTED','IN_PROGRESS',
                      'READY_FOR_PICKUP','COURIER_ASSIGNED','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','REFUNDED')),
  subtotal_kobo     bigint NOT NULL CHECK (subtotal_kobo >= 0),
  delivery_fee_kobo bigint NOT NULL CHECK (delivery_fee_kobo >= 0),
  total_kobo        bigint NOT NULL,
  dropoff_address   text NOT NULL,
  dropoff_location  geography(Point, 4326) NOT NULL,
  accept_deadline   timestamptz,
  cancel_reason     text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (total_kobo = subtotal_kobo + delivery_fee_kobo)
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_vendor_idx ON orders (vendor_id, created_at DESC);
CREATE INDEX orders_courier_idx ON orders (courier_id) WHERE courier_id IS NOT NULL;
CREATE INDEX orders_deadline_idx ON orders (accept_deadline) WHERE status = 'AWAITING_VENDOR';

CREATE TABLE order_items (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name            text NOT NULL,
  quantity        integer NOT NULL CHECK (quantity > 0),
  unit_price_kobo bigint NOT NULL CHECK (unit_price_kobo > 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE payments (
  id                     uuid PRIMARY KEY,
  order_id               uuid NOT NULL REFERENCES orders(id),
  reference              text NOT NULL UNIQUE,
  amount_kobo            bigint NOT NULL CHECK (amount_kobo > 0),
  status                 text NOT NULL CHECK (status IN ('PENDING','PAID','FAILED','MISMATCH')),
  authorization_url      text,
  gateway_transaction_id text,
  paid_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id, created_at DESC);

-- Idempotency keys for gateway webhooks.
CREATE TABLE webhook_events (
  event_id    text PRIMARY KEY,
  reference   text,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          uuid PRIMARY KEY,
  tx_id       uuid NOT NULL,
  order_id    uuid REFERENCES orders(id),
  account     text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  type        text NOT NULL CHECK (type IN ('ORDER_PAYMENT','PLATFORM_FEE','VENDOR_EARNINGS','COURIER_FEE',
                'GATEWAY_FEE','REFUND','PAYOUT')),
  memo        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_idx ON ledger_entries (tx_id);
CREATE INDEX ledger_account_idx ON ledger_entries (account);
CREATE INDEX ledger_order_idx ON ledger_entries (order_id);

-- Append-only: block UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION ledger_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();

-- Every ledger transaction must balance (debits = credits), checked at COMMIT.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO d, c FROM ledger_entries WHERE tx_id = NEW.tx_id;
  IF d <> c THEN
    RAISE EXCEPTION 'ledger tx % unbalanced: debits % credits %', NEW.tx_id, d, c;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE TABLE refunds (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL UNIQUE REFERENCES orders(id),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  amount_kobo  bigint NOT NULL CHECK (amount_kobo > 0),
  reason       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('AUTO_TIMEOUT','AUTO_REJECT','ADMIN','LATE_PAYMENT')),
  status       text NOT NULL CHECK (status IN ('RECORDED','SUBMITTED','FAILED')),
  requested_by uuid REFERENCES users(id),
  gateway_ref  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);

-- Delivery OTPs: AES-256-GCM ciphertext only, never plaintext.
CREATE TABLE otps (
  order_id     uuid PRIMARY KEY REFERENCES orders(id),
  ciphertext   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

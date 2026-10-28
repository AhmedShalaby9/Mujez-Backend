CREATE TABLE platform.invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number text NOT NULL UNIQUE,
 company_id uuid NOT NULL REFERENCES platform.companies(id), subscription_id uuid REFERENCES platform.subscriptions(id),
 seed_key text UNIQUE,company_snapshot jsonb NOT NULL,description text NOT NULL,
 issue_date date NOT NULL,due_date date NOT NULL CHECK(due_date>=issue_date),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 subtotal_minor bigint NOT NULL CHECK(subtotal_minor BETWEEN 1 AND 1000000000000),tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),tax_minor bigint NOT NULL CHECK(tax_minor>=0),total_minor bigint NOT NULL CHECK(total_minor=subtotal_minor+tax_minor AND total_minor<=1000000000000),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','issued','void')),version integer NOT NULL DEFAULT 0,void_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tx_id text NOT NULL UNIQUE,
 invoice_id uuid NOT NULL REFERENCES platform.invoices(id),
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 method text NOT NULL CHECK(method IN ('bank','card','instapay')),reference text NOT NULL UNIQUE,
 reconciliation text NOT NULL DEFAULT 'pending' CHECK(reconciliation IN ('matched','unmatched','pending')),
 paid_at timestamptz NOT NULL,version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.credit_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number text NOT NULL UNIQUE,invoice_id uuid NOT NULL REFERENCES platform.invoices(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),reason text NOT NULL,actor_id uuid NOT NULL REFERENCES platform.users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number text NOT NULL UNIQUE,payment_id uuid NOT NULL REFERENCES platform.payments(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),reason text NOT NULL,actor_id uuid NOT NULL REFERENCES platform.users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.billing_requests (
 actor_id uuid NOT NULL REFERENCES platform.users(id),request_id uuid NOT NULL,signature text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX invoices_company ON platform.invoices(company_id,created_at DESC);
CREATE INDEX payments_invoice ON platform.payments(invoice_id);
CREATE INDEX credit_invoice ON platform.credit_notes(invoice_id);
CREATE INDEX refunds_payment ON platform.refunds(payment_id);
GRANT SELECT,INSERT,UPDATE ON platform.invoices,platform.payments TO mujez_platform;
GRANT SELECT,INSERT ON platform.credit_notes,platform.refunds,platform.billing_requests TO mujez_platform;
CREATE FUNCTION platform.protect_issued_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'draft' AND (NEW.company_id,NEW.subscription_id,NEW.company_snapshot,NEW.description,NEW.issue_date,NEW.due_date,NEW.subtotal_minor,NEW.tax_bps,NEW.tax_minor,NEW.total_minor,NEW.currency) IS DISTINCT FROM (OLD.company_id,OLD.subscription_id,OLD.company_snapshot,OLD.description,OLD.issue_date,OLD.due_date,OLD.subtotal_minor,OLD.tax_bps,OLD.tax_minor,OLD.total_minor,OLD.currency) THEN RAISE EXCEPTION 'Issued invoice terms are immutable';END IF;
 IF OLD.state='void' AND NEW.state<>'void' THEN RAISE EXCEPTION 'Void invoice cannot be reopened'; END IF; RETURN NEW;END $$;
CREATE TRIGGER protect_invoice BEFORE UPDATE ON platform.invoices FOR EACH ROW EXECUTE FUNCTION platform.protect_issued_invoice();
CREATE TRIGGER immutable_credit BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.credit_notes FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_audit_mutation();
CREATE TRIGGER immutable_refund BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.refunds FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_audit_mutation();

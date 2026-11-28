-- A brokerage deal becomes a contract the first time it is approved as
-- contracted. That date never changes afterwards; later changes to the deal
-- are stamped separately.
ALTER TABLE tenant.brokerage_deals ADD COLUMN contracted_at timestamptz;
ALTER TABLE tenant.brokerage_deals ADD COLUMN contract_modified_at timestamptz;

-- Backfill from the deal history. The migration owner must see every company's
-- rows, so forced RLS is lifted for this transaction only.
ALTER TABLE tenant.brokerage_deals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant.brokerage_deal_events NO FORCE ROW LEVEL SECURITY;
UPDATE tenant.brokerage_deals d SET contracted_at=coalesce(
  (SELECT min(e.created_at) FROM tenant.brokerage_deal_events e
    WHERE e.company_id=d.company_id AND e.deal_id=d.id
      AND e.snapshot->>'status'='contracted' AND e.snapshot->>'approvalStatus'='approved'),
  CASE WHEN d.status='contracted' AND d.approval_status='approved' THEN d.approved_at END
);
UPDATE tenant.brokerage_deals d SET contract_modified_at=
  (SELECT max(e.created_at) FROM tenant.brokerage_deal_events e
    WHERE e.company_id=d.company_id AND e.deal_id=d.id AND e.created_at>d.contracted_at)
WHERE d.contracted_at IS NOT NULL;
ALTER TABLE tenant.brokerage_deals FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant.brokerage_deal_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION tenant.stamp_brokerage_contract() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  -- Bookkeeping columns whose change is not a change to the contract.
  ignored text[] := ARRAY['contracted_at','contract_modified_at','updated_at','developer_claim_obligation_id'];
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.contracted_at := OLD.contracted_at;
    NEW.contract_modified_at := OLD.contract_modified_at;
    IF OLD.contracted_at IS NOT NULL AND (to_jsonb(NEW)-ignored) IS DISTINCT FROM (to_jsonb(OLD)-ignored) THEN
      NEW.contract_modified_at := now();
    END IF;
  END IF;
  IF NEW.contracted_at IS NULL AND NEW.status='contracted' AND NEW.approval_status='approved' THEN
    NEW.contracted_at := coalesce(NEW.approved_at,now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brokerage_contract_dates BEFORE INSERT OR UPDATE ON tenant.brokerage_deals
 FOR EACH ROW EXECUTE FUNCTION tenant.stamp_brokerage_contract();
CREATE INDEX brokerage_deals_contracted ON tenant.brokerage_deals(company_id,contracted_at DESC,id) WHERE contracted_at IS NOT NULL;

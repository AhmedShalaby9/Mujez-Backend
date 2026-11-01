ALTER TABLE tenant.documents ADD COLUMN review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','verified','rejected'));
ALTER TABLE tenant.documents ADD COLUMN reviewed_by uuid;
ALTER TABLE tenant.documents ADD COLUMN reviewed_at timestamptz;
ALTER TABLE tenant.documents ADD COLUMN review_reason text;
ALTER TABLE tenant.documents ADD CONSTRAINT document_reviewer_company FOREIGN KEY(company_id,reviewed_by) REFERENCES tenant.users(company_id,id);
ALTER TABLE platform.announcements ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high'));
ALTER TABLE platform.announcements ADD COLUMN deleted_at timestamptz;

GRANT UPDATE(review_status,reviewed_by,reviewed_at,review_reason) ON tenant.documents TO mujez_tenant;

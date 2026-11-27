-- A user's direct manager one rung up the sales ladder: team leader ->
-- sales manager -> sales director -> head of sales. Many users at one rank
-- can point to the same manager; a company missing a rank may point past it
-- to the next one up, or leave it null to stop the chain there.
ALTER TABLE tenant.users ADD COLUMN reports_to_user_id uuid;
ALTER TABLE tenant.users ADD FOREIGN KEY(company_id,reports_to_user_id) REFERENCES tenant.users(company_id,id);
ALTER TABLE tenant.users ADD CHECK(reports_to_user_id IS NULL OR reports_to_user_id<>id);

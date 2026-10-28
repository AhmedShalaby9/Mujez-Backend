CREATE INDEX payments_recorded_date ON platform.payments(paid_at);
CREATE INDEX refunds_recorded_date ON platform.refunds(created_at);
CREATE INDEX companies_registration_date ON platform.companies(created_at);

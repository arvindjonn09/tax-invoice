-- Refuse inconsistent existing data rather than silently rewriting contact history.
CREATE UNIQUE INDEX customer_contacts_one_primary
ON customer_contacts (company_id, customer_id)
WHERE is_primary AND archived_at IS NULL;

-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys the customer directory.
BEGIN;
DROP TABLE locations;
DROP TABLE customer_contacts;
DROP TABLE customers;
COMMIT;

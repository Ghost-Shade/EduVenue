-- ---------------------------------------------------------------------------
-- Runs once, on the first start of the Postgres container.
-- ---------------------------------------------------------------------------
--
-- The test suite gets its OWN database rather than a schema inside the
-- development one. That separation is the point: `npm test` drops schemas, and
-- a bug in that code must not be able to reach development data. Two databases
-- make the blast radius impossible to get wrong.
--
-- Within `eduvenue_test`, each test file creates its own schema, so files that
-- `node --test` runs in parallel cannot see each other's rows.

create database eduvenue_test;

-- ---------------------------------------------------------------------------
-- btree_gist, installed UP FRONT into the test database.
-- ---------------------------------------------------------------------------
--
-- It is what allows `exclude using gist (facility_id with =, tstzrange(...))`,
-- which is the entire no-overlap guarantee. schema.sql installs it too, with
-- `if not exists`, so this is not strictly required.
--
-- It is done here anyway because CREATE EXTENSION is not safe to run
-- CONCURRENTLY, even with IF NOT EXISTS: several test files start at once, each
-- applies the schema, and on a genuinely fresh database they can collide on the
-- extension's catalogue row. Installing it once, before any test runs, removes
-- that race from the suite entirely.
--
-- Note the `\connect`: init scripts otherwise run only against POSTGRES_DB, so
-- an extension created without this line would land in the wrong database and
-- the race would return.
\connect eduvenue_test

create extension if not exists btree_gist;

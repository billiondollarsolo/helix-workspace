-- Extensions a non-superuser migration owner cannot create (pgvector is not
-- a trusted extension) or that migrations need before 0090. pg_trgm is
-- created by 002_production_roles.sh after the function grants (a superuser
-- migration creates it in 0168); the CloudNativePG bootstrap
-- (helix.cloudnativepgBootstrapSQL) uses the same order.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

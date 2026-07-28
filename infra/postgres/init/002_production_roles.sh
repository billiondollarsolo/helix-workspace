#!/bin/sh
set -eu

app_password_file=${POSTGRES_APP_PASSWORD_FILE:-/var/run/postgresql/tls/app-password}
migration_password_file=${POSTGRES_MIGRATION_PASSWORD_FILE:-/var/run/postgresql/tls/migration-password}

# Local development does not mount production role secrets.
if [ ! -r "$app_password_file" ] && [ ! -r "$migration_password_file" ]; then
  exit 0
fi
if [ ! -r "$app_password_file" ] || [ ! -r "$migration_password_file" ]; then
  echo "Both production PostgreSQL role password files are required." >&2
  exit 1
fi

app_password="$(tr -d '\r\n' < "$app_password_file")"
migration_password="$(tr -d '\r\n' < "$migration_password_file")"
case "$app_password" in
  *[!A-Za-z0-9_-]* | "")
    echo "PostgreSQL role passwords must be non-empty base64url values." >&2
    exit 1
    ;;
esac
case "$migration_password" in
  *[!A-Za-z0-9_-]* | "")
    echo "PostgreSQL role passwords must be non-empty base64url values." >&2
    exit 1
    ;;
esac

psql \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$app_password" \
  --set=migration_password="$migration_password" \
  --set=database_name="$POSTGRES_DB" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
SELECT format(
  'CREATE ROLE helix_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'migration_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_migrator')
\gexec

SELECT format(
  'CREATE ROLE helix_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_app')
\gexec

ALTER ROLE helix_migrator PASSWORD :'migration_password';
ALTER ROLE helix_app PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"database_name" TO helix_migrator, helix_app;
GRANT USAGE, CREATE ON SCHEMA public TO helix_migrator;
GRANT USAGE ON SCHEMA public TO helix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helix_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helix_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO helix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helix_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO helix_app;
SQL

#!/usr/bin/env bash
set -euo pipefail
# Only runs on a fresh local Compose volume; SQL identifiers are safely quoted by psql.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
CREATE DATABASE jobflow_test;
SQL

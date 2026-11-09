#!/usr/bin/env bash
# Base limpia + catálogo de prueba + actores + pasos de flujo. Uso: ./preparar_todo.sh [db]
set -euo pipefail
DB="${1:-deposito_load}"; H="$(cd "$(dirname "$0")" && pwd)"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
"$H/../local/install_local.sh" "$DB" | tail -1
for f in catalogo_pruebas 01_preparar_actores 02_pasos_de_flujo; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$H/$f.sql" >/dev/null; done
echo "Listo: $DB"

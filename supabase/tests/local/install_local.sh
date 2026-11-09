#!/usr/bin/env bash
# Crea una base limpia, simula Supabase y aplica TODAS las migraciones en orden.
# Uso: PGPORT=54329 PGHOST=127.0.0.1 PGUSER=postgres ./install_local.sh [nombre_db]
set -euo pipefail
DB="${1:-deposito_test}"
HERE="$(cd "$(dirname "$0")" && pwd)"; SQL="$HERE/../.."
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
psql -qAt -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
P="psql -q -v ON_ERROR_STOP=1 -d $DB"
$P -f "$HERE/00_shim_supabase.sql" >/dev/null
for f in instalar_todo 07_respaldos 09_respaldos_y_cobros 10_restaurar_respaldos 11_eliminar_productos_clientes 12_seguridad_respaldos 13_borrar_productos_y_huella 14_caja_y_preventista 15_inicio_de_caja_y_mercado_pago 16_comisiones_y_respaldo_en_cierre; do
  [ -f "$SQL/$f.sql" ] || [ -f "$SQL/supabase/$f.sql" ] || continue
  F="$SQL/$f.sql"; [ -f "$F" ] || F="$SQL/supabase/$f.sql"
  echo "  · $f"; $P -f "$F" >/dev/null
done
echo "Base '$DB' lista."

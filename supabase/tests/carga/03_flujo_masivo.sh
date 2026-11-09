#!/usr/bin/env bash
# Simulación de flujo masivo (solo LOCAL). Uso: ./03_flujo_masivo.sh [base] [segundos_pico]
# Fases: A) volumen secuencial · B) hora pico con 24 conexiones · C) pelea por pocos productos · D) carreras · E) invariantes
set -uo pipefail
DB="${1:-deposito_load}"; SEG="${2:-60}"; H="$(cd "$(dirname "$0")" && pwd)"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
Q="psql -q -At -v ON_ERROR_STOP=1 -d $DB"
cd "$H"
SOLO="${3:-}"   # tercer argumento "solo-carreras": reutiliza la base ya cargada y salta A, B y C
if [ -z "$SOLO" ]; then
  "$H/preparar_todo.sh" "$DB" | tail -1
  $Q -c "create table _load.stock0 as select product_id, physical_stock from public.inventory" >/dev/null
fi
$Q -f 05_carreras.sql >/dev/null
if [ -z "$SOLO" ]; then
echo; echo "=== A) VOLUMEN SECUENCIAL: 1.500 ciclos completos (pedido → aprobación → preparación → entrega con cobro) ==="
pgbench -n -c 1 -t 1500 -r -f pg_ciclo.sql "$DB" 2>&1 | grep -E "tps|latency average|failed|_load\." | sed 's/^/  /'
echo; echo "=== B) HORA PICO: 24 conexiones simultáneas, ${SEG}s (40% pedidos, 15% aprobar, 15% preparar, 15% entregar, 25% consultas, 2% cancelar) ==="
pgbench -n -c 24 -j 2 -T "$SEG" -P 20 -r --max-tries=1 -f pg_submit.sql@40 -f pg_approve.sql@15 -f pg_prepare.sql@15 -f pg_deliver.sql@15 -f pg_leer.sql@25 -f pg_cancel.sql@2 "$DB" 2>&1 | grep -E "^progress|tps|latency average|failed|_load\." | sed 's/^/  /'
echo; echo "=== C) PELEA POR STOCK: 24 conexiones sobre los mismos 5 productos, $((SEG/2))s ==="
pgbench -n -c 24 -j 2 -T $((SEG/2)) -r --max-tries=1 -f pg_ciclo_caliente.sql "$DB" 2>&1 | grep -E "tps|latency average|failed|_load\." | sed 's/^/  /'
fi
echo; echo "=== D) CARRERAS (cosas que NUNCA deben ocurrir dos veces) ==="
$Q -c "select _load.race_setup()" >/dev/null || { echo "  no se pudo preparar"; exit 1; }
pgbench -n -c 16 -t 1 -f pg_race_idem.sql "$DB" >/dev/null 2>&1
pgbench -n -c 8  -t 1 -f pg_race_approve.sql "$DB" >/dev/null 2>&1
pgbench -n -c 8  -t 1 -f pg_race_deliver.sql "$DB" >/dev/null 2>&1
pgbench -n -c 20 -t 1 -f pg_race_pay.sql "$DB" >/dev/null 2>&1
pgbench -n -c 10 -t 3 -f pg_race_close.sql "$DB" >/dev/null 2>&1
$Q -c "select race, count(*) filter (where outcome like 'OK%') exitos, count(*) filter (where outcome like 'ERR%') rechazos, count(*) total, string_agg(distinct left(outcome, 38), ' | ') filter (where outcome like 'ERR%') motivos from _load.race_log group by race order by 1" -F ' · ' | sed 's/^/  /'
echo "  --- verificación de las carreras ---"
$Q -F ' · ' <<'SQL' | sed 's/^/  /'
select 'idempotencia: pedidos con el mismo identificador = ' || count(*) || case when count(*) = 1 then '  OK (1)' else '  FALLA (debía ser 1)' end from public.orders where client_request_id = (select v::uuid from _load.race_ctx where k = 'idem_req');
select 'doble aprobación #' || n || ': ' || x || ' aprobaciones exitosas' || case when x = 1 then '  OK' else '  FALLA (debía ser 1)' end from (select right(race, 1) n, count(*) filter (where outcome = 'OK') x from _load.race_log where race like 'approve_%' group by 1) q;
select 'doble entrega #' || n || ': ' || x || ' entregas exitosas' || case when x = 1 then '  OK' else '  FALLA (debía ser 1)' end from (select right(race, 1) n, count(*) filter (where outcome = 'OK') x from _load.race_log where race like 'deliver_%' group by 1) q;
select 'pago de comisión: saldo inicial ' || (select v from _load.race_ctx where k = 'pay_balance') || ', pagado en la carrera ' || coalesce(sum(amount), 0) || case when coalesce(sum(amount), 0) <= (select v::numeric from _load.race_ctx where k = 'pay_balance') then '  OK (no se pagó de más)' else '  FALLA (se pagó de más)' end from public.commission_payouts where note = 'carrera';
select 'cierres de caja del día: ' || count(*) || ' fila(s)' || case when count(*) = 1 then '  OK' else '  FALLA' end from public.cash_closings where day = (now() at time zone 'America/Argentina/Buenos_Aires')::date;
SQL
echo; echo "=== E) INVARIANTES (la contabilidad cierra después de todo lo anterior) ==="
$Q -f 04_invariantes.sql -F ' · ' | sed 's/^/  /'
echo; echo "=== Resumen de datos generados ==="
$Q -F ' · ' -c "select status, count(*) from public.orders group by 1 order by 2 desc" -c "select 'renglones', count(*) from public.order_items union all select 'movimientos de stock', count(*) from public.stock_movements union all select 'cobros', count(*) from public.order_payments union all select 'comisiones', count(*) from public.order_commissions" | sed 's/^/  /'
echo "  deadlocks en el log de Postgres: $(grep -c 'deadlock detected' /tmp/pg.log || true)"

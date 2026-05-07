#!/usr/bin/env bash
# End-to-end smoke test for flow_monitor + pcap_processor (MySQL backend).
#
#   ./test.sh path/to/sample.pcap
#
# Connection defaults can be overridden via env:
#   MYSQL_HOST   (default 127.0.0.1)
#   MYSQL_PORT   (default 3306)
#   MYSQL_USER   (default root)
#   MYSQL_PASS   (default empty)
#   MYSQL_DB     (default flowmon_test)
#   MYSQL_SOCKET (default unset; if set, takes precedence over host/port)
#
# Without an arg, captures 5s of live traffic via tcpdump (needs sudo).

set -euo pipefail

BUILD_DIR="${BUILD_DIR:-build}"
SOCKET="/tmp/flow_monitor_test.sock"
PCAP="${1:-}"

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASS="${MYSQL_PASS:-}"
MYSQL_DB="${MYSQL_DB:-flowmon_test}"
MYSQL_SOCKET="${MYSQL_SOCKET:-}"

# Build the mysql/mariadb client argument list once.
MYSQL_ARGS=(--user="$MYSQL_USER")
[[ -n "$MYSQL_PASS" ]] && MYSQL_ARGS+=(--password="$MYSQL_PASS")
if [[ -n "$MYSQL_SOCKET" ]]; then
    MYSQL_ARGS+=(--socket="$MYSQL_SOCKET")
else
    MYSQL_ARGS+=(--host="$MYSQL_HOST" --port="$MYSQL_PORT" --protocol=TCP)
fi

if [[ ! -x "$BUILD_DIR/flow_monitor" || ! -x "$BUILD_DIR/pcap_processor" ]]; then
    echo "binaries not found in $BUILD_DIR — run cmake -S . -B $BUILD_DIR && cmake --build $BUILD_DIR" >&2
    exit 1
fi

if ! command -v mysql >/dev/null; then
    echo "mysql client not found in PATH" >&2
    exit 1
fi

if [[ -z "$PCAP" ]]; then
    PCAP="/tmp/flow_monitor_sample.pcap"
    if ! command -v tcpdump >/dev/null; then
        echo "no pcap given and tcpdump unavailable — pass a pcap path as argv[1]" >&2
        exit 1
    fi
    echo "[test] capturing 5s of traffic into $PCAP (needs sudo)..."
    sudo timeout 5 tcpdump -i any -w "$PCAP" -c 200 || true
fi
[[ -f "$PCAP" ]] || { echo "no such pcap: $PCAP" >&2; exit 1; }

# Drop & recreate the test database so each run starts clean.
echo "[test] resetting database $MYSQL_DB"
mysql "${MYSQL_ARGS[@]}" -e "DROP DATABASE IF EXISTS \`$MYSQL_DB\`;"
rm -f "$SOCKET"

MON_OPTS=(
    --socket "$SOCKET"
    --mysql-host "$MYSQL_HOST"
    --mysql-port "$MYSQL_PORT"
    --mysql-user "$MYSQL_USER"
    --mysql-db   "$MYSQL_DB"
    --flow-timeout 60
    --verbose
)
[[ -n "$MYSQL_PASS"   ]] && MON_OPTS+=(--mysql-pass "$MYSQL_PASS")
[[ -n "$MYSQL_SOCKET" ]] && MON_OPTS+=(--mysql-socket "$MYSQL_SOCKET")

echo "[test] starting flow_monitor"
"$BUILD_DIR/flow_monitor" "${MON_OPTS[@]}" &
MON_PID=$!
trap 'kill -TERM $MON_PID 2>/dev/null || true' EXIT

# Wait for the socket to appear.
for _ in $(seq 1 50); do
    [[ -S "$SOCKET" ]] && break
    sleep 0.1
done
if [[ ! -S "$SOCKET" ]]; then
    echo "[test] socket never appeared" >&2
    exit 1
fi

echo "[test] feeding $PCAP through pcap_processor"
"$BUILD_DIR/pcap_processor" \
    --input "$PCAP" \
    --socket "$SOCKET" \
    --batch-size 200 \
    --verbose

echo "[test] giving the monitor a moment to drain, then signalling shutdown"
sleep 1
kill -TERM "$MON_PID" 2>/dev/null || true
wait "$MON_PID" || true
trap - EXIT

echo
echo "[test] -------- flow summary --------"
mysql --table "${MYSQL_ARGS[@]}" "$MYSQL_DB" -e \
    "SELECT COUNT(*) AS flows,
            SUM(packet_sent + packet_recv) AS packets,
            SUM(bytes_sent + bytes_recv)   AS bytes
       FROM flows;"

echo "[test] -------- top apps --------"
mysql --table "${MYSQL_ARGS[@]}" "$MYSQL_DB" -e \
    "SELECT application,
            category,
            total_flows,
            total_packets_sent + total_packets_recv AS pkts,
            total_bytes_sent   + total_bytes_recv   AS bytes
       FROM applications_summary
       ORDER BY pkts DESC
       LIMIT 10;"

echo "[test] -------- sample flows --------"
mysql --table "${MYSQL_ARGS[@]}" "$MYSQL_DB" -e \
    "SELECT src_ip, src_port, dst_ip, dst_port, protocol,
            application, application_category,
            packet_sent, packet_recv
       FROM flows
       ORDER BY (packet_sent + packet_recv) DESC
       LIMIT 10;"

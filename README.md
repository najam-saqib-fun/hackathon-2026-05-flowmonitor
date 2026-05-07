# Network Traffic Analyzer (libpcap + nDPI + MySQL)

Two cooperating C++ programs:

- `pcap_processor` — opens a `.pcap` file, parses Ethernet/IPv4 headers,
  and streams every TCP/UDP/ICMP packet to `flow_monitor` over a Unix
  domain socket.
- `flow_monitor` — long-running daemon. It runs nDPI on the streamed
  packets, aggregates them into bidirectional flows (canonical 5-tuple
  hash, so both directions share one row), and persists completed flows
  into a MySQL/MariaDB database.

```
+------------------+   AF_UNIX (binary frames)   +-----------------------+
| pcap_processor   | --------------------------> | flow_monitor          |
|  - libpcap read  |                             |  - flow aggregation   |
|  - L2 strip      |                             |  - nDPI detection     |
|  - L3 snapshot   |                             |  - MySQL persistence  |
+------------------+                             +-----------------------+
                                                          |
                                                          v
                                                   MySQL: `flowmon`
```

## 1. Dependencies

```bash
# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y \
    build-essential cmake pkg-config \
    libpcap-dev libmysqlclient-dev mariadb-client \
    autoconf automake libtool gettext flex bison

# (or libmariadb-dev if you prefer the MariaDB client lib — both work)

# Build nDPI from source (5.x required)
git clone https://github.com/ntop/nDPI.git
cd nDPI
./autogen.sh
./configure
make -j"$(nproc)"
sudo make install
sudo ldconfig
cd ..
```

The build expects **nDPI 5.x** (developed against 5.1.0; nDPI 5 reshaped
`struct ndpi_proto` so `proto.app_protocol` is nested, and
`ndpi_detection_giveup` lost its guess-flag arguments).

You also need a running MySQL or MariaDB server, plus credentials that can
`CREATE DATABASE` (the daemon auto-creates `flowmon` on first run).

### No-sudo install (local prefix)

If you can't `sudo make install` for nDPI, build it into a sibling prefix:

```bash
git clone --depth 1 https://github.com/ntop/nDPI.git third_party/nDPI
cd third_party/nDPI
./autogen.sh
./configure --prefix="$PWD/../ndpi-install"
make -j"$(nproc)" && make install
cd ../..

PKG_CONFIG_PATH="$PWD/third_party/ndpi-install/lib/pkgconfig:$PKG_CONFIG_PATH" \
    cmake -S . -B build
cmake --build build -j"$(nproc)"

# Runtime needs to find libndpi.so:
export LD_LIBRARY_PATH="$PWD/third_party/ndpi-install/lib:$LD_LIBRARY_PATH"
```

## 2. Build

```bash
cmake -S . -B build
cmake --build build -j"$(nproc)"
# optional: sudo cmake --install build
```

This produces `build/pcap_processor` and `build/flow_monitor`.

## 3. Run

In one terminal, start the monitor:

```bash
./build/flow_monitor \
    --socket /tmp/flow_monitor.sock \
    --mysql-host 127.0.0.1 \
    --mysql-port 3306 \
    --mysql-user root \
    --mysql-pass yourpassword \
    --mysql-db   flowmon \
    --flow-timeout 60 \
    --verbose
```

Or with a config file (see `config.json`):

```bash
./build/flow_monitor --config config.json --verbose
```

For local servers, use the unix socket — much faster than TCP and avoids
TCP auth entirely:

```bash
./build/flow_monitor --mysql-socket /var/run/mysqld/mysqld.sock \
                     --mysql-user $USER --mysql-db flowmon --verbose
```

In another terminal, feed it a pcap:

```bash
./build/pcap_processor \
    --input traffic.pcap \
    --socket /tmp/flow_monitor.sock \
    --batch-size 200 \
    --max-payload 1024 \
    --filter "tcp or udp" \
    --verbose
```

When the pcap is done streaming, `pcap_processor` sends an EOF sentinel
and exits. `flow_monitor` keeps running until you `Ctrl-C` it; on
`SIGINT`/`SIGTERM` it flushes every still-active flow to MySQL.

## 4. Inspect results

```bash
mysql --table flowmon < queries.sql
# or
mysql --table flowmon -e \
    "SELECT application, COUNT(*) AS flows
       FROM flows GROUP BY application ORDER BY flows DESC LIMIT 20;"
```

`queries.sql` contains ready-made queries for:

- Top apps by bytes
- Longest / heaviest individual flows
- Top hostnames (TLS SNI, HTTP Host, DNS query names)
- Top URLs
- Per-protocol breakdown
- Per-talker (IP) breakdown
- Activity timeline by minute

## 5. End-to-end smoke test

```bash
MYSQL_USER=root MYSQL_PASS=yourpass ./test.sh path/to/sample.pcap
```

Recognised env vars: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`,
`MYSQL_PASS`, `MYSQL_DB` (defaults to `flowmon_test`), `MYSQL_SOCKET`.
The script drops & recreates the test database on each run, launches
`flow_monitor`, streams the pcap, sends `SIGTERM`, and prints summary
counts. With no argument, it captures 5 seconds of live traffic via
`tcpdump` (needs `sudo`).

## 6. Schema

See the `create_schema()` block in `flow_monitor.cpp` — four tables:

| Table                   | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `flows`                 | One row per bidirectional flow (canonical hash). |
| `urls`                  | URLs extracted from HTTP traffic.                |
| `hostnames`             | TLS SNI / HTTP Host / DNS hostnames per flow.    |
| `applications_summary`  | Rolling per-application counters.                |

`flows.flow_hash` is the MD5 of the canonical 5-tuple (smaller IP first,
ties broken by smaller port). Both directions of a conversation share
the same hash, so re-ingesting the same pcap upserts rather than
duplicates (`ON DUPLICATE KEY UPDATE`).

InnoDB index-key-length limits force a couple of prefix indexes:
- `urls.url` is `VARCHAR(2048)` but the unique index is `(url(255), flow_id)`.
- `hostnames.hostname` is `VARCHAR(512)` with an index on the first 255 chars.

## 7. Configuration

Most options are CLI flags. `config.json` is a flat JSON file consumed
by `flow_monitor --config`:

| Key                    | Meaning                                          |
| ---------------------- | ------------------------------------------------ |
| `socket_path`          | Unix socket the monitor listens on.              |
| `mysql_host`           | MySQL host (default `127.0.0.1`).                |
| `mysql_port`           | MySQL TCP port (default 3306).                   |
| `mysql_user`           | MySQL user (default `root`).                    |
| `mysql_pass`           | MySQL password (empty by default).               |
| `mysql_db`             | Database name (default `flowmon`, auto-created). |
| `mysql_socket`         | Optional unix socket; overrides host/port.       |
| `flow_timeout_seconds` | Inactive-flow expiry window (default 60).        |
| `ndpi_max_packets`     | Packets fed to nDPI before giving up (def. 16).  |
| `sweep_every_packets`  | How often to scan for expired flows.             |
| `max_active_flows`     | Hard cap; oldest flow is evicted past this.      |

## 8. Notes & caveats

- **IPv4 only.** The wire-format `PacketMessage` uses a 32-bit address
  field; IPv6 support would require widening the header and is left as
  a follow-up.
- **Link layers handled:** Ethernet (with VLAN tags), DLT_RAW,
  DLT_LINUX_SLL/SLL2, BSD loopback. Anything else falls back to
  best-effort Ethernet.
- **nDPI version skew.** A handful of nDPI struct fields (`flow->http.url`,
  `flow->http.method`) are referenced by name; if you hit a build error
  on an older nDPI, comment out those references or upgrade to 5.x.
- **MySQL transactions.** Each pcap_processor connection is wrapped in a
  single transaction (with intermediate commits every 5000 packets) for
  bulk-insert throughput. On `SIGINT/SIGTERM` the daemon flushes the
  remaining flows in one final transaction before exit.
- **Memory hygiene.** Each `Flow` owns its `ndpi_flow_struct` and frees
  it via `ndpi_flow_free` on persistence; on shutdown all in-memory
  flows are flushed before the process exits.

## 9. Files in this repo

```
.
├── CMakeLists.txt
├── README.md
├── config.json
├── queries.sql
├── test.sh
└── src/
    ├── common.h           # IPC wire format
    ├── md5.h              # canonical-hash MD5
    ├── pcap_processor.cpp # producer
    └── flow_monitor.cpp   # consumer / detector / DB
```

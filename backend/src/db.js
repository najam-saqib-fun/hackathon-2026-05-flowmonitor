const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

let pool;
let poolPromise;
let supabaseClient;

function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
    );
  }
  return supabaseClient;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) throw new Error('DATABASE_URL environment variable is required');
      pool = new Pool({
        connectionString: dbUrl,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: (dbUrl.includes('supabase') || dbUrl.includes('neon.tech')) ? { rejectUnauthorized: false } : false,
      });
      await ensureSchema();
      return pool;
    })();
  }
  return poolPromise;
}

async function ensureSchema() {
  const client = await pool.connect();
  try {
    // Trigger function for updated_at columns
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$
    `);

    // ── flows (primary table written by C++ flow_monitor) ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id             BIGSERIAL PRIMARY KEY,
        flow_hash      CHAR(32)          NOT NULL,
        src_ip         VARCHAR(45)       NOT NULL,
        dst_ip         VARCHAR(45)       NOT NULL,
        src_port       INTEGER           NOT NULL,
        dst_port       INTEGER           NOT NULL,
        protocol       SMALLINT          NOT NULL,
        application    VARCHAR(255),
        start_time     TIMESTAMPTZ       NOT NULL,
        end_time       TIMESTAMPTZ,
        flow_duration_ms DOUBLE PRECISION,
        packet_sent    BIGINT            DEFAULT 0,
        packet_recv    BIGINT            DEFAULT 0,
        bytes_sent     BIGINT            DEFAULT 0,
        bytes_recv     BIGINT            DEFAULT 0,
        total_packets  BIGINT GENERATED ALWAYS AS (packet_sent + packet_recv) STORED,
        total_bytes    BIGINT GENERATED ALWAYS AS (bytes_sent  + bytes_recv)  STORED,
        urls           TEXT,
        hostnames      TEXT,
        metadata       TEXT,
        ipdr_key_id    BIGINT,
        created_at     TIMESTAMPTZ       DEFAULT NOW(),
        updated_at     TIMESTAMPTZ       DEFAULT NOW(),
        UNIQUE(flow_hash)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_times  ON flows(start_time, end_time)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_app    ON flows(application)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_ips    ON flows(src_ip, dst_ip)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_ports  ON flows(src_port, dst_port)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_ipdr   ON flows(ipdr_key_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flow_upd    ON flows(updated_at)`);
    await client.query(`
      CREATE OR REPLACE TRIGGER update_flows_updated_at
        BEFORE UPDATE ON flows
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // ── urls ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS urls (
        id           BIGSERIAL PRIMARY KEY,
        url          VARCHAR(2048)  NOT NULL,
        host         VARCHAR(255),
        path         VARCHAR(2048),
        query_params TEXT,
        protocol     VARCHAR(16),
        flow_id      BIGINT REFERENCES flows(id) ON DELETE CASCADE,
        first_seen   TIMESTAMPTZ    NOT NULL,
        last_seen    TIMESTAMPTZ    NOT NULL,
        access_count INTEGER        DEFAULT 1,
        UNIQUE(url, flow_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_url_host ON urls(host)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_url_flow ON urls(flow_id)`);

    // ── hostnames ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS hostnames (
        id               BIGSERIAL PRIMARY KEY,
        hostname         VARCHAR(512) NOT NULL,
        flow_id          BIGINT REFERENCES flows(id) ON DELETE CASCADE,
        first_seen       TIMESTAMPTZ,
        last_seen        TIMESTAMPTZ,
        resolution_count INTEGER DEFAULT 1
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hostname      ON hostnames(hostname)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hostname_flow ON hostnames(flow_id)`);

    // ── application_mappings ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS application_mappings (
        id           BIGSERIAL PRIMARY KEY,
        pattern_type TEXT        NOT NULL CHECK (pattern_type IN ('hostname_exact','hostname_suffix','ip_exact','ip_cidr')),
        pattern      VARCHAR(255) NOT NULL,
        application  VARCHAR(255) NOT NULL,
        category     VARCHAR(64),
        priority     INTEGER     NOT NULL DEFAULT 100,
        notes        VARCHAR(255),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(pattern_type, pattern)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_mapping_app ON application_mappings(application)`);

    // ── users ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(64)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role          TEXT         NOT NULL DEFAULT 'viewer'
                        CHECK (role IN ('admin','operator','viewer')),
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        last_login    TIMESTAMPTZ
      )
    `);

    // ── alert_rules ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id             SERIAL PRIMARY KEY,
        name           VARCHAR(128)     NOT NULL,
        metric         TEXT             NOT NULL
                         CHECK (metric IN ('bytes_per_sec','flows_per_min','conn_per_ip','unusual_port')),
        threshold      DOUBLE PRECISION NOT NULL,
        window_seconds INTEGER          DEFAULT 60,
        application    VARCHAR(255),
        src_ip         VARCHAR(45),
        dst_ip         VARCHAR(45),
        protocol       SMALLINT,
        enabled        BOOLEAN          DEFAULT TRUE,
        created_by     INTEGER,
        created_at     TIMESTAMPTZ      DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled)`);

    // ── alert_events ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id            BIGSERIAL PRIMARY KEY,
        rule_id       INTEGER          NOT NULL,
        triggered_at  TIMESTAMPTZ      DEFAULT NOW(),
        metric_value  DOUBLE PRECISION,
        details       TEXT,
        acknowledged  BOOLEAN          DEFAULT FALSE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events(rule_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_events_time ON alert_events(triggered_at)`);

    // ── subscribers ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id            SERIAL PRIMARY KEY,
        ip_address    VARCHAR(45)  NOT NULL UNIQUE,
        subscriber_id VARCHAR(128) NOT NULL,
        name          VARCHAR(255),
        notes         TEXT,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_subscribers_sid ON subscribers(subscriber_id)`);
    await client.query(`
      CREATE OR REPLACE TRIGGER update_subscribers_updated_at
        BEFORE UPDATE ON subscribers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // ── ipdr_keys ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ipdr_keys (
        id           BIGSERIAL PRIMARY KEY,
        key_string   VARCHAR(512) NOT NULL UNIQUE,
        src_ip       VARCHAR(45)  NOT NULL,
        dst_ip       VARCHAR(45)  NOT NULL,
        dst_port     INTEGER      NOT NULL,
        application  VARCHAR(255) DEFAULT '',
        packets_sent BIGINT       DEFAULT 0,
        bytes_sent   BIGINT       DEFAULT 0,
        packets_recv BIGINT       DEFAULT 0,
        bytes_recv   BIGINT       DEFAULT 0,
        first_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        last_seen    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        status       TEXT         DEFAULT 'active' CHECK (status IN ('active','closed'))
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ipdr_lookup   ON ipdr_keys(src_ip, dst_ip, dst_port, application, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ipdr_status   ON ipdr_keys(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ipdr_lastseen ON ipdr_keys(last_seen)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ipdr_src      ON ipdr_keys(src_ip)`);

    // ── protocol_metadata ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS protocol_metadata (
        id             BIGSERIAL PRIMARY KEY,
        flow_id        BIGINT      NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        tls_version    VARCHAR(20),
        sni            VARCHAR(512),
        ja3_client     VARCHAR(64),
        ja3_server     VARCHAR(64),
        tls_alpn       VARCHAR(256),
        issuer_dn      VARCHAR(512),
        subject_dn     VARCHAR(512),
        cert_not_after INTEGER,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proto_meta_flow ON protocol_metadata(flow_id)`);

    // ── applications_summary ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS applications_summary (
        id                  BIGSERIAL PRIMARY KEY,
        application         VARCHAR(255)     NOT NULL UNIQUE,
        category            VARCHAR(255),
        total_flows         BIGINT           DEFAULT 0,
        total_packets_sent  BIGINT           DEFAULT 0,
        total_packets_recv  BIGINT           DEFAULT 0,
        total_bytes_sent    BIGINT           DEFAULT 0,
        total_bytes_recv    BIGINT           DEFAULT 0,
        total_duration_ms   DOUBLE PRECISION DEFAULT 0,
        first_seen          TIMESTAMPTZ,
        last_seen           TIMESTAMPTZ,
        last_updated        TIMESTAMPTZ      DEFAULT NOW()
      )
    `);

    // ── capture_policy ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS capture_policy (
        application VARCHAR(255) NOT NULL PRIMARY KEY,
        enabled     BOOLEAN      NOT NULL DEFAULT TRUE
      )
    `);

    // Seed default admin if table is empty
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM users');
    if (rows[0].c === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('admin123', 10);
      await client.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        ['admin', hash]
      );
      logger.info('Seeded default admin user', { username: 'admin' });
    }
  } finally {
    client.release();
  }
}

async function query(sql, params) {
  const p = await getPool();
  const result = await p.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

module.exports = { getPool, getSupabaseClient, query, queryOne };

const mysql = require('mysql2/promise');

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'flowmon',
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      timezone: 'local',
    });
    await ensureSchema(pool);
  }
  return pool;
}

async function ensureSchema(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        metric ENUM('bytes_per_sec','flows_per_min','conn_per_ip','unusual_port') NOT NULL,
        threshold DOUBLE NOT NULL,
        window_seconds INT UNSIGNED DEFAULT 60,
        application VARCHAR(255),
        src_ip VARCHAR(45),
        dst_ip VARCHAR(45),
        protocol SMALLINT UNSIGNED,
        enabled TINYINT(1) DEFAULT 1,
        created_by INT UNSIGNED,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        rule_id INT UNSIGNED NOT NULL,
        triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metric_value DOUBLE,
        details TEXT,
        acknowledged TINYINT(1) DEFAULT 0,
        KEY idx_rule (rule_id),
        KEY idx_time (triggered_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        ip_address VARCHAR(45) NOT NULL,
        subscriber_id VARCHAR(128) NOT NULL,
        name VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_ip (ip_address),
        KEY idx_subscriber_id (subscriber_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ipdr_keys (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        key_string VARCHAR(512) NOT NULL,
        src_ip VARCHAR(45) NOT NULL,
        dst_ip VARCHAR(45) NOT NULL,
        dst_port INT UNSIGNED NOT NULL,
        application VARCHAR(255) DEFAULT '',
        packets_sent BIGINT UNSIGNED DEFAULT 0,
        bytes_sent BIGINT UNSIGNED DEFAULT 0,
        packets_recv BIGINT UNSIGNED DEFAULT 0,
        bytes_recv BIGINT UNSIGNED DEFAULT 0,
        first_seen DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        last_seen DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        status ENUM('active','closed') DEFAULT 'active',
        KEY idx_lookup (src_ip, dst_ip, dst_port, application(64), status),
        KEY idx_status (status),
        KEY idx_last_seen (last_seen),
        KEY idx_src (src_ip)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS protocol_metadata (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        flow_id BIGINT UNSIGNED NOT NULL,
        tls_version VARCHAR(20),
        sni VARCHAR(512),
        ja3_client VARCHAR(64),
        ja3_server VARCHAR(64),
        tls_alpn VARCHAR(256),
        issuer_dn VARCHAR(512),
        subject_dn VARCHAR(512),
        cert_not_after INT UNSIGNED,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_flow (flow_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migration: add ipdr_key_id to flows
    try { await conn.query('ALTER TABLE flows ADD COLUMN ipdr_key_id BIGINT UNSIGNED AFTER metadata'); } catch {}
    try { await conn.query('ALTER TABLE flows ADD KEY idx_flow_ipdr (ipdr_key_id)'); } catch {}
    // Migration: drop application_category (now computed via JOIN)
    try { await conn.query('ALTER TABLE flows DROP COLUMN application_category'); } catch {}
    // Migration: extend application_mappings ENUM
    try {
      await conn.query("ALTER TABLE application_mappings MODIFY COLUMN pattern_type ENUM('hostname_exact','hostname_suffix','ip_exact','ip_cidr') NOT NULL");
    } catch {}

    // Seed default admin if table is empty
    const [rows] = await conn.query('SELECT COUNT(*) as c FROM users');
    if (rows[0].c === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('admin123', 10);
      await conn.query(
        "INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')",
        [hash]
      );
      console.log('[db] Seeded default admin user (username: admin, password: admin123)');
    }
  } finally {
    conn.release();
  }
}

async function query(sql, params) {
  const pool = await getPool();
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

module.exports = { getPool, query, queryOne };

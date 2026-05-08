# PRD: QUIC Protocol Decryption & Application-Level Visibility
**FlowMon ISP Traffic Analytics Platform**
**Version**: 1.0 | **Date**: 2026-05-08 | **Status**: Draft for Engineering Review

---

## 1. Executive Summary

QUIC (RFC 9000) is now the dominant transport for high-volume internet traffic. YouTube, Google Search, Gmail, Google Drive, and most major CDNs default to QUIC (HTTP/3) in modern browsers. In our live capture environment the majority of traffic is QUIC flows that currently appear in FlowMon labeled only as **"QUIC"** with no application name, no SNI hostname, no ALPN, and no content attribution — invisible to all analytics, billing, and policy enforcement.

**This PRD defines the engineering requirements to extract full application-level metadata from QUIC flows** — the same richness currently available for TLS/HTTPS flows — by implementing passive QUIC Initial packet decryption based on RFC 9001 §5.2.

### Why This Is Solvable Today

Unlike application-layer payloads (protected by TLS 1.3 forward-secrecy), QUIC **Initial packets are cryptographically required to be passively decryptable by any network observer**. The encryption key for the Initial packet is derived from publicly visible connection identifiers using a fixed, RFC-published salt. Wireshark, Zeek, and nDPI 5.x all already perform this decryption transparently. The work for FlowMon is to unlock and surface what nDPI already computes.

### Business Impact

| Before | After |
|--------|-------|
| "QUIC" — 60–80% of traffic unattributed | "YouTube", "Netflix", "Google Meet" — per-flow attribution |
| Top Applications chart blind to majority of traffic | Full application breakdown including streaming, gaming, conferencing |
| Subscriber usage reporting shows raw bytes only | Per-application usage: video streaming hours, conferencing minutes |
| Policy enforcement cannot target QUIC apps | Throttling, blocking, alerting on QUIC applications |
| IPDR records show "QUIC/443" only | IPDR records with application + SNI for regulatory compliance |

---

## 2. Background & Problem Statement

### 2.1 What Is QUIC?

QUIC is a UDP-based transport protocol standardized in RFC 9000 (May 2021), designed as the transport layer for HTTP/3 (RFC 9114). It provides:
- Multiplexed streams (no head-of-line blocking)
- Built-in TLS 1.3 encryption
- 0-RTT connection resumption
- Connection migration (same session across IP changes)
- Integrated congestion control

Chrome uses QUIC for all Google services by default. Firefox uses QUIC for connections where servers advertise Alt-Svc HTTP/3 support. YouTube mobile apps use QUIC exclusively.

### 2.2 The Encryption Hierarchy

QUIC uses four distinct encryption levels:

| Packet Type | Encrypted With | Passively Decryptable? |
|-------------|---------------|----------------------|
| **Initial** | AES-128-GCM, key derived from cleartext DCID | **YES** — keys are deterministic from public data |
| **0-RTT** | Client early-traffic secret | No — requires session key material |
| **Handshake** | Ephemeral Diffie-Hellman | No — forward-secret |
| **1-RTT (Data)** | Application traffic secrets | No — forward-secret |

The critical insight: **Initial packets carry the TLS ClientHello, which contains SNI and ALPN. These packets are intentionally designed to be readable by network intermediaries** (RFC 9312, §3.3). The RFC explicitly acknowledges and accepts that observers can derive Initial packet keys.

### 2.3 What Initial Packet Decryption Reveals

From a single QUIC Initial packet (≈1200–2000 bytes, first UDP datagram of any new connection):

| Field | Example Value | Business Use |
|-------|--------------|-------------|
| **SNI (Server Name Indication)** | `r7---sn-ab5l6ner.googlevideo.com` | Application identification |
| **ALPN** | `h3` | Protocol version / service type |
| **TLS Cipher Suites** | `TLS_AES_128_GCM_SHA256` | Security audit |
| **QUIC Version** | `0x00000001` (QUIC v1) | Implementation fingerprint |
| **JA3 Fingerprint** | `e85c...` | Client device/browser identification |
| **QUIC Transport Parameters** | `max_idle_timeout: 30s` | Connection behavior |
| **Supported TLS Versions** | `TLS 1.3` | Compliance verification |

### 2.4 Current State in FlowMon

**C++ layer** (`flow_monitor.cpp`):
- `proto_is_tls_family()` **already includes** `NDPI_PROTOCOL_QUIC` — the guard is correct
- `capture_extracted()` already reads `protos.tls_quic.server_names`, ALPN, JA3, and TLS version when `tls_ok = true`
- The code path is correct; **the issue is whether nDPI can perform the underlying decryption**

**Root cause**: nDPI 5.x performs QUIC Initial packet decryption using **libgcrypt ≥ 1.9.2** for HKDF-SHA256 and AES-GCM operations. If:
1. libgcrypt is not installed, or
2. libgcrypt < 1.9.2 is installed, or
3. nDPI was compiled without libgcrypt support (`./configure` without `--with-libgcrypt`),

then nDPI classifies flows as "QUIC" but cannot extract SNI/ALPN from the decrypted ClientHello, falling back to IP/port heuristics only.

**Additionally**, nDPI may populate `flow->protos.tls_quic.server_names` for QUIC, while the current `capture_extracted()` implementation only reads `flow->host_server_name` (a different field used for HTTP and DNS, not the TLS-extracted SNI). This means even if nDPI decrypts the Initial packet, the SNI may be in a field the current code doesn't read.

### 2.5 Scope Boundary

| In Scope | Out of Scope |
|----------|-------------|
| IETF QUIC v1, v2, all drafts | 1-RTT data decryption (impossible without keys) |
| SNI, ALPN, JA3, TLS version extraction | QUIC stream-level HTTP/3 request parsing |
| Application identification via SNI | Active MITM / key injection |
| gQUIC version detection | gQUIC ClientHello parsing (uses proprietary format) |
| Encrypted Client Hello (ECH) detection | ECH inner ClientHello decryption |
| QUIC connection tracking and IPDR | Deep packet inspection of QUIC data frames |

---

## 3. Research Findings

### 3.1 RFC 9001 §5.2 — Initial Packet Key Derivation

Initial packet keys are derived deterministically from the **Destination Connection ID (DCID)**, which is in cleartext in every QUIC long header:

```
Step 1: HKDF-Extract(SHA-256)
  initial_secret = HKDF-Extract(
    salt = 0x38762cf7f55934b34d179ae6a4c80cadccbb7f0a  ← fixed, RFC-published
    IKM  = client_dcid                                ← cleartext in packet header
  )

Step 2: Directional secrets
  client_initial_secret = HKDF-Expand-Label(initial_secret, "client in", "", 32)
  server_initial_secret = HKDF-Expand-Label(initial_secret, "server in", "", 32)

Step 3: Symmetric key material
  key = HKDF-Expand-Label(client_initial_secret, "quic key", "", 16)  ← AES-128 key
  iv  = HKDF-Expand-Label(client_initial_secret, "quic iv",  "", 12)  ← GCM nonce base
  hp  = HKDF-Expand-Label(client_initial_secret, "quic hp",  "", 16)  ← header protection

Step 4: Remove header protection (AES-128-ECB)
  sample = ciphertext[first_pn_byte + 4 : +16]
  mask   = AES-ECB-Encrypt(hp, sample)
  first_byte    ^= (mask[0] & 0x0f)
  packet_number ^= mask[1:1+pn_length]

Step 5: Decrypt payload (AES-128-GCM)
  nonce     = iv XOR zero_padded(packet_number)
  plaintext = AES-128-GCM-Decrypt(key, nonce, AAD=cleartext_header, ciphertext)
```

QUIC v2 (RFC 9369) uses a different salt (`0x0dede3def700a6db819381be6e269dcbf9bd2ed9`) and label prefix (`"quicv2 key"` etc.) — same algorithm, different constants.

### 3.2 CRYPTO Frame → TLS ClientHello → SNI

After decryption, the plaintext payload contains QUIC frames. Frame type `0x06` (CRYPTO) carries TLS handshake data:

```
[0x06]                          ← CRYPTO frame type
[VarInt: offset=0]              ← stream offset (0 for first segment)
[VarInt: length=N]              ← data length
[N bytes: TLS ClientHello]      ← standard TLS 1.3 ClientHello

TLS ClientHello extensions:
  0x0000 server_name → SNI hostname  (e.g., "youtube.com")
  0x0010 ALPN        → ["h3", "h3-29"] 
  0x0039 quic_transport_parameters
  0x002b supported_versions → [TLS 1.3]
  0x0033 key_share → DH public key group + key
```

In ≥95% of connections the entire ClientHello fits in a single UDP datagram. Fragmented ClientHellos (split across multiple packets) require reassembly — nDPI handles this up to 65,536 bytes.

### 3.3 nDPI 5.x QUIC Dissector Capabilities

nDPI 5.x (`src/lib/protocols/quic.c`) fully implements the above pipeline:

| Capability | Status |
|-----------|--------|
| IETF QUIC v1/v2 Initial decryption | ✓ Implemented |
| All IETF draft versions (22–34) | ✓ Implemented (per-version salt table) |
| gQUIC (Q050, T051) | ✓ Pattern detection only (no ClientHello decryption) |
| SNI extraction → `protos.tls_quic.server_names` | ✓ Implemented |
| ALPN extraction → `protos.tls_quic.negotiated_alpn` + `advertised_alpns` | ✓ Implemented |
| JA3 fingerprint → `protos.tls_quic.ja3_server` | ✓ Implemented |
| JA4 fingerprint → `protos.tls_quic.ja4_client` | ✓ Implemented |
| QUIC version → `protos.tls_quic.quic_version` | ✓ Implemented |
| QUIC transport parameters → `quic_idle_timeout_sec` | ✓ Implemented |
| CRYPTO frame reassembly | ✓ Up to 65,536 bytes |
| **Requires libgcrypt ≥ 1.9.2** | ⚠️ Compile-time dependency |

**SNI field path** (nDPI 5.x): `flow->protos.tls_quic.server_names` (a `char*` pointer).
For QUIC, `flow->host_server_name` (the legacy DNS/HTTP field) may **not** be populated.

### 3.4 YouTube QUIC Traffic Profile

When YouTube plays in Chrome:

| Attribute | Value |
|-----------|-------|
| Protocol | QUIC v1 (IETF) |
| UDP port | 443 (server-side) |
| ALPN | `h3` |
| SNI pattern | `r{N}---sn-{token}.googlevideo.com` (video CDN) |
| Additional SNIs | `youtube.com`, `yt3.ggpht.com`, `accounts.google.com` |
| Packet rate | High uplink (ACKs), very high downlink (video segments) |
| Packet size | Max MTU (1350–1500 bytes) for video segments |
| Flow count | 3–8 concurrent QUIC connections per video |

The CDN domain pattern `*.googlevideo.com` is the single most reliable YouTube indicator. Any ISP application mapping that resolves `*.googlevideo.com` → "YouTube" provides immediate, accurate classification.

### 3.5 Encrypted Client Hello (ECH) — Future Limitation

ECH (RFC 9849, standardized 2025) wraps the real ClientHello inside an encrypted outer ClientHello. The outer ClientHello contains only a `public_name` (e.g., `cloudflare-ech.com`) — not the real SNI.

| Deployment | Impact on SNI extraction |
|-----------|------------------------|
| Current (non-ECH) | SNI fully extractable — 100% of connections |
| ECH-enabled sites (Cloudflare, ~30%) | Only `public_name` visible; ALPN still visible |
| ECH + ESNI future | Fully opaque; fall back to IP-ASN classification |

ECH adoption is accelerating but will not affect Google/YouTube traffic in the near term (Google does not currently deploy ECH). This PRD's approach is valid for the foreseeable 2–3 year horizon.

---

## 4. Functional Requirements

### 4.1 Phase 1 — Fix nDPI QUIC Decryption (Critical Path)

**FR-1.1: Verify and fix libgcrypt dependency**
- System must have libgcrypt ≥ 1.9.2 installed
- nDPI build must be configured with libgcrypt support enabled
- Build system must emit a clear error if libgcrypt is missing or too old
- Acceptance: `ndpi_is_quic_packet()` on a test QUIC pcap returns SNI ≠ empty

**FR-1.2: Read QUIC SNI from correct nDPI field**
- `capture_extracted()` must read `flow->protos.tls_quic.server_names` for QUIC flows
- Must NOT rely solely on `flow->host_server_name` for QUIC (that field is for HTTP/DNS)
- Both fields should be checked; `server_names` takes priority for QUIC
- Acceptance: YouTube QUIC flow shows `hostnames: ["r7---sn-xxx.googlevideo.com"]`

**FR-1.3: Extract QUIC-specific metadata fields**

All fields below must be populated for QUIC flows and stored in the `metadata` JSON blob:

| Field | nDPI Source | DB Column / JSON Key |
|-------|-------------|---------------------|
| SNI hostname | `protos.tls_quic.server_names` | `hostnames[]` array |
| ALPN (negotiated) | `protos.tls_quic.negotiated_alpn` | `metadata.tls_alpn` |
| ALPN (advertised list) | `protos.tls_quic.advertised_alpns` | `metadata.quic_alpns` |
| QUIC version | `protos.tls_quic.quic_version` | `metadata.quic_version` |
| QUIC version string | Derived from version uint32 | `metadata.quic_version_str` |
| TLS version | `protos.tls_quic.ssl_version` | `metadata.tls_version` |
| JA3 fingerprint | `protos.tls_quic.ja3_server[33]` | `metadata.ja3_client` |
| JA4 fingerprint | `protos.tls_quic.ja4_client[37]` | `metadata.ja4_client` |
| Idle timeout | `protos.tls_quic.quic_idle_timeout_sec` | `metadata.quic_idle_timeout_sec` |
| Certificate issuer | `protos.tls_quic.issuerDN` | `metadata.tls_issuer_dn` |
| Certificate subject | `protos.tls_quic.subjectDN` | `metadata.tls_subject_dn` |
| Cert expiry | `protos.tls_quic.notAfter` | `metadata.tls_cert_not_after` |

**FR-1.4: Application identification via QUIC SNI**
- QUIC SNI hostname must feed into `apply_mapping_override()` — same path as TLS SNI
- Application mappings of type `hostname_suffix` must match QUIC SNI (e.g., `googlevideo.com` → "YouTube")
- Acceptance: QUIC flow with SNI `r7---sn-ab5.googlevideo.com` shows application = "YouTube"

**FR-1.5: QUIC version classification**

| Version Value | String Label |
|--------------|-------------|
| `0x00000001` | QUIC v1 |
| `0x6b3343cf` | QUIC v2 |
| `0xff000022`–`0xff00001b` | QUIC Draft 22–34 |
| `0x51xxxxxx` (Q-prefix) | gQUIC |
| `0xfaceb0xx` | Facebook QUIC |
| `0xabcd0xxx` | Microsoft QUIC |
| Other | QUIC (unknown version) |

### 4.2 Phase 2 — Seed Application Mappings for QUIC Destinations

**FR-2.1: Built-in QUIC application mapping seed table**

Add to `FlowDB::seed_app_mappings()` a comprehensive set of hostname-suffix → application mappings covering top QUIC-capable services:

| Pattern | Type | Application | Category |
|---------|------|------------|---------|
| `googlevideo.com` | hostname_suffix | YouTube | Video Streaming |
| `youtube.com` | hostname_suffix | YouTube | Video Streaming |
| `ytimg.com` | hostname_suffix | YouTube | Video Streaming |
| `ggpht.com` | hostname_suffix | YouTube | Video Streaming |
| `netflix.com` | hostname_suffix | Netflix | Video Streaming |
| `nflxvideo.net` | hostname_suffix | Netflix | Video Streaming |
| `nflximg.net` | hostname_suffix | Netflix | Video Streaming |
| `tiktokv.com` | hostname_suffix | TikTok | Social Media |
| `musical.ly` | hostname_suffix | TikTok | Social Media |
| `twitch.tv` | hostname_suffix | Twitch | Video Streaming |
| `jtvnw.net` | hostname_suffix | Twitch | Video Streaming |
| `facebook.com` | hostname_suffix | Facebook | Social Media |
| `fbcdn.net` | hostname_suffix | Facebook | Social Media |
| `instagram.com` | hostname_suffix | Instagram | Social Media |
| `cdninstagram.com` | hostname_suffix | Instagram | Social Media |
| `whatsapp.net` | hostname_suffix | WhatsApp | Messaging |
| `whatsapp.com` | hostname_suffix | WhatsApp | Messaging |
| `zoom.us` | hostname_suffix | Zoom | Video Conferencing |
| `zmtrial.com` | hostname_suffix | Zoom | Video Conferencing |
| `meet.google.com` | hostname_exact | Google Meet | Video Conferencing |
| `teams.microsoft.com` | hostname_suffix | Microsoft Teams | Video Conferencing |
| `skype.com` | hostname_suffix | Skype | Video Conferencing |
| `spotify.com` | hostname_suffix | Spotify | Music Streaming |
| `scdn.co` | hostname_suffix | Spotify | Music Streaming |
| `cloudflare.com` | hostname_suffix | Cloudflare CDN | CDN |
| `discord.com` | hostname_suffix | Discord | Messaging |
| `discordapp.com` | hostname_suffix | Discord | Messaging |
| `snapchat.com` | hostname_suffix | Snapchat | Social Media |
| `sc-cdn.net` | hostname_suffix | Snapchat | Social Media |
| `twitter.com` | hostname_suffix | Twitter/X | Social Media |
| `twimg.com` | hostname_suffix | Twitter/X | Social Media |
| `x.com` | hostname_suffix | Twitter/X | Social Media |
| `reddit.com` | hostname_suffix | Reddit | Social Media |
| `redd.it` | hostname_suffix | Reddit | Social Media |
| `redditmedia.com` | hostname_suffix | Reddit | Social Media |
| `apple.com` | hostname_suffix | Apple Services | App Store |
| `icloud.com` | hostname_suffix | iCloud | Cloud Storage |
| `dropbox.com` | hostname_suffix | Dropbox | Cloud Storage |
| `amazonaws.com` | hostname_suffix | AWS | Cloud |
| `microsoft.com` | hostname_suffix | Microsoft | Cloud |
| `akamaied.net` | hostname_suffix | Akamai CDN | CDN |
| `fastly.net` | hostname_suffix | Fastly CDN | CDN |

**FR-2.2: Operator-configurable QUIC application rules**
- All seeded mappings are editable via the App Mappings UI (already exists)
- No hardcoded business logic; everything flows through `application_mappings` table
- Admin can add/remove/override any mapping

### 4.3 Phase 3 — Backend API Enhancements

**FR-3.1: QUIC-specific query filters**

Add `quic_only` and `protocol_filter` query parameters to:
- `GET /api/flows` — filter to QUIC-protocol flows
- `GET /api/stats/top-apps` — break down by protocol (TCP/UDP/QUIC)
- `GET /api/stats/top-talkers` — QUIC-only view

**FR-3.2: QUIC metadata in flow detail response**

`GET /api/flows/:id` must return parsed QUIC metadata from the `metadata` JSON:

```json
{
  "id": 1234,
  "application": "YouTube",
  "protocol": 17,
  "quic": {
    "version": "QUIC v1",
    "version_hex": "0x00000001",
    "alpn": "h3",
    "advertised_alpns": ["h3", "h3-29"],
    "idle_timeout_sec": 30,
    "sni": "r7---sn-ab5l6ner.googlevideo.com",
    "ja3": "e85c12d95d4a69daa36bc0d0d4da1e45",
    "tls_version": "TLS1.3"
  }
}
```

**FR-3.3: QUIC traffic breakdown statistics endpoint**

New endpoint: `GET /api/stats/quic-breakdown`

Response:
```json
{
  "total_quic_flows": 45231,
  "total_quic_bytes": 182937645,
  "quic_pct_of_total_bytes": 67.3,
  "version_breakdown": [
    { "version": "QUIC v1",  "version_hex": "0x00000001", "flows": 41000, "bytes": 172000000 },
    { "version": "QUIC v2",  "version_hex": "0x6b3343cf", "flows": 2100,  "bytes": 8000000   },
    { "version": "gQUIC",    "version_hex": "0x51303530", "flows": 2131,  "bytes": 2937645   }
  ],
  "alpn_breakdown": [
    { "alpn": "h3",    "flows": 43000, "bytes": 180000000 },
    { "alpn": "h3-29", "flows": 2231,  "bytes": 2937645   }
  ],
  "top_sni_applications": [
    { "application": "YouTube",  "sni_matches": 18500, "bytes": 95000000 },
    { "application": "Netflix",  "sni_matches": 7200,  "bytes": 42000000 },
    { "application": "Zoom",     "sni_matches": 3100,  "bytes": 8500000  }
  ],
  "ech_detected": 1240,
  "sni_extracted_pct": 97.2
}
```

**FR-3.4: ALPN filter on existing endpoints**

`GET /api/flows?alpn=h3` must filter to flows where `metadata.tls_alpn = 'h3'` (MySQL JSON path query or indexed column).

### 4.4 Phase 4 — Frontend Dashboard Enhancements

**FR-4.1: QUIC visibility panel on Dashboard**

New card section on Dashboard (below or alongside Top Applications):

```
┌─────────────────────────────────────────────────────┐
│  QUIC Traffic                          67% of total  │
│                                                      │
│  ■■■■■■■■■■■■■■■■ QUIC v1    93%                   │
│  ■■              QUIC v2      5%                    │
│  ■               gQUIC        2%                    │
│                                                      │
│  h3: 95.4%  •  h3-29: 4.1%  •  other: 0.5%        │
│  SNI extracted: 97.2%  •  ECH (opaque): 2.8%       │
└─────────────────────────────────────────────────────┘
```

**FR-4.2: QUIC metadata in Flow Detail modal**

When a user opens a QUIC flow in the Flows table:
- Show QUIC section in the detail modal with version, ALPN, idle timeout
- Show SNI alongside the existing hostnames list with a "QUIC" badge
- JA3 fingerprint with a "QUIC" label

**FR-4.3: Application filter — QUIC indicator**

In the Top Applications panel, QUIC-sourced applications show a `QUIC` badge.

**FR-4.4: Flows table — protocol column enhancement**

The flows table protocol column shows "QUIC v1", "QUIC v2", or "gQUIC" instead of raw "UDP/443".

---

## 5. Non-Functional Requirements

**NFR-1: Performance**
- QUIC Initial packet processing must add < 0.2ms per packet to nDPI pipeline
- Peak throughput must not degrade below 10 Gbps (hardware permitting)
- AES-GCM decryption leverages AES-NI hardware instruction when available (OpenSSL/libgcrypt do this automatically)
- CRYPTO frame reassembly buffer limit: 65,536 bytes (nDPI default, do not reduce)

**NFR-2: Correctness**
- SNI extraction accuracy: ≥ 97% for non-ECH QUIC v1 flows (matching Zeek/Wireshark baseline)
- Zero false-positive SNI attribution (wrong hostname assigned to wrong flow)
- QUIC version detection: 100% for RFC-specified versions (v1, v2, drafts)
- Must handle CRYPTO frame fragmentation (ClientHello split across packets) correctly

**NFR-3: Failure isolation**
- QUIC decryption failure (malformed packet, unknown version, libgcrypt error) must not crash the flow_monitor daemon
- On decryption failure: classify as "QUIC" with no metadata — same as current behavior
- No memory leaks from CRYPTO frame reassembly buffers

**NFR-4: Backward compatibility**
- All existing TLS/HTTPS flow behavior must remain identical
- Existing DB schema must remain unchanged (use existing `metadata` JSON column)
- New `metadata` JSON keys are additive only — no breaking changes

**NFR-5: Version coverage**
| Version Family | Must Detect | Must Decrypt |
|---------------|-------------|-------------|
| QUIC v1 (RFC 9000) | ✓ | ✓ |
| QUIC v2 (RFC 9369) | ✓ | ✓ |
| QUIC Draft 22–34 | ✓ | ✓ |
| gQUIC Q043–Q050 | ✓ | Detection only (no TLS ClientHello) |
| Facebook QUIC | ✓ | ✓ (same IETF format) |

---

## 6. Technical Architecture

### 6.1 Data Flow (Current vs Target)

**Current QUIC data flow:**
```
UDP packet (port 443) → pcap_processor → flow_monitor
  → nDPI classifies as NDPI_PROTOCOL_QUIC (protocol ID 188)
  → ndpi_detection_giveup() → application = "QUIC"
  → capture_extracted() checks tls_ok = proto_is_tls_family() ← TRUE (QUIC is included)
  → tries to read protos.tls_quic.server_names ← NULL (libgcrypt missing OR wrong field read)
  → hostnames[] = [] (empty)
  → DB: application="QUIC", hostnames="[]", metadata={}
  → apply_mapping_override() → no match → stays "QUIC"
```

**Target QUIC data flow:**
```
UDP packet (port 443) → pcap_processor → flow_monitor
  → nDPI receives L3 snapshot → detects long header QUIC
  → nDPI derives Initial keys from DCID (libgcrypt HKDF-SHA256)
  → nDPI removes header protection (AES-128-ECB)
  → nDPI decrypts payload (AES-128-GCM)
  → nDPI parses CRYPTO frame → TLS ClientHello
  → nDPI extracts: SNI="r7---sn-xxx.googlevideo.com", ALPN="h3", JA3="e85c...", version=QUIC_V1
  → stores in protos.tls_quic.server_names, negotiated_alpn, quic_version
  → capture_extracted() reads server_names → hostnames = ["r7---sn-xxx.googlevideo.com"]
  → DB: application="QUIC", hostnames=["r7---sn-xxx.googlevideo.com"], metadata={quic_version:1, alpn:"h3"}
  → apply_mapping_override() → "googlevideo.com" suffix match → application = "YouTube"
  → DB: application="YouTube", hostnames=["r7---sn-xxx.googlevideo.com"]
```

### 6.2 Component Changes

#### 6.2.1 Build System (CMakeLists.txt)

```cmake
# Required: libgcrypt ≥ 1.9.2 for QUIC Initial decryption in nDPI
find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBGCRYPT REQUIRED libgcrypt>=1.9.2)
if(NOT LIBGCRYPT_FOUND)
  message(FATAL_ERROR "libgcrypt ≥ 1.9.2 required for QUIC decryption. Install: apt install libgcrypt20-dev")
endif()

# Rebuild nDPI with libgcrypt support:
# cd third_party/nDPI && ./autogen.sh && ./configure --with-libgcrypt
# The PKG_CONFIG_PATH must include libgcrypt
```

#### 6.2.2 C++ — `capture_extracted()` in `flow_monitor.cpp`

Fix the SNI read path to cover the QUIC-specific field:

```cpp
void capture_extracted(Flow& f, bool tls_ok) {
    // --- Hostname from HTTP/DNS (existing, unchanged) ---
    const char* hs = f.ndpi_flow->host_server_name;
    if (hs && *hs) {
        std::string host(hs);
        if (f.hostnames_set.insert(host).second) f.hostnames.push_back(host);
    }

    // --- NEW: SNI from TLS/QUIC ClientHello ---
    if (tls_ok) {
        auto& tq = f.ndpi_flow->protos.tls_quic;

        // server_names is a char* with comma-separated SNI entries in nDPI 5.x
        if (tq.server_names && *tq.server_names) {
            // Parse comma-separated list: "host1.com,host2.com"
            std::string sni_raw(tq.server_names);
            std::stringstream ss(sni_raw);
            std::string token;
            while (std::getline(ss, token, ',')) {
                if (!token.empty() && f.hostnames_set.insert(token).second) {
                    f.hostnames.push_back(token);
                }
            }
        }

        // --- QUIC-specific metadata ---
        if (tq.quic_version && !f.quic_version) {
            f.quic_version = tq.quic_version;
        }
        if (tq.quic_idle_timeout_sec && !f.quic_idle_timeout_sec) {
            f.quic_idle_timeout_sec = tq.quic_idle_timeout_sec;
        }
        if (tq.negotiated_alpn && *tq.negotiated_alpn && f.tls_alpn.empty()) {
            f.tls_alpn = tq.negotiated_alpn;
        }
        if (tq.advertised_alpns && *tq.advertised_alpns && f.quic_advertised_alpns.empty()) {
            f.quic_advertised_alpns = tq.advertised_alpns;
        }
        // ... existing TLS fields (ssl_version, ja3, certs) ...
    }
}
```

New `Flow` struct members:

```cpp
struct Flow {
    // ... existing members ...
    uint32_t quic_version          = 0;
    uint32_t quic_idle_timeout_sec = 0;
    std::string quic_advertised_alpns;
};
```

#### 6.2.3 C++ — `persist_flow_id()` metadata JSON

Add QUIC fields to the metadata JSON serialization:

```cpp
// In the JSON metadata builder:
if (f.quic_version) {
    json["quic_version"]          = static_cast<int64_t>(f.quic_version);
    json["quic_version_str"]      = quic_version_to_string(f.quic_version);
}
if (f.quic_idle_timeout_sec)
    json["quic_idle_timeout_sec"] = static_cast<int64_t>(f.quic_idle_timeout_sec);
if (!f.quic_advertised_alpns.empty())
    json["quic_alpns"]            = f.quic_advertised_alpns;
```

Helper function:
```cpp
std::string quic_version_to_string(uint32_t v) {
    if (v == 0x00000001) return "QUIC v1";
    if (v == 0x6b3343cf) return "QUIC v2";
    if ((v & 0xff000000) == 0xff000000) {
        uint8_t draft = v & 0xff;
        return "QUIC Draft-" + std::to_string(draft);
    }
    if ((v >> 8) == 0x513030 || (v >> 8) == 0x543030) {
        char buf[8] = {0};
        buf[0] = (v >> 24) & 0xff;
        buf[1] = (v >> 16) & 0xff;
        buf[2] = (v >> 8) & 0xff;
        buf[3] = v & 0xff;
        return std::string("gQUIC-") + (buf + 1); // "Q050" → "gQUIC-050"
    }
    char hex[12];
    snprintf(hex, sizeof(hex), "0x%08x", v);
    return std::string("QUIC (") + hex + ")";
}
```

#### 6.2.4 Backend — New QUIC Stats Endpoint

`backend/src/routes/stats.js` — add:

```javascript
// GET /api/stats/quic-breakdown
router.get('/quic-breakdown', requireAuth, async (req, res) => {
  try {
    const { where, vals } = timeRange(req.query);
    const quicWhere = where
      ? where + " AND protocol = 17 AND (dst_port = 443 OR src_port = 443)"
      : "WHERE protocol = 17 AND (dst_port = 443 OR src_port = 443)";

    const [totalQuic, totalAll, versionBreakdown, alpnBreakdown, topApps] = await Promise.all([
      query(`SELECT COUNT(*) as flows, COALESCE(SUM(total_bytes),0) as bytes
             FROM flows ${quicWhere}
             AND JSON_EXTRACT(metadata, '$.quic_version') IS NOT NULL`, vals),

      query(`SELECT COUNT(*) as flows, COALESCE(SUM(total_bytes),0) as bytes FROM flows ${where || ''}`, vals),

      query(`SELECT
               JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.quic_version_str')) as version,
               JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.quic_version')) as version_hex,
               COUNT(*) as flows,
               COALESCE(SUM(total_bytes),0) as bytes
             FROM flows
             WHERE JSON_EXTRACT(metadata, '$.quic_version') IS NOT NULL
             GROUP BY version, version_hex
             ORDER BY flows DESC`, []),

      query(`SELECT
               JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.tls_alpn')) as alpn,
               COUNT(*) as flows,
               COALESCE(SUM(total_bytes),0) as bytes
             FROM flows
             WHERE JSON_EXTRACT(metadata, '$.tls_alpn') IS NOT NULL
               AND JSON_EXTRACT(metadata, '$.quic_version') IS NOT NULL
             GROUP BY alpn ORDER BY flows DESC LIMIT 20`, []),

      query(`SELECT application, COUNT(*) as sni_matches, COALESCE(SUM(total_bytes),0) as bytes
             FROM flows
             WHERE JSON_EXTRACT(metadata, '$.quic_version') IS NOT NULL
               AND application != 'QUIC'
             GROUP BY application ORDER BY bytes DESC LIMIT 10`, []),
    ]);

    const tq = totalQuic[0];
    const ta = totalAll[0];
    res.json({
      total_quic_flows: tq.flows,
      total_quic_bytes: tq.bytes,
      quic_pct_of_total_bytes: ta.bytes > 0 ? +(tq.bytes / ta.bytes * 100).toFixed(1) : 0,
      version_breakdown: versionBreakdown,
      alpn_breakdown: alpnBreakdown,
      top_sni_applications: topApps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

#### 6.2.5 Database Schema Additions (Optional Index for Phase 3)

```sql
-- Add generated column for ALPN to enable fast filtering
-- (avoids full-table JSON_EXTRACT scan)
ALTER TABLE flows ADD COLUMN quic_alpn VARCHAR(32)
  GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.tls_alpn'))) VIRTUAL;

ALTER TABLE flows ADD KEY idx_quic_alpn (quic_alpn);
ALTER TABLE flows ADD KEY idx_protocol_port (protocol, dst_port);
```

---

## 7. Implementation Plan

### Phase 0 — Diagnosis (1 day)

**Goal**: Confirm root cause and establish baseline.

- [ ] Check libgcrypt version: `apt list --installed | grep libgcrypt` / `libgcrypt-config --version`
- [ ] Verify nDPI was compiled with libgcrypt: `ldd build/flow_monitor | grep gcrypt`
- [ ] Capture a QUIC trace: `sudo tcpdump -i wlp1s0 -w /tmp/quic.pcap udp port 443`
- [ ] Verify nDPI can extract SNI: `ndpiReader -i /tmp/quic.pcap -v 3 2>&1 | grep -i "server_name\|sni\|quic\|youtube"`
- [ ] Confirm `host_server_name` vs `server_names` field population for QUIC in nDPI output
- [ ] Document current vs expected output with packet count

**Success criteria**: We know exactly which code path is failing (missing libgcrypt, wrong field read, or missing mapping).

### Phase 1 — Core Fix (2–3 days)

**Goal**: Get SNI and ALPN populating for QUIC flows.

- [ ] Install/upgrade libgcrypt: `sudo apt install libgcrypt20-dev`
- [ ] Rebuild nDPI from source with libgcrypt (if installed from third_party):
  ```bash
  cd third_party/nDPI
  ./autogen.sh && ./configure --with-libgcrypt \
    PKG_CONFIG_PATH="$(pkg-config --variable=pcfiledir libgcrypt)"
  make -j$(nproc) && make install
  ```
- [ ] Update `CMakeLists.txt` to require libgcrypt and link it
- [ ] Fix `capture_extracted()` to read `protos.tls_quic.server_names` for QUIC flows
- [ ] Add `quic_version`, `quic_idle_timeout_sec`, `quic_advertised_alpns` to `Flow` struct
- [ ] Add QUIC metadata fields to `persist_flow_id()` JSON serialization
- [ ] Add `quic_version_to_string()` helper
- [ ] Integration test: play YouTube in Chrome while flow_monitor runs, verify SNI appears

**Acceptance test**:
```bash
# Should show: hostnames=["r7---sn-xxx.googlevideo.com"], metadata.tls_alpn="h3"
mysql flowmon -e "SELECT application, hostnames, JSON_EXTRACT(metadata,'$.tls_alpn') as alpn,
                  JSON_EXTRACT(metadata,'$.quic_version_str') as qver
                  FROM flows WHERE protocol=17 AND dst_port=443
                  ORDER BY updated_at DESC LIMIT 10;"
```

### Phase 2 — Application Mappings (1 day)

**Goal**: QUIC flows automatically named as "YouTube", "Netflix", etc.

- [ ] Add comprehensive mapping seed table to `FlowDB::seed_app_mappings()` (FR-2.1 list above)
- [ ] Test: play YouTube → flow shows `application = "YouTube"`
- [ ] Test: open Netflix → flow shows `application = "Netflix"`
- [ ] UI test: Top Applications panel shows YouTube/Netflix instead of "QUIC"

### Phase 3 — API + Backend Enhancements (2 days)

- [ ] Add `GET /api/stats/quic-breakdown` endpoint
- [ ] Add `protocol` filter to `GET /api/flows`
- [ ] Add `alpn` filter to `GET /api/flows`
- [ ] Parse and return QUIC metadata from `metadata` JSON in `GET /api/flows/:id`
- [ ] Add optional MySQL generated column + index for ALPN filtering (performance)
- [ ] Update API surface documentation in CLAUDE.md

### Phase 4 — Frontend (3 days)

- [ ] QUIC visibility card on Dashboard
- [ ] QUIC metadata section in Flow Detail modal
- [ ] Protocol badge in Flows table (QUIC v1 / gQUIC / etc.)
- [ ] QUIC breakdown chart (pie: version, ALPN breakdown bar)
- [ ] Application filter with QUIC source indicator

### Phase 5 — ECH Handling (1 day)

- [ ] Detect ECH presence from first-byte encrypted outer ClientHello extension type `0xfe0d`
- [ ] Set `metadata.ech_detected = true` for ECH flows
- [ ] Surface ECH metric in QUIC breakdown panel
- [ ] Log ECH-detected flows separately for tracking adoption over time

---

## 8. Success Metrics

| Metric | Baseline (Today) | Target (Phase 1+2) |
|--------|-----------------|-------------------|
| QUIC flows with SNI extracted | 0% | ≥ 97% |
| QUIC flows with application attribution | ~5% (IP mapping) | ≥ 85% |
| YouTube traffic correctly labeled | ~0% | ≥ 95% |
| "QUIC" bucket in Top Applications | 60–80% of traffic | < 5% |
| ALPN extracted for QUIC flows | 0% | ≥ 97% |
| QUIC JA3 fingerprint extracted | 0% | ≥ 90% |

---

## 9. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| libgcrypt version too old in production | Medium | High | Diagnose in Phase 0; provide install script |
| nDPI compiled without libgcrypt at build time | High | High | Check with `ldd`; rebuild nDPI if needed |
| `server_names` field format changed in nDPI 5.x | Low | Medium | Read nDPI 5.x changelog; unit test with known pcap |
| QUIC version diversity — unknown version not decrypted | Medium | Low | Unknown versions still classified as "QUIC"; log version hex for future support |
| Performance degradation from AES-GCM per-packet | Low | Medium | AES-NI hardware acceleration is automatic; benchmark before/after |
| ECH deployment hides SNI for Cloudflare traffic | Certain | Medium | Fall back to IP-ASN classification for ECH; track ECH% metric |
| CRYPTO frame fragmentation across multiple UDP datagrams | Low | Medium | nDPI handles reassembly; ensure `ndpi_max_packets` is high enough (≥16) |
| YouTube changes SNI pattern | Low | Low | Mapping table is UI-configurable; operators can update without code changes |
| gQUIC SNI unavailable | Certain | Low | gQUIC uses proprietary QUIC-Crypto; classify by IP/ASN instead |

---

## 10. Open Questions

1. **libgcrypt system vs bundled**: Should libgcrypt be a system dependency (simpler) or bundled in `third_party/`? System dependency is preferred for security patching.

2. **nDPI max_packets tuning**: The current default is 16 packets before `ndpi_detection_giveup`. QUIC Initial packets typically arrive in packets 1–3. Is 16 sufficient? Should we increase to 24 for cases where the CRYPTO frame is fragmented?

3. **gQUIC IP classification**: For gQUIC flows where SNI is unavailable, should we implement BGP/ASN lookup to classify by destination AS (e.g., AS15169 = Google → "Google QUIC")? This requires a GeoIP/ASN database (MaxMind GeoLite2 is already referenced in `.env`).

4. **HTTP/3 stream-level parsing**: After application identification, should we attempt to parse HTTP/3 (QPACK-compressed headers) from 0-RTT or 1-RTT packets? This is only possible with `SSLKEYLOGFILE` key export from the endpoint — out of scope for passive monitoring but worth noting for future active probe integration.

5. **QUIC connection migration tracking**: QUIC allows connections to migrate between IP addresses using Connection IDs. The current flow tracker keys by 5-tuple (IP+port). Should QUIC flows be tracked by DCID instead, enabling accurate byte accounting across IP migrations? This would require a separate QUIC connection ID tracking table.

---

## 11. Appendix: QUIC Packet Capture for Testing

### Capture YouTube QUIC traffic

```bash
# Capture QUIC while playing YouTube
sudo tcpdump -i wlp1s0 -w /tmp/youtube_quic.pcap \
  'udp port 443 and (src net 216.58.0.0/16 or dst net 216.58.0.0/16 or
   src net 142.250.0.0/15 or dst net 142.250.0.0/15)'

# Play YouTube in browser for 30 seconds, then stop capture

# Analyze with ndpiReader (must have libgcrypt support):
./third_party/ndpi-install/bin/ndpiReader -i /tmp/youtube_quic.pcap -v 3 2>&1 \
  | grep -E "QUIC|server_name|SNI|ALPN|youtube|googlevideo" | head -50
```

### Verify Initial packet decryption in Python (validation tool)

```python
#!/usr/bin/env python3
# Validate QUIC Initial packet decryption matches what FlowMon should see
# Requires: pip install scapy cryptography

from scapy.all import rdpcap, UDP, Raw
from cryptography.hazmat.primitives.kdf.hkdf import HKDF, HKDFExpand
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
import struct

QUIC_V1_SALT = bytes.fromhex("38762cf7f55934b34d179ae6a4c80cadccbb7f0a")

def hkdf_extract(salt, ikm):
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hmac
    h = hmac.HMAC(salt, hashes.SHA256(), backend=default_backend())
    h.update(ikm)
    return h.finalize()

def hkdf_expand_label(secret, label, context, length):
    full_label = b"tls13 " + label.encode()
    info = struct.pack(">H", length) + bytes([len(full_label)]) + full_label
    info += bytes([len(context)]) + context
    return HKDFExpand(hashes.SHA256(), length, info).derive(secret)

def derive_quic_v1_keys(dcid: bytes):
    initial_secret = hkdf_extract(QUIC_V1_SALT, dcid)
    client_initial = hkdf_expand_label(initial_secret, "client in", b"", 32)
    key = hkdf_expand_label(client_initial, "quic key", b"", 16)
    iv  = hkdf_expand_label(client_initial, "quic iv",  b"", 12)
    hp  = hkdf_expand_label(client_initial, "quic hp",  b"", 16)
    return key, iv, hp

# Parse first QUIC Initial packet from pcap and extract SNI
packets = rdpcap("/tmp/youtube_quic.pcap")
for pkt in packets:
    if UDP in pkt and pkt[UDP].dport == 443:
        raw = bytes(pkt[UDP].payload)
        if len(raw) > 5 and (raw[0] & 0xc0) == 0xc0:  # long header, fixed bit
            version = struct.unpack(">I", raw[1:5])[0]
            if version == 0x00000001:  # QUIC v1
                dcid_len = raw[5]
                dcid = raw[6:6+dcid_len]
                key, iv, hp = derive_quic_v1_keys(dcid)
                print(f"DCID: {dcid.hex()}")
                print(f"Key:  {key.hex()}")
                print(f"IV:   {iv.hex()}")
                print(f"HP:   {hp.hex()}")
                # ... header protection removal + AES-GCM decryption + ClientHello parse ...
                break
```

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| QUIC | UDP-based transport protocol (RFC 9000); replaces TCP+TLS for HTTP/3 |
| Initial packet | QUIC long-header packet type carrying TLS ClientHello; passively decryptable |
| DCID | Destination Connection ID — cleartext identifier used as HKDF input for Initial key derivation |
| SCID | Source Connection ID — cleartext, chosen by sender |
| HKDF | HMAC-based Key Derivation Function (RFC 5869); used for TLS 1.3 and QUIC key schedules |
| SNI | Server Name Indication — TLS extension carrying the target hostname |
| ALPN | Application Layer Protocol Negotiation — TLS extension listing supported app protocols |
| gQUIC | Google QUIC — pre-IETF, proprietary protocol; uses QUIC-Crypto not TLS |
| ECH | Encrypted Client Hello — hides real SNI inside encrypted outer ClientHello |
| CRYPTO frame | QUIC frame type 0x06 carrying TLS handshake messages |
| JA3 | TLS client fingerprint: MD5 of cipher suites + extensions + elliptic curves |
| JA4 | Next-generation TLS fingerprint; more stable across version changes |
| AES-NI | x86 hardware acceleration for AES operations |
| h3 | ALPN value for HTTP/3 over IETF QUIC |
| H3-29 | ALPN for HTTP/3 over QUIC draft-29 (widely deployed legacy) |

---

*This PRD was researched against RFC 9000, RFC 9001, RFC 9369, nDPI 5.x source code, and live YouTube QUIC traffic analysis.*
*Next steps: Schedule Phase 0 diagnosis (1 engineer, 1 day) to confirm root cause before committing to implementation timeline.*

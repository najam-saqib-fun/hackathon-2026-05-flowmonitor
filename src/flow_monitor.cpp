// flow_monitor.cpp
//
// Background service that listens on a Unix socket, ingests packet messages
// from pcap_processor, aggregates them into bidirectional flows, runs nDPI
// for application/category detection, and persists completed flows into a
// MySQL/MariaDB database. Flows that go silent for `flow_timeout` seconds
// are flushed automatically; on SIGINT/SIGTERM all in-memory flows are
// flushed and the process exits cleanly.

#include "common.h"
#include "md5.h"

#include <ndpi/ndpi_api.h>
#include <ndpi/ndpi_main.h>
#include <ndpi/ndpi_typedefs.h>
#include <mysql/mysql.h>
#include <pcap/pcap.h>

#include <arpa/inet.h>
#include <fcntl.h>
#include <getopt.h>
#include <netinet/if_ether.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/ip6.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>

#ifndef ETHERTYPE_IPV6
#define ETHERTYPE_IPV6 0x86DD
#endif
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace flowmon;

// ============================================================================
// Configuration
// ============================================================================
struct Config {
    std::string socket_path = DEFAULT_SOCKET_PATH;

    // Live capture: when `interface` is set we skip the unix socket and tap
    // the NIC directly via libpcap. `bpf_filter` is optional.
    std::string interface;
    std::string bpf_filter;

    // MySQL/MariaDB connection. An empty mysql_socket means use TCP to
    // (mysql_host, mysql_port). The database is auto-created if missing.
    std::string mysql_host   = "127.0.0.1";
    int         mysql_port   = 3306;
    std::string mysql_user   = "root";
    std::string mysql_pass   = "Najam123!";
    std::string mysql_db     = "flowmon";
    std::string mysql_socket;  // optional unix-socket path

    int flow_timeout_seconds = 60;
    int sync_interval_seconds = 5;   // real-time sync every 5s; 0 disables
    int ndpi_max_packets = 64;
    int sweep_every_packets = 1000;
    size_t max_active_flows = 100000;
    bool verbose = false;
    // Enable 802.11 monitor mode (rfmon). Requires a WiFi adapter that supports
    // it and root. In monitor mode the adapter captures all frames on the
    // channel (including other clients') instead of only your own traffic.
    // Frames are delivered with a Radiotap header (DLT_IEEE802_11_RADIO).
    // NOTE: WPA2/WPA3-encrypted unicast frames still cannot be decrypted;
    // use on open networks or deploy on the gateway for full visibility.
    bool rfmon = false;
};

// Crude flat-JSON loader: tolerates "key": value entries (string/number/bool)
// at the top level. Comments and nested objects are ignored. Good enough for
// shipping a sample config.json without pulling in a JSON dependency.
static bool load_config(const std::string& path, Config& cfg) {
    std::ifstream f(path);
    if (!f) return false;
    std::string text((std::istreambuf_iterator<char>(f)),
                     std::istreambuf_iterator<char>());

    auto find_string = [&](const char* key, std::string& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = text.find(needle);
        if (p == std::string::npos) return;
        p = text.find(':', p);
        if (p == std::string::npos) return;
        size_t q = text.find('"', p);
        if (q == std::string::npos) return;
        size_t r = text.find('"', q + 1);
        if (r == std::string::npos) return;
        out = text.substr(q + 1, r - q - 1);
    };
    auto find_int = [&](const char* key, int& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = text.find(needle);
        if (p == std::string::npos) return;
        p = text.find(':', p);
        if (p == std::string::npos) return;
        ++p;
        while (p < text.size() && (text[p] == ' ' || text[p] == '\t')) ++p;
        out = std::atoi(text.c_str() + p);
    };
    auto find_bool = [&](const char* key, bool& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = text.find(needle);
        if (p == std::string::npos) return;
        p = text.find(':', p);
        if (p == std::string::npos) return;
        ++p;
        while (p < text.size() && (text[p] == ' ' || text[p] == '\t')) ++p;
        if (text.compare(p, 4, "true") == 0)  out = true;
        if (text.compare(p, 5, "false") == 0) out = false;
    };

    find_string("socket_path", cfg.socket_path);
    find_string("interface",   cfg.interface);
    find_string("bpf_filter",  cfg.bpf_filter);
    find_string("mysql_host", cfg.mysql_host);
    find_int   ("mysql_port", cfg.mysql_port);
    find_string("mysql_user", cfg.mysql_user);
    find_string("mysql_pass", cfg.mysql_pass);
    find_string("mysql_db",   cfg.mysql_db);
    find_string("mysql_socket", cfg.mysql_socket);
    find_int("flow_timeout_seconds", cfg.flow_timeout_seconds);
    find_int("sync_interval_seconds", cfg.sync_interval_seconds);
    find_int("ndpi_max_packets", cfg.ndpi_max_packets);
    find_int("sweep_every_packets", cfg.sweep_every_packets);
    int max_flows = static_cast<int>(cfg.max_active_flows);
    find_int("max_active_flows", max_flows);
    if (max_flows > 0) cfg.max_active_flows = static_cast<size_t>(max_flows);
    find_bool("rfmon", cfg.rfmon);
    return true;
}

// ============================================================================
// Flow record
// ============================================================================
struct Flow {
    std::string flow_hash;
    std::string src_ip;
    std::string dst_ip;
    uint16_t src_port = 0;
    uint16_t dst_port = 0;
    uint8_t  protocol = 0;
    uint8_t  ip_version = 4;
    uint8_t  src_ip_bytes[16] = {};  // raw address bytes for direction detection
    uint8_t  dst_ip_bytes[16] = {};

    uint64_t packets_sent = 0;
    uint64_t packets_recv = 0;
    uint64_t bytes_sent = 0;
    uint64_t bytes_recv = 0;

    uint64_t start_time_us = 0;
    uint64_t last_packet_time_us = 0;

    std::string application;
    std::string app_category;
    std::string master_protocol;
    int  ndpi_proto_id = 0;
    bool ndpi_finalized = false;
    int  packets_seen_for_ndpi = 0;

    std::unordered_set<std::string> hostnames_set;
    std::unordered_set<std::string> urls_set;
    std::vector<std::string> hostnames;
    std::vector<std::string> urls;
    std::string ja3_client;
    std::string ja3_server;
    std::string user_agent;
    std::string http_method;
    std::string tls_version;
    std::string tls_alpn;
    std::string tls_issuer_dn;
    std::string tls_subject_dn;
    uint32_t    tls_cert_not_after = 0;
    uint32_t    quic_version = 0;

    uint64_t ipdr_key_id = 0;

    struct ndpi_flow_struct* ndpi_flow = nullptr;
};

// ============================================================================
// Helpers
// ============================================================================
static std::string ip_bytes_to_str(const uint8_t* bytes, uint8_t version) {
    if (version == 6) {
        char buf[INET6_ADDRSTRLEN];
        if (inet_ntop(AF_INET6, bytes, buf, sizeof(buf))) return std::string(buf);
        return "::";
    }
    char buf[INET_ADDRSTRLEN];
    if (inet_ntop(AF_INET, bytes, buf, sizeof(buf))) return std::string(buf);
    return "0.0.0.0";
}

static std::string canonical_flow_hash(const std::string& ip1, const std::string& ip2,
                                       uint16_t p1, uint16_t p2, uint8_t proto) {
    std::string a = ip1, b = ip2;
    uint16_t pa = p1, pb = p2;
    if (a > b) {
        std::swap(a, b);
        std::swap(pa, pb);
    } else if (a == b && pa > pb) {
        std::swap(pa, pb);
    }
    std::ostringstream key;
    key << a << '|' << b << '|' << pa << '|' << pb << '|' << static_cast<int>(proto);
    return md5_impl::md5_hex(key.str());
}

static std::string format_timestamp(uint64_t us) {
    time_t secs = static_cast<time_t>(us / 1000000ULL);
    struct tm tm_buf;
    // Local time so the DATETIME(6) value matches the wall clock at capture
    // time (tcpdump prints local time too). The column itself is timezone-
    // naive — switching to UTC would just be a static shift.
    localtime_r(&secs, &tm_buf);
    char out[40];
    int n = std::snprintf(out, sizeof(out),
                          "%04d-%02d-%02d %02d:%02d:%02d.%06u",
                          tm_buf.tm_year + 1900, tm_buf.tm_mon + 1, tm_buf.tm_mday,
                          tm_buf.tm_hour, tm_buf.tm_min, tm_buf.tm_sec,
                          static_cast<unsigned>(us % 1000000ULL));
    return std::string(out, n);
}

static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

static std::string vec_to_json_array(const std::vector<std::string>& v) {
    std::string out = "[";
    for (size_t i = 0; i < v.size(); ++i) {
        if (i) out += ',';
        out += '"';
        out += json_escape(v[i]);
        out += '"';
    }
    out += ']';
    return out;
}

// Pull a NUL-terminated string from a raw nDPI char buffer of known size.
static std::string copy_cstr(const char* p, size_t maxlen) {
    if (!p) return {};
    size_t n = strnlen(p, maxlen);
    if (n == 0) return {};
    return std::string(p, n);
}

// ============================================================================
// Application mapping (hostname / IP -> friendly app name)
// ============================================================================

static bool parse_cidr_static(const std::string& cidr, uint32_t& net_out, uint32_t& mask_out) {
    size_t slash = cidr.find('/');
    std::string ip_part = (slash != std::string::npos) ? cidr.substr(0, slash) : cidr;
    int prefix = (slash != std::string::npos) ? std::atoi(cidr.c_str() + slash + 1) : 32;
    if (prefix < 0 || prefix > 32) return false;
    struct in_addr a;
    if (inet_pton(AF_INET, ip_part.c_str(), &a) != 1) return false;
    mask_out = (prefix == 0) ? 0u : (0xFFFFFFFFu << (32 - prefix));
    net_out  = ntohl(a.s_addr) & mask_out;
    return true;
}
//
// The DB table `application_mappings` is the source of truth. We seed it on
// startup with the rows below (INSERT IGNORE — safe to re-run, and any
// operator-added rows are preserved across upgrades). At startup we copy the
// table into memory so the per-flow lookup is O(1) for exact matches and a
// short linear scan for hostname suffixes.
//
// Pattern types:
//   hostname_exact   — match the SNI / DNS name verbatim (case-insensitive)
//   hostname_suffix  — match if the SNI ends with ".pattern" or equals it
//                      (so "cursor.sh" matches api2.cursor.sh but not
//                      evilcursor.sh)
//   ip_exact         — match a literal IPv4 dotted-quad
//
// To add a new app, just INSERT INTO application_mappings (...) VALUES (...);
// — the new entry is picked up the next time flow_monitor restarts.
struct SeedRow {
    const char* type;
    const char* pattern;
    const char* app;
    const char* category;
};

static const SeedRow kSeedMappings[] = {
    // Microsoft
    {"hostname_suffix", "teams.live.com",       "Microsoft Teams", "Collaborative"},
    {"hostname_suffix", "teams.microsoft.com",  "Microsoft Teams", "Collaborative"},
    {"hostname_suffix", "skype.com",            "Skype",           "Collaborative"},
    {"hostname_suffix", "office.com",           "Microsoft 365",   "Productivity"},
    {"hostname_suffix", "office365.com",        "Microsoft 365",   "Productivity"},
    {"hostname_suffix", "outlook.com",          "Outlook",         "Email"},
    {"hostname_suffix", "live.com",             "Microsoft Live",  "Productivity"},
    {"hostname_suffix", "microsoft.com",        "Microsoft",       "Productivity"},
    {"hostname_suffix", "msn.com",              "Microsoft",       "Web"},
    {"hostname_suffix", "windowsupdate.com",    "Windows Update",  "System"},
    {"hostname_suffix", "onedrive.com",         "OneDrive",        "Cloud"},

    // Cursor (the editor)
    {"hostname_suffix", "cursor.sh",   "Cursor", "Productivity"},
    {"hostname_suffix", "cursor.com",  "Cursor", "Productivity"},

    // Google services (Search/Workspace/etc.)
    {"hostname_exact",  "clients4.google.com",                    "Google Chrome",   "Web"},
    {"hostname_exact",  "clients2.google.com",                    "Google Chrome",   "Web"},
    {"hostname_suffix", "optimizationguide-pa.googleapis.com",    "Google Chrome",   "Web"},
    {"hostname_suffix", "google.com",            "Google",        "Search"},
    {"hostname_suffix", "googleapis.com",        "Google APIs",   "Cloud"},
    {"hostname_suffix", "gstatic.com",           "Google",        "Web"},
    {"hostname_suffix", "ggpht.com",             "Google",        "Web"},
    {"hostname_suffix", "googleusercontent.com", "Google",        "Web"},
    {"hostname_suffix", "doubleclick.net",       "Google Ads",    "Advertising"},
    {"hostname_suffix", "googletagmanager.com",  "Google Ads",    "Advertising"},
    {"hostname_suffix", "googlesyndication.com", "Google Ads",    "Advertising"},
    {"hostname_suffix", "mail.google.com",       "Gmail",         "Email"},
    {"hostname_suffix", "meet.google.com",       "Google Meet",   "Conferencing"},
    {"hostname_suffix", "drive.google.com",      "Google Drive",  "Cloud"},

    // YouTube
    {"hostname_suffix", "youtube.com",     "YouTube", "Video"},
    {"hostname_suffix", "googlevideo.com", "YouTube", "Video"},
    {"hostname_suffix", "ytimg.com",       "YouTube", "Video"},
    {"hostname_suffix", "youtu.be",        "YouTube", "Video"},

    // Telegram
    {"hostname_suffix", "telegram.org", "Telegram", "Chat"},
    {"hostname_suffix", "telegram.me",  "Telegram", "Chat"},
    {"hostname_suffix", "t.me",         "Telegram", "Chat"},
    {"ip_exact",        "149.154.167.99","Telegram","Chat"},
    {"ip_exact",        "149.154.167.91","Telegram","Chat"},

    // WhatsApp / Signal
    {"hostname_suffix", "whatsapp.net", "WhatsApp", "Chat"},
    {"hostname_suffix", "whatsapp.com", "WhatsApp", "Chat"},
    {"hostname_suffix", "signal.org",   "Signal",   "Chat"},

    // Conferencing
    {"hostname_suffix", "zoom.us",     "Zoom",  "Conferencing"},
    {"hostname_suffix", "zoom.com",    "Zoom",  "Conferencing"},
    {"hostname_suffix", "zoomgov.com", "Zoom",  "Conferencing"},
    {"hostname_suffix", "webex.com",   "Webex", "Conferencing"},

    // Web3 / crypto
    {"hostname_suffix", "metamask.io",  "MetaMask", "Web3"},
    {"hostname_suffix", "chaingpt.tech","ChainGPT", "Web3"},
    {"hostname_suffix", "infura.io",    "Infura",   "Web3"},
    {"hostname_suffix", "alchemy.com",  "Alchemy",  "Web3"},
    {"hostname_suffix", "coinbase.com", "Coinbase", "Web3"},
    {"hostname_suffix", "binance.com",  "Binance",  "Web3"},

    // ByteDance / Volcengine
    {"hostname_suffix", "volces.com",    "Volcengine", "Cloud"},
    {"hostname_suffix", "bytedance.com", "ByteDance",  "Cloud"},

    // Streaming
    {"hostname_suffix", "netflix.com",   "Netflix", "Video"},
    {"hostname_suffix", "nflxvideo.net", "Netflix", "Video"},
    {"hostname_suffix", "twitch.tv",     "Twitch",  "Video"},
    {"hostname_suffix", "ttvnw.net",     "Twitch",  "Video"},
    {"hostname_suffix", "spotify.com",   "Spotify", "Music"},
    {"hostname_suffix", "scdn.co",       "Spotify", "Music"},

    // Social
    {"hostname_suffix", "facebook.com",   "Facebook",  "SocialNetwork"},
    {"hostname_suffix", "fbcdn.net",      "Facebook",  "SocialNetwork"},
    {"hostname_suffix", "instagram.com",  "Instagram", "SocialNetwork"},
    {"hostname_suffix", "twitter.com",    "Twitter",   "SocialNetwork"},
    {"hostname_suffix", "x.com",          "Twitter",   "SocialNetwork"},
    {"hostname_suffix", "twimg.com",      "Twitter",   "SocialNetwork"},
    {"hostname_suffix", "linkedin.com",   "LinkedIn",  "SocialNetwork"},
    {"hostname_suffix", "licdn.com",      "LinkedIn",  "SocialNetwork"},
    {"hostname_suffix", "reddit.com",     "Reddit",    "SocialNetwork"},
    {"hostname_suffix", "redditmedia.com","Reddit",    "SocialNetwork"},
    {"hostname_suffix", "tiktok.com",     "TikTok",    "SocialNetwork"},
    {"hostname_suffix", "tiktokcdn.com",  "TikTok",    "SocialNetwork"},

    // Gaming
    {"hostname_suffix", "steampowered.com",   "Steam",        "Gaming"},
    {"hostname_suffix", "steamcommunity.com", "Steam",        "Gaming"},
    {"hostname_suffix", "epicgames.com",      "Epic Games",   "Gaming"},
    {"hostname_suffix", "xboxlive.com",       "Xbox Live",    "Gaming"},
    {"hostname_suffix", "playstation.net",    "PlayStation",  "Gaming"},

    // Cloud / CDN
    {"hostname_suffix", "amazonaws.com",  "AWS",        "Cloud"},
    {"hostname_suffix", "cloudfront.net", "AWS",        "Cloud"},
    {"hostname_suffix", "azure.com",      "Azure",      "Cloud"},
    {"hostname_suffix", "azureedge.net",  "Azure",      "Cloud"},
    {"hostname_suffix", "windows.net",    "Azure",      "Cloud"},
    {"hostname_suffix", "cloudflare.com", "Cloudflare", "Cloud"},
    {"hostname_suffix", "cloudflare.net", "Cloudflare", "Cloud"},

    // Apple
    {"hostname_suffix", "apple.com",    "Apple", "Cloud"},
    {"hostname_suffix", "icloud.com",   "Apple", "Cloud"},
    {"hostname_suffix", "mzstatic.com", "Apple", "Cloud"},

    // Developer tooling
    {"hostname_suffix", "github.com",            "GitHub",        "Productivity"},
    {"hostname_suffix", "githubusercontent.com", "GitHub",        "Productivity"},
    {"hostname_suffix", "gitlab.com",            "GitLab",        "Productivity"},
    {"hostname_suffix", "stackoverflow.com",     "StackOverflow", "Productivity"},
    {"hostname_suffix", "stackexchange.com",     "StackExchange", "Productivity"},
    {"hostname_suffix", "npmjs.org",             "npm",           "Productivity"},
    {"hostname_suffix", "npmjs.com",             "npm",           "Productivity"},
    {"hostname_suffix", "docker.com",            "Docker",        "Productivity"},
    {"hostname_suffix", "docker.io",             "Docker",        "Productivity"},

    // AI assistants
    {"hostname_suffix", "anthropic.com", "Anthropic", "AI"},
    {"hostname_suffix", "claude.ai",     "Claude",    "AI"},
    {"hostname_suffix", "openai.com",    "OpenAI",    "AI"},
    {"hostname_suffix", "chatgpt.com",   "ChatGPT",   "AI"},

    // Misc OS / system
    {"hostname_suffix", "ubuntu.com",  "Ubuntu",   "System"},
    {"hostname_suffix", "canonical.com","Ubuntu",  "System"},
    {"hostname_suffix", "debian.org",  "Debian",   "System"},
    {"hostname_suffix", "fedoraproject.org","Fedora","System"},
    {"hostname_suffix", "centos.org",  "CentOS",   "System"},
    {"hostname_suffix", "redhat.com",  "RedHat",   "System"},
    {"hostname_suffix", "archlinux.org","Arch Linux","System"},

    // Email providers
    {"hostname_suffix", "yahoo.com",       "Yahoo Mail",  "Email"},
    {"hostname_suffix", "yahoomail.com",   "Yahoo Mail",  "Email"},
    {"hostname_suffix", "protonmail.com",  "ProtonMail",  "Email"},
    {"hostname_suffix", "proton.me",       "ProtonMail",  "Email"},
    {"hostname_suffix", "tutanota.com",    "Tutanota",    "Email"},
    {"hostname_suffix", "zoho.com",        "Zoho",        "Email"},
    {"hostname_suffix", "icloud.com",      "iCloud Mail", "Email"},
    {"hostname_suffix", "hotmail.com",     "Outlook",     "Email"},
    {"hostname_suffix", "gmx.com",         "GMX",         "Email"},

    // Video streaming / OTT
    {"hostname_suffix", "disneyplus.com",  "Disney+",      "Video"},
    {"hostname_suffix", "hulu.com",        "Hulu",         "Video"},
    {"hostname_suffix", "max.com",         "HBO Max",      "Video"},
    {"hostname_suffix", "hbomax.com",      "HBO Max",      "Video"},
    {"hostname_suffix", "primevideo.com",  "Prime Video",  "Video"},
    {"hostname_suffix", "amazon.com",      "Amazon",       "Shopping"},
    {"hostname_suffix", "amazonvideo.com", "Prime Video",  "Video"},
    {"hostname_suffix", "peacocktv.com",   "Peacock",      "Video"},
    {"hostname_suffix", "paramountplus.com","Paramount+",  "Video"},
    {"hostname_suffix", "crunchyroll.com", "Crunchyroll",  "Video"},
    {"hostname_suffix", "dailymotion.com", "Dailymotion",  "Video"},
    {"hostname_suffix", "vimeo.com",       "Vimeo",        "Video"},

    // Music
    {"hostname_suffix", "soundcloud.com",  "SoundCloud",  "Music"},
    {"hostname_suffix", "tidal.com",       "Tidal",       "Music"},
    {"hostname_suffix", "deezer.com",      "Deezer",      "Music"},
    {"hostname_suffix", "pandora.com",     "Pandora",     "Music"},
    {"hostname_suffix", "apple.com",       "Apple",       "Cloud"},
    {"hostname_suffix", "applemusic.com",  "Apple Music", "Music"},

    // Social / messaging extended
    {"hostname_suffix", "snapchat.com",    "Snapchat",    "SocialNetwork"},
    {"hostname_suffix", "sc-cdn.net",      "Snapchat",    "SocialNetwork"},
    {"hostname_suffix", "discord.com",     "Discord",     "Chat"},
    {"hostname_suffix", "discord.gg",      "Discord",     "Chat"},
    {"hostname_suffix", "discordapp.com",  "Discord",     "Chat"},
    {"hostname_suffix", "slack.com",       "Slack",       "Collaborative"},
    {"hostname_suffix", "slack-edge.com",  "Slack",       "Collaborative"},
    {"hostname_suffix", "pinterest.com",   "Pinterest",   "SocialNetwork"},
    {"hostname_suffix", "tumblr.com",      "Tumblr",      "SocialNetwork"},
    {"hostname_suffix", "quora.com",       "Quora",       "SocialNetwork"},
    {"hostname_suffix", "medium.com",      "Medium",      "Web"},
    {"hostname_suffix", "viber.com",       "Viber",       "Chat"},
    {"hostname_suffix", "line.me",         "LINE",        "Chat"},
    {"hostname_suffix", "wechat.com",      "WeChat",      "Chat"},
    {"hostname_suffix", "qq.com",          "QQ",          "Chat"},

    // Gaming extended
    {"hostname_suffix", "riotgames.com",   "Riot Games",   "Gaming"},
    {"hostname_suffix", "leagueoflegends.com","League of Legends","Gaming"},
    {"hostname_suffix", "ea.com",          "EA Games",     "Gaming"},
    {"hostname_suffix", "origin.com",      "EA Origin",    "Gaming"},
    {"hostname_suffix", "blizzard.com",    "Blizzard",     "Gaming"},
    {"hostname_suffix", "battle.net",      "Battle.net",   "Gaming"},
    {"hostname_suffix", "nintendo.com",    "Nintendo",     "Gaming"},
    {"hostname_suffix", "roblox.com",      "Roblox",       "Gaming"},
    {"hostname_suffix", "minecraft.net",   "Minecraft",    "Gaming"},
    {"hostname_suffix", "mojang.com",      "Minecraft",    "Gaming"},
    {"hostname_suffix", "valvesoftware.com","Valve",       "Gaming"},
    {"hostname_suffix", "gog.com",         "GOG",          "Gaming"},
    {"hostname_suffix", "ubi.com",         "Ubisoft",      "Gaming"},
    {"hostname_suffix", "ubisoft.com",     "Ubisoft",      "Gaming"},

    // CDN / infrastructure
    {"hostname_suffix", "fastly.com",      "Fastly",      "Cloud"},
    {"hostname_suffix", "fastly.net",      "Fastly",      "Cloud"},
    {"hostname_suffix", "akamai.com",      "Akamai",      "Cloud"},
    {"hostname_suffix", "akamaiedge.net",  "Akamai",      "Cloud"},
    {"hostname_suffix", "edgecastcdn.net", "Verizon Edge","Cloud"},
    {"hostname_suffix", "stackpathcdn.com","StackPath",   "Cloud"},
    {"hostname_suffix", "digitalocean.com","DigitalOcean","Cloud"},
    {"hostname_suffix", "linode.com",      "Linode",      "Cloud"},
    {"hostname_suffix", "vultr.com",       "Vultr",       "Cloud"},
    {"hostname_suffix", "heroku.com",      "Heroku",      "Cloud"},
    {"hostname_suffix", "netlify.com",     "Netlify",     "Cloud"},
    {"hostname_suffix", "vercel.com",      "Vercel",      "Cloud"},
    {"hostname_suffix", "render.com",      "Render",      "Cloud"},
    {"hostname_suffix", "oracle.com",      "Oracle Cloud","Cloud"},

    // Finance / banking
    {"hostname_suffix", "paypal.com",      "PayPal",      "Finance"},
    {"hostname_suffix", "paypalobjects.com","PayPal",     "Finance"},
    {"hostname_suffix", "stripe.com",      "Stripe",      "Finance"},
    {"hostname_suffix", "wise.com",        "Wise",        "Finance"},
    {"hostname_suffix", "revolut.com",     "Revolut",     "Finance"},
    {"hostname_suffix", "venmo.com",       "Venmo",       "Finance"},
    {"hostname_suffix", "cashapp.com",     "Cash App",    "Finance"},
    {"hostname_suffix", "kraken.com",      "Kraken",      "Web3"},
    {"hostname_suffix", "okx.com",         "OKX",         "Web3"},
    {"hostname_suffix", "bybit.com",       "Bybit",       "Web3"},

    // Developer / productivity
    {"hostname_suffix", "bitbucket.org",   "Bitbucket",    "Productivity"},
    {"hostname_suffix", "atlassian.com",   "Atlassian",    "Productivity"},
    {"hostname_suffix", "jira.com",        "Jira",         "Productivity"},
    {"hostname_suffix", "confluence.com",  "Confluence",   "Productivity"},
    {"hostname_suffix", "trello.com",      "Trello",       "Productivity"},
    {"hostname_suffix", "notion.com",      "Notion",       "Productivity"},
    {"hostname_suffix", "airtable.com",    "Airtable",     "Productivity"},
    {"hostname_suffix", "figma.com",       "Figma",        "Productivity"},
    {"hostname_suffix", "canva.com",       "Canva",        "Productivity"},
    {"hostname_suffix", "dropbox.com",     "Dropbox",      "Cloud"},
    {"hostname_suffix", "box.com",         "Box",          "Cloud"},

    // AI / ML
    {"hostname_suffix", "huggingface.co",  "HuggingFace", "AI"},
    {"hostname_suffix", "replicate.com",   "Replicate",   "AI"},
    {"hostname_suffix", "cohere.com",      "Cohere",      "AI"},
    {"hostname_suffix", "perplexity.ai",   "Perplexity",  "AI"},
    {"hostname_suffix", "mistral.ai",      "Mistral",     "AI"},

    // Security / VPN
    {"hostname_suffix", "nordvpn.com",     "NordVPN",     "Security"},
    {"hostname_suffix", "expressvpn.com",  "ExpressVPN",  "Security"},
    {"hostname_suffix", "mullvad.net",     "Mullvad",     "Security"},
    {"hostname_suffix", "torproject.org",  "Tor",         "Security"},
    {"hostname_suffix", "crowdstrike.com", "CrowdStrike", "Security"},
    {"hostname_suffix", "1password.com",   "1Password",   "Security"},

    // Public DNS resolvers
    {"ip_exact", "8.8.8.8",       "Google DNS",    "Infrastructure"},
    {"ip_exact", "8.8.4.4",       "Google DNS",    "Infrastructure"},
    {"ip_exact", "1.1.1.1",       "Cloudflare DNS","Infrastructure"},
    {"ip_exact", "1.0.0.1",       "Cloudflare DNS","Infrastructure"},
    {"ip_exact", "9.9.9.9",       "Quad9 DNS",     "Infrastructure"},
    {"ip_exact", "149.112.112.112","Quad9 DNS",    "Infrastructure"},
    {"ip_exact", "208.67.222.222","OpenDNS",       "Infrastructure"},
    {"ip_exact", "208.67.220.220","OpenDNS",       "Infrastructure"},

    // Telegram additional IPs (DC1-DC5)
    {"ip_exact", "149.154.175.50","Telegram",      "Chat"},
    {"ip_exact", "149.154.167.51","Telegram",      "Chat"},
    {"ip_exact", "149.154.175.100","Telegram",     "Chat"},
    {"ip_exact", "91.108.4.0",    "Telegram",      "Chat"},
    {"ip_exact", "91.108.56.0",   "Telegram",      "Chat"},

    // Facebook / Meta IP ranges
    {"ip_cidr", "157.240.0.0/16",     "Facebook",   "Social"},
    {"ip_cidr", "157.240.202.0/24",   "Facebook",   "Social"},
    {"ip_cidr", "185.60.219.0/24",    "Meta",       "Social"},
    {"ip_cidr", "31.13.24.0/21",      "Facebook",   "Social"},
    {"ip_cidr", "31.13.64.0/18",      "Facebook",   "Social"},
    {"ip_cidr", "57.144.0.0/16",      "Facebook",   "Social"},  // fbcdn.net video CDN
    {"ip_cidr", "66.220.144.0/20",    "Facebook",   "Social"},
    {"ip_cidr", "69.63.176.0/20",     "Facebook",   "Social"},
    {"ip_cidr", "69.171.224.0/19",    "Facebook",   "Social"},

    // Google IP ranges — video CDN (googlevideo.com) classified as YouTube
    {"ip_cidr", "142.250.0.0/15",     "YouTube",    "Video"},   // Google video CDN
    {"ip_cidr", "142.251.152.0/24",   "YouTube",    "Video"},
    {"ip_cidr", "74.125.0.0/16",      "YouTube",    "Video"},   // googlevideo.com primary
    {"ip_cidr", "64.233.0.0/16",      "Google Meet","Video"},   // wm-in-f*.1e100.net
    {"ip_cidr", "172.217.0.0/16",     "Google",     "Search"},
    {"ip_cidr", "173.194.0.0/16",     "Google",     "Search"},
    {"ip_cidr", "216.58.192.0/19",    "Google",     "Search"},
    {"ip_cidr", "216.239.32.0/19",    "Google",     "Search"},
    {"ip_cidr", "209.85.128.0/17",    "Google",     "Search"},
    {"ip_cidr", "108.177.8.0/21",     "Google",     "Search"},
    {"ip_cidr", "66.249.64.0/19",     "Google Bot", "Search"},

    // Cloudflare CDN
    {"ip_cidr", "104.16.0.0/13",      "Cloudflare", "CDN"},
    {"ip_cidr", "104.24.0.0/14",      "Cloudflare", "CDN"},
    {"ip_cidr", "172.64.0.0/13",      "Cloudflare", "CDN"},
    {"ip_cidr", "162.158.0.0/15",     "Cloudflare", "CDN"},
    {"ip_cidr", "198.41.128.0/17",    "Cloudflare", "CDN"},
    {"ip_cidr", "190.93.240.0/20",    "Cloudflare", "CDN"},
    {"ip_cidr", "188.114.96.0/20",    "Cloudflare", "CDN"},
    {"ip_cidr", "173.245.48.0/20",    "Cloudflare", "CDN"},
    {"ip_cidr", "103.21.244.0/22",    "Cloudflare", "CDN"},
    {"ip_cidr", "103.22.200.0/22",    "Cloudflare", "CDN"},
    {"ip_cidr", "103.31.4.0/22",      "Cloudflare", "CDN"},
    {"ip_cidr", "141.101.64.0/18",    "Cloudflare", "CDN"},
    {"ip_cidr", "108.162.192.0/18",   "Cloudflare", "CDN"},
    {"ip_cidr", "197.234.240.0/22",   "Cloudflare", "CDN"},
    {"ip_cidr", "131.0.72.0/22",      "Cloudflare", "CDN"},

    // Akamai CDN
    {"ip_cidr", "2.16.0.0/13",        "Akamai",     "CDN"},  // 2.16-23 (2.20.x observed)
    {"ip_cidr", "23.32.0.0/11",       "Akamai",     "CDN"},
    {"ip_cidr", "23.64.0.0/14",       "Akamai",     "CDN"},
    {"ip_cidr", "96.16.0.0/15",       "Akamai",     "CDN"},
    {"ip_cidr", "184.24.0.0/13",      "Akamai",     "CDN"},

    // Amazon AWS CloudFront
    {"ip_cidr", "52.84.0.0/15",       "Amazon CloudFront", "CDN"},
    {"ip_cidr", "13.224.0.0/14",      "Amazon CloudFront", "CDN"},
    {"ip_cidr", "54.230.0.0/16",      "Amazon CloudFront", "CDN"},
    {"ip_cidr", "54.239.128.0/18",    "Amazon CloudFront", "CDN"},
    {"ip_cidr", "108.138.0.0/15",     "Amazon CloudFront", "CDN"},  // Dubai PoP observed
    {"ip_cidr", "205.251.192.0/19",   "Amazon CloudFront", "CDN"},

    // AWS general
    {"ip_cidr", "52.0.0.0/11",        "Amazon AWS", "Cloud"},
    {"ip_cidr", "54.0.0.0/8",         "Amazon AWS", "Cloud"},
    {"ip_cidr", "18.128.0.0/9",       "Amazon AWS", "Cloud"},
    {"ip_cidr", "34.192.0.0/10",      "Amazon AWS", "Cloud"},
    {"ip_cidr", "3.0.0.0/9",          "Amazon AWS", "Cloud"},

    // Microsoft Azure
    {"ip_cidr", "13.64.0.0/11",       "Microsoft Azure", "Cloud"},
    {"ip_cidr", "13.96.0.0/13",       "Microsoft Azure", "Cloud"},
    {"ip_cidr", "40.64.0.0/10",       "Microsoft Azure", "Cloud"},
    {"ip_cidr", "52.96.0.0/11",       "Microsoft",       "Cloud"},  // 52.96-127 (52.123 observed)
    {"ip_cidr", "52.128.0.0/9",       "Microsoft Azure", "Cloud"},
    {"ip_cidr", "20.0.0.0/8",         "Microsoft Azure", "Cloud"},

    // Google Cloud — expanded to cover all observed GCP CIDRs
    {"ip_cidr", "34.0.0.0/11",        "Google Cloud", "Cloud"},  // 34.0-31
    {"ip_cidr", "34.32.0.0/11",       "Google Cloud", "Cloud"},  // 34.32-63 (34.36.x observed)
    {"ip_cidr", "34.64.0.0/10",       "Google Cloud", "Cloud"},  // 34.64-127
    {"ip_cidr", "34.96.0.0/11",       "Google Cloud", "Cloud"},  // 34.96-127 (34.98/107/110-111)
    {"ip_cidr", "34.128.0.0/10",      "Google Cloud", "Cloud"},  // 34.128-191 (34.149/160)
    {"ip_cidr", "35.186.0.0/14",      "Google Cloud", "Cloud"},  // 35.186-189
    {"ip_cidr", "35.188.0.0/14",      "Google Cloud", "Cloud"},  // 35.188-191 (35.190 observed)
    {"ip_cidr", "35.192.0.0/12",      "Google Cloud", "Cloud"},  // 35.192-207
    {"ip_cidr", "35.208.0.0/13",      "Google Cloud", "Cloud"},  // 35.208-215
    {"ip_cidr", "35.216.0.0/13",      "Google Cloud", "Cloud"},  // 35.216-223
    {"ip_cidr", "35.224.0.0/11",      "Google Cloud", "Cloud"},  // 35.224-255 (35.227 observed)

    // Netflix
    {"ip_cidr", "23.246.0.0/18",      "Netflix",    "Video"},
    {"ip_cidr", "37.77.184.0/21",     "Netflix",    "Video"},
    {"ip_cidr", "45.57.0.0/17",       "Netflix",    "Video"},
    {"ip_cidr", "64.120.128.0/17",    "Netflix",    "Video"},
    {"ip_cidr", "66.197.128.0/17",    "Netflix",    "Video"},
    {"ip_cidr", "108.175.32.0/20",    "Netflix",    "Video"},
    {"ip_cidr", "192.173.64.0/18",    "Netflix",    "Video"},
    {"ip_cidr", "198.38.96.0/19",     "Netflix",    "Video"},
    {"ip_cidr", "198.45.48.0/20",     "Netflix",    "Video"},

    // TikTok / ByteDance
    {"ip_cidr", "16.162.0.0/15",      "TikTok",     "Social"},
    {"ip_cidr", "161.117.128.0/17",   "TikTok",     "Social"},

    // Twitter / X
    {"ip_cidr", "104.244.42.0/21",    "Twitter/X",  "Social"},
    {"ip_cidr", "192.133.76.0/22",    "Twitter/X",  "Social"},

    // Snapchat
    {"ip_cidr", "103.2.45.0/24",      "Snapchat",   "Social"},

    // LinkedIn
    {"ip_cidr", "108.174.0.0/20",     "LinkedIn",   "Social"},
    {"ip_cidr", "185.63.144.0/22",    "LinkedIn",   "Social"},

    // Steam / Valve
    {"ip_cidr", "103.10.124.0/23",    "Steam",      "Gaming"},
    {"ip_cidr", "155.133.232.0/21",   "Steam",      "Gaming"},
    {"ip_cidr", "185.25.182.0/23",    "Steam",      "Gaming"},
    {"ip_cidr", "208.64.200.0/22",    "Steam",      "Gaming"},

    // PlayStation Network
    {"ip_cidr", "103.4.96.0/22",      "PlayStation Network", "Gaming"},

    // Xbox Live / Microsoft Gaming
    {"ip_cidr", "13.64.0.0/11",       "Xbox Live",  "Gaming"},

    // Epic Games
    {"ip_cidr", "185.215.232.0/22",   "Epic Games", "Gaming"},

    // Roblox
    {"ip_cidr", "128.116.0.0/16",     "Roblox",     "Gaming"},

    // DigitalOcean
    {"ip_cidr", "159.65.0.0/16",      "DigitalOcean", "Cloud"},
    {"ip_cidr", "167.98.0.0/16",      "DigitalOcean", "Cloud"},
    {"ip_cidr", "104.131.0.0/16",     "DigitalOcean", "Cloud"},
    {"ip_cidr", "198.199.64.0/18",    "DigitalOcean", "Cloud"},

    // Pakistan ISPs
    {"ip_cidr", "119.160.63.0/24",    "Jazz (Mobilink)", "ISP"},
    {"ip_cidr", "124.109.0.0/16",     "PTCL",       "ISP"},  // PTCL DSL (124.109.34.x observed)
    {"ip_cidr", "182.176.0.0/12",     "PTCL",       "ISP"},  // PTCL broadband (182.176-191)
    {"ip_cidr", "202.165.249.0/24",   "PTCL",       "ISP"},  // PTCL mobile DSL
    {"ip_cidr", "101.50.0.0/15",      "Nayatel",    "ISP"},  // Nayatel Islamabad ISP
    {"ip_cidr", "1.9.0.0/16",         "TM Net",     "ISP"},  // TM Technology Malaysia

    // Twitch Interactive
    {"ip_cidr", "160.79.104.0/21",    "Twitch",     "Video"},

    // Fastly CDN
    {"ip_cidr", "23.235.32.0/20",     "Fastly",     "CDN"},
    {"ip_cidr", "43.249.72.0/22",     "Fastly",     "CDN"},
    {"ip_cidr", "103.244.50.0/24",    "Fastly",     "CDN"},
    {"ip_cidr", "103.245.222.0/23",   "Fastly",     "CDN"},
    {"ip_cidr", "103.245.224.0/24",   "Fastly",     "CDN"},
    {"ip_cidr", "104.156.80.0/20",    "Fastly",     "CDN"},
    {"ip_cidr", "151.101.0.0/16",     "Fastly",     "CDN"},

    // Zoom
    {"ip_cidr", "3.7.35.0/25",        "Zoom",       "Conferencing"},
    {"ip_cidr", "4.34.125.128/25",    "Zoom",       "Conferencing"},
    {"ip_cidr", "50.239.202.0/23",    "Zoom",       "Conferencing"},

    // Slack
    {"ip_cidr", "54.200.0.0/16",      "Slack",      "Collaborative"},

    // Hostname additions
    {"hostname_suffix", "flowhcm.com",      "FlowHCM",         "Productivity"},
    {"hostname_suffix", "jazz.com.pk",      "Jazz (Mobilink)", "ISP"},
    {"hostname_suffix", "mobilinkworld.com","Jazz (Mobilink)", "ISP"},
};

static const size_t kSeedMappingsCount =
    sizeof(kSeedMappings) / sizeof(kSeedMappings[0]);

class AppMappings {
public:
    struct Match {
        std::string application;
        std::string category;
    };

    void add_exact_host(const std::string& h, const std::string& app,
                        const std::string& cat) {
        exact_hosts_[lower(h)] = Match{app, cat};
    }
    void add_suffix(const std::string& s, const std::string& app,
                    const std::string& cat) {
        suffixes_.push_back({lower(s), Match{app, cat}});
    }
    void add_ip(const std::string& ip, const std::string& app,
                const std::string& cat) {
        exact_ips_[ip] = Match{app, cat};
    }

    // Sort suffixes by descending length so the longest (most specific) match
    // wins, e.g. "meet.google.com" beats "google.com".
    void finalize() {
        std::sort(suffixes_.begin(), suffixes_.end(),
                  [](const auto& a, const auto& b) {
                      return a.first.size() > b.first.size();
                  });
    }

    bool lookup_by_hostname(const std::string& host_in, Match& out) const {
        std::string host = lower(host_in);
        if (host.empty()) return false;
        auto it = exact_hosts_.find(host);
        if (it != exact_hosts_.end()) { out = it->second; return true; }
        for (const auto& kv : suffixes_) {
            const std::string& suf = kv.first;
            if (host.size() < suf.size()) continue;
            // Require the match to be either the whole hostname or aligned
            // on a label boundary, so "google.com" doesn't match
            // "evilgoogle.com".
            const size_t off = host.size() - suf.size();
            if (host.compare(off, suf.size(), suf) != 0) continue;
            if (off == 0 || host[off - 1] == '.') {
                out = kv.second;
                return true;
            }
        }
        return false;
    }

    bool lookup_by_ip(const std::string& ip, Match& out) const {
        auto it = exact_ips_.find(ip);
        if (it == exact_ips_.end()) return false;
        out = it->second;
        return true;
    }

    struct CidrEntry {
        uint32_t network;  // host byte order
        uint32_t mask;
        Match    match;
    };

    void add_cidr(const std::string& cidr, const std::string& app, const std::string& cat) {
        uint32_t net, mask;
        if (!parse_cidr_static(cidr, net, mask)) return;
        cidrs_.push_back({net, mask, Match{app, cat}});
    }

    bool lookup_by_cidr(uint32_t ip_host, Match& out) const {
        for (const auto& e : cidrs_) {
            if ((ip_host & e.mask) == e.network) { out = e.match; return true; }
        }
        return false;
    }

    size_t cidr_count() const { return cidrs_.size(); }

    size_t size() const {
        return exact_hosts_.size() + suffixes_.size() + exact_ips_.size() + cidrs_.size();
    }

private:
    static std::string lower(std::string s) {
        for (char& c : s) {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
        return s;
    }

    std::unordered_map<std::string, Match> exact_hosts_;
    std::vector<std::pair<std::string, Match>> suffixes_;
    std::unordered_map<std::string, Match> exact_ips_;
    std::vector<CidrEntry> cidrs_;
};

// ============================================================================
// nDPI wrapper
// ============================================================================
class NdpiContext {
public:
    bool init() {
        // nDPI 4.6+ takes a `ndpi_global_context*` (NULL = default). All
        // dissectors are enabled by default in 5.x — no bitmask call needed.
        mod_ = ndpi_init_detection_module(nullptr);
        if (!mod_) return false;
        ndpi_finalize_initialization(mod_);
        flow_struct_size_ = ndpi_detection_get_sizeof_ndpi_flow_struct();
        return true;
    }
    void cleanup() {
        if (mod_) {
            ndpi_exit_detection_module(mod_);
            mod_ = nullptr;
        }
    }
    struct ndpi_detection_module_struct* mod() { return mod_; }
    size_t flow_struct_size() const { return flow_struct_size_; }

private:
    struct ndpi_detection_module_struct* mod_ = nullptr;
    size_t flow_struct_size_ = 0;
};

// ============================================================================
// Database wrapper (MySQL / MariaDB)
// ============================================================================
class FlowDB {
public:
    bool open(const Config& cfg) {
        if (mysql_library_init(0, nullptr, nullptr) != 0) {
            std::fprintf(stderr, "mysql_library_init failed\n");
            return false;
        }
        conn_ = mysql_init(nullptr);
        if (!conn_) {
            std::fprintf(stderr, "mysql_init failed\n");
            return false;
        }
        mysql_options(conn_, MYSQL_SET_CHARSET_NAME, "utf8mb4");

        // Auto-reconnect on lost connection (my_bool removed in MySQL 8; use bool).
        bool reconnect = true;
        mysql_options(conn_, MYSQL_OPT_RECONNECT, &reconnect);

        // TCP keepalive so Railway's load-balancer doesn't silently drop the
        // idle connection between sync intervals.
        unsigned int connect_timeout = 10;
        mysql_options(conn_, MYSQL_OPT_CONNECT_TIMEOUT, &connect_timeout);

        const char* sock = cfg.mysql_socket.empty() ? nullptr : cfg.mysql_socket.c_str();
        // Connect with no default DB so we can CREATE DATABASE first.
        // CLIENT_MULTI_STATEMENTS is intentionally omitted: Railway's TCP proxy
        // mishandles the multi-result protocol flags, corrupting the connection
        // after the first sync. Each statement is sent individually instead.
        if (!mysql_real_connect(conn_,
                                cfg.mysql_host.c_str(),
                                cfg.mysql_user.c_str(),
                                cfg.mysql_pass.empty() ? nullptr : cfg.mysql_pass.c_str(),
                                nullptr,
                                static_cast<unsigned>(cfg.mysql_port),
                                sock,
                                0)) {
            std::fprintf(stderr, "mysql_real_connect failed: %s\n", mysql_error(conn_));
            return false;
        }

        std::string create_db =
            "CREATE DATABASE IF NOT EXISTS `" + escape(cfg.mysql_db) +
            "` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci";
        if (!exec(create_db.c_str())) return false;

        if (mysql_select_db(conn_, cfg.mysql_db.c_str()) != 0) {
            std::fprintf(stderr, "mysql_select_db(%s) failed: %s\n",
                         cfg.mysql_db.c_str(), mysql_error(conn_));
            return false;
        }
        db_name_ = cfg.mysql_db;

        /*
        commented out  : because the schema already exists in the repo, and we don't want to create it every time we run the program
        if (!create_schema()) return false;
        if (!seed_app_mappings()) return false;
        
        */
        return true;
    }

    void close() {
        if (conn_) {
            mysql_close(conn_);
            conn_ = nullptr;
        }
        mysql_library_end();
    }

    void begin_tx()  { exec("START TRANSACTION"); }
    void commit_tx() { exec("COMMIT"); }

    // Ping the server and reconnect if the connection was dropped by the
    // remote TCP proxy (common with cloud MySQL like Railway).
    bool ping_reconnect() {
        if (mysql_ping(conn_) == 0) return true;
        std::fprintf(stderr, "[db] reconnecting after lost connection\n");
        if (mysql_ping(conn_) != 0) {
            std::fprintf(stderr, "[db] reconnect failed: %s\n", mysql_error(conn_));
            return false;
        }
        // Re-select the database after reconnect (session reset clears USE).
        if (mysql_select_db(conn_, db_name_.c_str()) != 0) {
            std::fprintf(stderr, "[db] mysql_select_db after reconnect failed: %s\n",
                         mysql_error(conn_));
            return false;
        }
        return true;
    }

    // Build a properly-escaped string literal: returns "NULL" if empty,
    // otherwise "'<escaped>'".
    std::string quote_or_null(const std::string& s) {
        if (s.empty()) return "NULL";
        return "'" + escape(s) + "'";
    }

    uint64_t persist_flow_id(const Flow& f) {
        const std::string start = format_timestamp(f.start_time_us);
        const std::string end   = format_timestamp(f.last_packet_time_us);
        const double duration_ms =
            static_cast<double>(f.last_packet_time_us - f.start_time_us) / 1000.0;

        const std::string urls_json  = vec_to_json_array(f.urls);
        const std::string hosts_json = vec_to_json_array(f.hostnames);

        std::ostringstream meta;
        meta << "{";
        meta << "\"ndpi_proto_id\":" << f.ndpi_proto_id;
        if (!f.master_protocol.empty())
            meta << ",\"master_protocol\":\"" << json_escape(f.master_protocol) << "\"";
        if (!f.ja3_client.empty())
            meta << ",\"ja3_client\":\"" << json_escape(f.ja3_client) << "\"";
        if (!f.ja3_server.empty())
            meta << ",\"ja3_server\":\"" << json_escape(f.ja3_server) << "\"";
        if (!f.user_agent.empty())
            meta << ",\"user_agent\":\"" << json_escape(f.user_agent) << "\"";
        if (!f.http_method.empty())
            meta << ",\"http_method\":\"" << json_escape(f.http_method) << "\"";
        if (!f.tls_version.empty())
            meta << ",\"tls_version\":\"" << json_escape(f.tls_version) << "\"";
        if (!f.tls_alpn.empty())
            meta << ",\"tls_alpn\":\"" << json_escape(f.tls_alpn) << "\"";
        if (!f.tls_issuer_dn.empty())
            meta << ",\"tls_issuer_dn\":\"" << json_escape(f.tls_issuer_dn) << "\"";
        if (!f.tls_subject_dn.empty())
            meta << ",\"tls_subject_dn\":\"" << json_escape(f.tls_subject_dn) << "\"";
        if (f.tls_cert_not_after)
            meta << ",\"tls_cert_not_after\":" << f.tls_cert_not_after;
        if (f.quic_version)
            meta << ",\"quic_version\":" << f.quic_version;
        meta << "}";

        // The `id = LAST_INSERT_ID(id)` trick lets us get the row id back via
        // mysql_insert_id() whether the row was newly inserted OR updated.
        std::ostringstream q;
        q << "INSERT INTO flows ("
          << "  flow_hash, src_ip, dst_ip, src_port, dst_port, protocol,"
          << "  application, start_time, end_time,"
          << "  flow_duration_ms, packet_sent, packet_recv,"
          << "  bytes_sent, bytes_recv, urls, hostnames, metadata"
          << ") VALUES ("
          << "'" << escape(f.flow_hash) << "',"
          << "'" << escape(f.src_ip) << "',"
          << "'" << escape(f.dst_ip) << "',"
          << f.src_port << "," << f.dst_port << "," << static_cast<int>(f.protocol) << ","
          << quote_or_null(f.application) << ","
          << "'" << escape(start) << "',"
          << "'" << escape(end)   << "',"
          << duration_ms << ","
          << f.packets_sent << "," << f.packets_recv << ","
          << f.bytes_sent  << "," << f.bytes_recv  << ","
          << "'" << escape(urls_json) << "',"
          << "'" << escape(hosts_json) << "',"
          << "'" << escape(meta.str()) << "'"
          << ") ON DUPLICATE KEY UPDATE "
          << "  id = LAST_INSERT_ID(id),"
          << "  src_ip = VALUES(src_ip), dst_ip = VALUES(dst_ip),"
          << "  src_port = VALUES(src_port), dst_port = VALUES(dst_port),"
          << "  application = VALUES(application),"
          << "  end_time = VALUES(end_time),"
          << "  flow_duration_ms = VALUES(flow_duration_ms),"
          << "  packet_sent = VALUES(packet_sent),"
          << "  packet_recv = VALUES(packet_recv),"
          << "  bytes_sent = VALUES(bytes_sent),"
          << "  bytes_recv = VALUES(bytes_recv),"
          << "  urls = VALUES(urls),"
          << "  hostnames = VALUES(hostnames),"
          << "  metadata = VALUES(metadata),"
          << "  updated_at = CURRENT_TIMESTAMP";

        if (!exec(q.str().c_str())) return 0;

        const uint64_t flow_id = static_cast<uint64_t>(mysql_insert_id(conn_));

        if (flow_id != 0) {
            for (const std::string& host : f.hostnames) {
                std::ostringstream h;
                h << "INSERT INTO hostnames (hostname, flow_id, first_seen, last_seen, resolution_count) VALUES ("
                  << "'" << escape(host) << "',"
                  << flow_id << ","
                  << "'" << escape(start) << "',"
                  << "'" << escape(end)   << "',"
                  << "1)";
                exec(h.str().c_str());
            }

            for (const std::string& url : f.urls) {
                std::string proto, host, path, query;
                parse_url(url, proto, host, path, query);
                std::ostringstream u;
                u << "INSERT INTO urls (url, host, path, query_params, protocol, flow_id, first_seen, last_seen, access_count) VALUES ("
                  << "'" << escape(url) << "',"
                  << quote_or_null(host) << ","
                  << quote_or_null(path) << ","
                  << quote_or_null(query) << ","
                  << quote_or_null(proto) << ","
                  << flow_id << ","
                  << "'" << escape(start) << "',"
                  << "'" << escape(end)   << "',"
                  << "1) ON DUPLICATE KEY UPDATE "
                  << "  last_seen = VALUES(last_seen),"
                  << "  access_count = access_count + 1";
                exec(u.str().c_str());
            }
        }

        return flow_id;
    }

    // Called once per finalized flow (not on sync_active upserts) to avoid
    // double-counting bytes/packets in the summary.
    void update_app_summary(const Flow& f) {
        if (f.application.empty() || f.application == "Unknown") return;
        const std::string start    = format_timestamp(f.start_time_us);
        const std::string end      = format_timestamp(f.last_packet_time_us);
        const double duration_ms   = (f.last_packet_time_us > f.start_time_us)
            ? (f.last_packet_time_us - f.start_time_us) / 1000.0 : 0.0;
        std::ostringstream a;
        a << "INSERT INTO applications_summary ("
          << "  application, category, total_flows,"
          << "  total_packets_sent, total_packets_recv,"
          << "  total_bytes_sent, total_bytes_recv,"
          << "  total_duration_ms, first_seen, last_seen, last_updated"
          << ") VALUES ("
          << "'" << escape(f.application) << "',"
          << quote_or_null(f.app_category) << ","
          << "1,"
          << f.packets_sent << "," << f.packets_recv << ","
          << f.bytes_sent   << "," << f.bytes_recv   << ","
          << duration_ms    << ","
          << "'" << escape(start) << "',"
          << "'" << escape(end)   << "',"
          << "CURRENT_TIMESTAMP"
          << ") ON DUPLICATE KEY UPDATE "
          << "  category = COALESCE(VALUES(category), category),"
          << "  total_flows = total_flows + 1,"
          << "  total_packets_sent = total_packets_sent + VALUES(total_packets_sent),"
          << "  total_packets_recv = total_packets_recv + VALUES(total_packets_recv),"
          << "  total_bytes_sent  = total_bytes_sent  + VALUES(total_bytes_sent),"
          << "  total_bytes_recv  = total_bytes_recv  + VALUES(total_bytes_recv),"
          << "  total_duration_ms = total_duration_ms + VALUES(total_duration_ms),"
          << "  first_seen = LEAST(IFNULL(first_seen, VALUES(first_seen)), VALUES(first_seen)),"
          << "  last_seen  = GREATEST(IFNULL(last_seen, VALUES(last_seen)), VALUES(last_seen)),"
          << "  last_updated = CURRENT_TIMESTAMP";
        exec(a.str().c_str());
    }

    // Loads capture_policy as an allowlist into 'allowed' and sets
    // policy_active=true when any rows exist.  Empty table → capture all.
    bool load_capture_policy(std::unordered_set<std::string>& allowed,
                             bool& policy_active) {
        allowed.clear();
        policy_active = false;
        MYSQL_RES* cnt_res = nullptr;
        if (mysql_query(conn_, "SELECT COUNT(*) FROM capture_policy") == 0)
            cnt_res = mysql_store_result(conn_);
        if (!cnt_res) return true;
        MYSQL_ROW cnt_row = mysql_fetch_row(cnt_res);
        const long total = cnt_row ? std::atol(cnt_row[0]) : 0;
        mysql_free_result(cnt_res);
        if (total == 0) return true; // empty policy → capture all
        policy_active = true;
        if (mysql_query(conn_, "SELECT application FROM capture_policy WHERE enabled=1") != 0)
            return false;
        MYSQL_RES* res = mysql_store_result(conn_);
        if (!res) return false;
        MYSQL_ROW row;
        while ((row = mysql_fetch_row(res))) {
            if (row[0]) allowed.insert(row[0]);
        }
        mysql_free_result(res);
        return true;
    }

    uint64_t ipdr_create(const Flow& f, const std::string& key_str) {
        std::string ts_first = format_timestamp(f.start_time_us);
        std::string ts_last  = format_timestamp(f.last_packet_time_us);
        std::ostringstream q;
        q << "INSERT IGNORE INTO ipdr_keys "
          << "(key_string, src_ip, dst_ip, dst_port, application,"
          << " packets_sent, bytes_sent, packets_recv, bytes_recv,"
          << " first_seen, last_seen, status) VALUES ("
          << "'" << escape(key_str) << "',"
          << "'" << escape(f.src_ip) << "',"
          << "'" << escape(f.dst_ip) << "',"
          << f.dst_port << ","
          << "'" << escape(f.application) << "',"
          << f.packets_sent << "," << f.bytes_sent << ","
          << f.packets_recv << "," << f.bytes_recv << ","
          << "'" << escape(ts_first) << "',"
          << "'" << escape(ts_last)  << "',"
          << "'active')";
        if (!exec(q.str().c_str())) return 0;
        return static_cast<uint64_t>(mysql_insert_id(conn_));
    }

    void ipdr_update(uint64_t id, const Flow& f) {
        std::string ts_last = format_timestamp(f.last_packet_time_us);
        std::ostringstream q;
        q << "UPDATE ipdr_keys SET "
          << "packets_sent = packets_sent + " << f.packets_sent << ","
          << "bytes_sent   = bytes_sent   + " << f.bytes_sent   << ","
          << "packets_recv = packets_recv + " << f.packets_recv << ","
          << "bytes_recv   = bytes_recv   + " << f.bytes_recv   << ","
          << "last_seen = '" << escape(ts_last) << "' "
          << "WHERE id = " << id;
        exec(q.str().c_str());
    }

    void ipdr_close(uint64_t id) {
        std::ostringstream q;
        q << "UPDATE ipdr_keys SET status='closed' WHERE id=" << id;
        exec(q.str().c_str());
    }

    void ipdr_link_flow(uint64_t flow_id, uint64_t key_id) {
        std::ostringstream q;
        q << "UPDATE flows SET ipdr_key_id=" << key_id << " WHERE id=" << flow_id;
        exec(q.str().c_str());
    }

private:
    MYSQL* conn_ = nullptr;
    std::string db_name_;

    std::string escape(const std::string& s) {
        if (!conn_) return s;
        std::string out;
        out.resize(s.size() * 2 + 1);
        unsigned long n = mysql_real_escape_string(conn_, &out[0], s.data(), s.size());
        out.resize(n);
        return out;
    }

    bool exec(const char* sql) {
        if (mysql_query(conn_, sql) != 0) {
            std::fprintf(stderr, "MySQL error: %s\n  SQL: %.300s\n",
                         mysql_error(conn_), sql);
            return false;
        }
        MYSQL_RES* res = mysql_store_result(conn_);
        if (res) mysql_free_result(res);
        return true;
    }

    bool create_schema() {
        // Each statement is sent individually — CLIENT_MULTI_STATEMENTS is not
        // used, so we cannot batch these into one mysql_query() call.
        if (!exec(
            "CREATE TABLE IF NOT EXISTS flows ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  flow_hash CHAR(32) NOT NULL,"
            "  src_ip VARCHAR(45) NOT NULL,"
            "  dst_ip VARCHAR(45) NOT NULL,"
            "  src_port INT UNSIGNED NOT NULL,"
            "  dst_port INT UNSIGNED NOT NULL,"
            "  protocol SMALLINT UNSIGNED NOT NULL,"
            "  application VARCHAR(255),"
            "  application_category VARCHAR(255),"
            "  start_time DATETIME(6) NOT NULL,"
            "  end_time   DATETIME(6),"
            "  flow_duration_ms DOUBLE,"
            "  packet_sent BIGINT UNSIGNED DEFAULT 0,"
            "  packet_recv BIGINT UNSIGNED DEFAULT 0,"
            "  bytes_sent  BIGINT UNSIGNED DEFAULT 0,"
            "  bytes_recv  BIGINT UNSIGNED DEFAULT 0,"
            "  total_packets BIGINT UNSIGNED GENERATED ALWAYS AS (packet_sent + packet_recv) STORED,"
            "  total_bytes   BIGINT UNSIGNED GENERATED ALWAYS AS (bytes_sent + bytes_recv) STORED,"
            "  urls      TEXT,"
            "  hostnames TEXT,"
            "  metadata  TEXT,"
            "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
            "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
            "  UNIQUE KEY uk_flow_hash (flow_hash),"
            "  KEY idx_flow_times (start_time, end_time),"
            "  KEY idx_flow_app   (application),"
            "  KEY idx_flow_ips   (src_ip, dst_ip),"
            "  KEY idx_flow_ports (src_port, dst_port),"
            "  KEY idx_flow_duration (flow_duration_ms)"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS urls ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  url VARCHAR(2048) NOT NULL,"
            "  host VARCHAR(255),"
            "  path VARCHAR(2048),"
            "  query_params TEXT,"
            "  protocol VARCHAR(16),"
            "  flow_id BIGINT UNSIGNED,"
            "  first_seen DATETIME(6) NOT NULL,"
            "  last_seen  DATETIME(6) NOT NULL,"
            "  access_count INT UNSIGNED DEFAULT 1,"
            "  UNIQUE KEY idx_unique_url_flow (url(255), flow_id),"
            "  KEY idx_url_host (host),"
            "  KEY idx_url_flow (flow_id),"
            "  CONSTRAINT fk_urls_flow FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS applications_summary ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  application VARCHAR(255) NOT NULL,"
            "  category VARCHAR(255),"
            "  total_flows BIGINT UNSIGNED DEFAULT 0,"
            "  total_packets_sent BIGINT UNSIGNED DEFAULT 0,"
            "  total_packets_recv BIGINT UNSIGNED DEFAULT 0,"
            "  total_bytes_sent  BIGINT UNSIGNED DEFAULT 0,"
            "  total_bytes_recv  BIGINT UNSIGNED DEFAULT 0,"
            "  total_duration_ms DOUBLE DEFAULT 0,"
            "  first_seen DATETIME(6),"
            "  last_seen  DATETIME(6),"
            "  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
            "  UNIQUE KEY uk_application (application)"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS hostnames ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  hostname VARCHAR(512) NOT NULL,"
            "  flow_id BIGINT UNSIGNED,"
            "  first_seen DATETIME(6),"
            "  last_seen  DATETIME(6),"
            "  resolution_count INT UNSIGNED DEFAULT 1,"
            "  KEY idx_hostname (hostname(255)),"
            "  KEY idx_hostname_flow (flow_id),"
            "  CONSTRAINT fk_hostnames_flow FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS application_mappings ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  pattern_type ENUM('hostname_exact','hostname_suffix','ip_exact','ip_cidr') NOT NULL,"
            "  pattern VARCHAR(255) NOT NULL,"
            "  application VARCHAR(255) NOT NULL,"
            "  category VARCHAR(64),"
            "  priority INT NOT NULL DEFAULT 100,"
            "  notes VARCHAR(255),"
            "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
            "  UNIQUE KEY uk_pattern (pattern_type, pattern),"
            "  KEY idx_app (application)"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS ipdr_keys ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  key_string VARCHAR(512) NOT NULL,"
            "  src_ip VARCHAR(45) NOT NULL,"
            "  dst_ip VARCHAR(45) NOT NULL,"
            "  dst_port INT UNSIGNED NOT NULL,"
            "  application VARCHAR(255) DEFAULT '',"
            "  packets_sent BIGINT UNSIGNED DEFAULT 0,"
            "  bytes_sent BIGINT UNSIGNED DEFAULT 0,"
            "  packets_recv BIGINT UNSIGNED DEFAULT 0,"
            "  bytes_recv BIGINT UNSIGNED DEFAULT 0,"
            "  first_seen DATETIME(6) NOT NULL,"
            "  last_seen DATETIME(6) NOT NULL,"
            "  status ENUM('active','closed') DEFAULT 'active',"
            "  KEY idx_lookup (src_ip, dst_ip, dst_port, application(64), status),"
            "  KEY idx_status (status),"
            "  KEY idx_last_seen (last_seen)"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        if (!exec(
            "CREATE TABLE IF NOT EXISTS protocol_metadata ("
            "  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
            "  flow_id BIGINT UNSIGNED NOT NULL,"
            "  tls_version VARCHAR(20),"
            "  sni VARCHAR(512),"
            "  ja3_client VARCHAR(64),"
            "  ja3_server VARCHAR(64),"
            "  tls_alpn VARCHAR(256),"
            "  issuer_dn VARCHAR(512),"
            "  subject_dn VARCHAR(512),"
            "  cert_not_after INT UNSIGNED,"
            "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
            "  KEY idx_flow (flow_id),"
            "  CONSTRAINT fk_pm_flow FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )) return false;

        // Idempotent migrations — errors are ignored (column/key already exists).
        exec("ALTER TABLE flows ADD COLUMN ipdr_key_id BIGINT UNSIGNED AFTER metadata");
        exec("ALTER TABLE flows ADD KEY idx_flow_ipdr (ipdr_key_id)");
        exec("ALTER TABLE flows DROP COLUMN application_category");
        exec("ALTER TABLE application_mappings MODIFY COLUMN pattern_type "
             "ENUM('hostname_exact','hostname_suffix','ip_exact','ip_cidr') NOT NULL");
        exec(
            "CREATE TABLE IF NOT EXISTS capture_policy ("
            "  application VARCHAR(255) NOT NULL PRIMARY KEY,"
            "  enabled     TINYINT(1)   NOT NULL DEFAULT 1"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        );
        return true;
    }

public:
    bool seed_app_mappings() {
        if (kSeedMappingsCount == 0) return true;
        // Single big INSERT IGNORE — keeps startup fast and is harmless to
        // re-run on every launch.
        std::ostringstream q;
        q << "INSERT IGNORE INTO application_mappings "
          << "(pattern_type, pattern, application, category) VALUES ";
        for (size_t i = 0; i < kSeedMappingsCount; ++i) {
            const SeedRow& r = kSeedMappings[i];
            if (i) q << ',';
            q << "('" << escape(r.type) << "',"
              << "'"  << escape(r.pattern) << "',"
              << "'"  << escape(r.app) << "',"
              << "'"  << escape(r.category) << "')";
        }
        return exec(q.str().c_str());
    }

    bool load_app_mappings(AppMappings& out) {
        const char* sql =
            "SELECT pattern_type, pattern, application, "
            "       IFNULL(category, '') "
            "FROM application_mappings "
            "ORDER BY priority DESC, CHAR_LENGTH(pattern) DESC";
        if (mysql_query(conn_, sql) != 0) {
            std::fprintf(stderr, "load_app_mappings query failed: %s\n",
                         mysql_error(conn_));
            return false;
        }
        MYSQL_RES* res = mysql_store_result(conn_);
        if (!res) {
            std::fprintf(stderr, "load_app_mappings store_result failed: %s\n",
                         mysql_error(conn_));
            return false;
        }
        MYSQL_ROW row;
        while ((row = mysql_fetch_row(res))) {
            unsigned long* lens = mysql_fetch_lengths(res);
            std::string type(row[0] ? row[0] : "", row[0] ? lens[0] : 0);
            std::string pat (row[1] ? row[1] : "", row[1] ? lens[1] : 0);
            std::string app (row[2] ? row[2] : "", row[2] ? lens[2] : 0);
            std::string cat (row[3] ? row[3] : "", row[3] ? lens[3] : 0);
            if (type == "hostname_exact")       out.add_exact_host(pat, app, cat);
            else if (type == "hostname_suffix") out.add_suffix    (pat, app, cat);
            else if (type == "ip_exact")        out.add_ip        (pat, app, cat);
            else if (type == "ip_cidr")         out.add_cidr      (pat, app, cat);
        }
        mysql_free_result(res);
        out.finalize();
        return true;
    }

private:

    static void parse_url(const std::string& url,
                          std::string& proto, std::string& host,
                          std::string& path, std::string& query) {
        size_t scheme_end = url.find("://");
        size_t cursor = 0;
        if (scheme_end != std::string::npos) {
            proto = url.substr(0, scheme_end);
            cursor = scheme_end + 3;
        }
        size_t path_start = url.find('/', cursor);
        if (path_start == std::string::npos) {
            host = url.substr(cursor);
            return;
        }
        host = url.substr(cursor, path_start - cursor);
        size_t q = url.find('?', path_start);
        if (q == std::string::npos) {
            path = url.substr(path_start);
        } else {
            path = url.substr(path_start, q - path_start);
            query = url.substr(q + 1);
        }
    }
};

// ============================================================================
// IPDR key entry (in-memory cache of active ipdr_keys rows)
// ============================================================================
struct IpdrKeyEntry {
    uint64_t id;
    std::string key_string;
    uint64_t last_seen_us;
};

// ============================================================================
// Flow tracker
// ============================================================================
class FlowTracker {
public:
    FlowTracker(NdpiContext& ndpi, FlowDB& db, const AppMappings& mappings,
                const Config& cfg)
        : ndpi_(ndpi), db_(db), mappings_(mappings), cfg_(cfg)
    {
        // Load policy immediately so the allowlist is active from the very
        // first packet — not after the first sync_interval_seconds delay.
        db_.load_capture_policy(allowed_apps_, policy_active_);
        if (policy_active_) {
            std::fprintf(stderr,
                "[policy] allowlist active at startup — %zu application(s) permitted: ",
                allowed_apps_.size());
            bool first = true;
            for (const auto& a : allowed_apps_) {
                std::fprintf(stderr, "%s%s", first ? "" : ", ", a.c_str());
                first = false;
            }
            std::fprintf(stderr, "\n");
        } else {
            std::fprintf(stderr,
                "[policy] no capture policy configured — all applications will be captured\n");
        }
    }

    ~FlowTracker() = default;

    void on_packet(const PacketMessage& m, const uint8_t* payload) {
        Flow* f = lookup_or_create(m);
        if (!f) return;

        const bool same_dir =
            (std::memcmp(m.src_ip, f->src_ip_bytes, 16) == 0 &&
             std::memcmp(m.dst_ip, f->dst_ip_bytes, 16) == 0 &&
             m.src_port == f->src_port && m.dst_port == f->dst_port);

        if (same_dir) {
            f->packets_sent += 1;
            f->bytes_sent   += m.packet_len;
        } else {
            f->packets_recv += 1;
            f->bytes_recv   += m.packet_len;
        }
        f->last_packet_time_us = m.timestamp_us;

        run_ndpi(*f, m, payload);

        if (++packet_counter_ % cfg_.sweep_every_packets == 0) {
            sweep_expired(m.timestamp_us);
        }

        // Periodic real-time sync: wall-clock based so it fires at actual
        // wall time regardless of whether the traffic is live or PCAP replay.
        if (cfg_.sync_interval_seconds > 0) {
            auto now_wall = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                now_wall - last_sync_time_).count();
            if (elapsed >= cfg_.sync_interval_seconds) {
                sync_active();
                last_sync_time_ = now_wall;
            }
        }

        if (flows_.size() > cfg_.max_active_flows) {
            evict_oldest();  // assumes the caller already opened a tx
        }
    }

    // Caller is expected to hold an open transaction. Both call paths
    // (per-packet sweep from the main loop, shutdown flush from main)
    // already wrap the call site in begin_tx/commit_tx so we avoid
    // nested-BEGIN errors here.
    void sweep_expired(uint64_t now_us) {
        const uint64_t timeout_us = static_cast<uint64_t>(cfg_.flow_timeout_seconds) * 1000000ULL;
        if (now_us <= timeout_us) return;
        const uint64_t cutoff = now_us - timeout_us;

        std::vector<std::string> expired;
        for (auto& kv : flows_) {
            if (kv.second->last_packet_time_us < cutoff) {
                expired.push_back(kv.first);
            }
        }
        if (expired.empty()) return;
        for (const auto& key : expired) {
            finalize_and_persist(*flows_[key], now_us);
            flows_.erase(key);
        }
        if (cfg_.verbose) {
            std::fprintf(stderr, "[flow_monitor] swept %zu expired flows (active=%zu)\n",
                         expired.size(), flows_.size());
        }

        // Sweep expired IPDR keys
        {
            for (auto it = ipdr_keys_.begin(); it != ipdr_keys_.end(); ) {
                if (now_us - it->second.last_seen_us > timeout_us) {
                    db_.ipdr_close(it->second.id);
                    it = ipdr_keys_.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }

    void flush_all() {
        if (flows_.empty()) return;
        // Use the latest packet time seen across all in-flight flows as now_us
        uint64_t now_us = 0;
        for (auto& kv : flows_)
            if (kv.second->last_packet_time_us > now_us)
                now_us = kv.second->last_packet_time_us;
        for (auto& kv : flows_)
            finalize_and_persist(*kv.second, now_us);
        flows_.clear();
        if (cfg_.verbose)
            std::fprintf(stderr, "[flow_monitor] flushed all flows\n");
    }

    // Walk every active flow and UPSERT its current state to the DB.
    // Commits the outer transaction before writing and opens a fresh one
    // afterwards so live data is visible in the DB immediately.
    void sync_active() {
        // Reload policy so UI changes take effect within one sync interval
        db_.load_capture_policy(allowed_apps_, policy_active_);
        if (cfg_.verbose) {
            if (policy_active_)
                std::fprintf(stderr, "[policy] allowlist active — %zu app(s) permitted\n",
                             allowed_apps_.size());
            else
                std::fprintf(stderr, "[policy] no policy — capturing all applications\n");
        }

        if (flows_.empty()) return;

        // Verify the MySQL connection is alive before writing; reconnect if
        // the Railway TCP proxy silently dropped it between sync intervals.
        if (!db_.ping_reconnect()) {
            std::fprintf(stderr, "[flow_monitor] skipping sync — DB unreachable\n");
            return;
        }

        db_.commit_tx();
        db_.begin_tx();

        // Use the current wall clock as the refresh timestamp for IPDR keys.
        const uint64_t now_us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());

        for (auto& kv : flows_) {
            Flow& f = *kv.second;
            // finalize_protocol applies mapping overrides so f.application is
            // the resolved name before the policy check.
            finalize_protocol(f);
            // Policy check: only write live upserts for allowed applications.
            // Flows whose application is still unresolved ("Unknown" / "") at
            // sync time are skipped; they will be re-evaluated at expiry.
            if (policy_active_ && !allowed_apps_.count(f.application)) continue;
            db_.persist_flow_id(f);

            // Keep the IPDR key alive while the flow is still active so it
            // doesn't close during a long-running session (e.g. YouTube stream).
            if (!f.application.empty() && f.application != "Unknown") {
                const std::string lk = f.src_ip + "|" + f.dst_ip + "|" +
                                       std::to_string(f.dst_port) + "|" + f.application;
                auto it = ipdr_keys_.find(lk);
                if (it != ipdr_keys_.end()) {
                    it->second.last_seen_us = now_us;
                }
            }
        }
        db_.commit_tx();
        db_.begin_tx();
        if (cfg_.verbose) {
            std::fprintf(stderr, "[flow_monitor] synced %zu active flows to DB\n",
                         flows_.size());
        }
    }

private:
    NdpiContext& ndpi_;
    FlowDB& db_;
    const AppMappings& mappings_;
    Config cfg_;
    std::unordered_map<std::string, std::unique_ptr<Flow>> flows_;
    std::unordered_map<std::string, IpdrKeyEntry> ipdr_keys_;
    std::unordered_set<std::string> allowed_apps_;
    bool policy_active_ = false;
    uint64_t packet_counter_ = 0;
    std::chrono::steady_clock::time_point last_sync_time_ = std::chrono::steady_clock::now();

    Flow* lookup_or_create(const PacketMessage& m) {
        std::string ip_a = ip_bytes_to_str(m.src_ip, m.ip_version);
        std::string ip_b = ip_bytes_to_str(m.dst_ip, m.ip_version);
        // Canonical 5-tuple hash — used as the in-memory map key only. After
        // a flow expires the entry is removed; a new packet then re-creates
        // the entry under the same canonical key, but with a fresh DB
        // flow_hash (see below) so a new row is produced.
        std::string canonical = canonical_flow_hash(ip_a, ip_b, m.src_port, m.dst_port, m.protocol);

        auto it = flows_.find(canonical);
        if (it != flows_.end()) return it->second.get();

        auto f = std::make_unique<Flow>();
        f->src_ip = ip_a;
        f->dst_ip = ip_b;
        f->ip_version = m.ip_version;
        std::memcpy(f->src_ip_bytes, m.src_ip, 16);
        std::memcpy(f->dst_ip_bytes, m.dst_ip, 16);
        f->src_port = m.src_port;
        f->dst_port = m.dst_port;
        f->protocol = m.protocol;
        f->start_time_us = m.timestamp_us;
        f->last_packet_time_us = m.timestamp_us;
        // DB-side hash: mix in start_time_us so a flow that times out and
        // re-appears later with the same 5-tuple is a NEW row, not an
        // overwrite of the previous session.
        {
            std::ostringstream key;
            key << canonical << '_' << m.timestamp_us;
            f->flow_hash = md5_impl::md5_hex(key.str());
        }
        f->ndpi_flow = static_cast<struct ndpi_flow_struct*>(
            std::calloc(1, ndpi_.flow_struct_size()));
        if (!f->ndpi_flow) {
            std::fprintf(stderr, "calloc(ndpi_flow) failed\n");
            return nullptr;
        }
        Flow* raw = f.get();
        flows_.emplace(canonical, std::move(f));
        return raw;
    }

    static bool proto_is_tls_family(const ndpi_protocol& p) {
        const uint16_t app  = p.proto.app_protocol;
        const uint16_t mstr = p.proto.master_protocol;
        return app  == NDPI_PROTOCOL_TLS  || mstr == NDPI_PROTOCOL_TLS  ||
               app  == NDPI_PROTOCOL_QUIC || mstr == NDPI_PROTOCOL_QUIC ||
               app  == NDPI_PROTOCOL_DTLS || mstr == NDPI_PROTOCOL_DTLS ||
               app  == NDPI_PROTOCOL_FTPS || mstr == NDPI_PROTOCOL_FTPS;
    }

    void run_ndpi(Flow& f, const PacketMessage& m, const uint8_t* payload) {
        if (!payload || m.payload_len == 0) return;
        ++f.packets_seen_for_ndpi;

        const uint64_t ts_ms = m.timestamp_us / 1000ULL;
        ndpi_protocol p = ndpi_detection_process_packet(
            ndpi_.mod(), f.ndpi_flow,
            payload, m.payload_len, ts_ms,
            nullptr);

        // Snapshot metadata; only allow tls_quic union reads if nDPI
        // has identified this as a TLS-family flow.
        capture_extracted(f, proto_is_tls_family(p));

        if (f.ndpi_finalized) return;

        const bool decided =
            p.proto.app_protocol != NDPI_PROTOCOL_UNKNOWN ||
            p.proto.master_protocol != NDPI_PROTOCOL_UNKNOWN;
        const bool exhausted = f.packets_seen_for_ndpi >= cfg_.ndpi_max_packets;

        if (decided || exhausted) {
            ndpi_protocol final = ndpi_detection_giveup(ndpi_.mod(), f.ndpi_flow);

            char proto_name[128];
            ndpi_protocol2name(ndpi_.mod(), final.proto, proto_name, sizeof(proto_name));
            f.application = proto_name;
            f.ndpi_proto_id = final.proto.app_protocol;

            if (final.proto.master_protocol != NDPI_PROTOCOL_UNKNOWN) {
                const char* mp = ndpi_get_proto_name(ndpi_.mod(), final.proto.master_protocol);
                if (mp) f.master_protocol = mp;
            }

            ndpi_protocol_category_t cat = final.category;
            const char* cat_name = ndpi_category_get_name(ndpi_.mod(), cat);
            if (cat_name) f.app_category = cat_name;

            if (f.application == "Unknown" || f.application.empty()) {
                const std::string port_app = port_to_app(f.protocol, f.dst_port);
                if (!port_app.empty()) f.application = port_app;
            }

            f.ndpi_finalized = true;
            capture_extracted(f, proto_is_tls_family(final));
        }
    }

    // tls_ok: caller must pass true only when the detected protocol is TLS/QUIC/DTLS
    // or related (FTPS etc.).  The protos union is shared with DNS and other
    // dissectors; reading tls_quic pointer fields on a DNS flow aliases
    // them to DNS counter bytes and causes a segfault on dereference.
    void capture_extracted(Flow& f, bool tls_ok = false) {
        if (!f.ndpi_flow) return;

        const std::string host = copy_cstr(f.ndpi_flow->host_server_name,
                                           sizeof(f.ndpi_flow->host_server_name));
        if (!host.empty() && f.hostnames_set.insert(host).second) {
            f.hostnames.push_back(host);
        }

        // http is a dedicated struct outside the protos union — always safe.
        if (f.ndpi_flow->http.url) {
            const char* p = f.ndpi_flow->http.url;
            std::string url(p);
            if (!url.empty() && f.urls_set.insert(url).second) {
                f.urls.push_back(url);
            }
        }
        if (f.ndpi_flow->http.user_agent && f.user_agent.empty()) {
            f.user_agent = f.ndpi_flow->http.user_agent;
        }
        if (f.ndpi_flow->http.method && f.http_method.empty()) {
            const char* m = ndpi_http_method2str(f.ndpi_flow->http.method);
            if (m) f.http_method = m;
        }

        // protos is a union; tls_quic members overlap with DNS counters etc.
        // Only read when the protocol has been (or is being) identified as TLS-family.
        if (tls_ok) {
            auto& tq = f.ndpi_flow->protos.tls_quic;
            if (tq.ssl_version && f.tls_version.empty()) {
                const uint16_t v = tq.ssl_version;
                if      (v == 0x0300) f.tls_version = "SSL3.0";
                else if (v == 0x0301) f.tls_version = "TLS1.0";
                else if (v == 0x0302) f.tls_version = "TLS1.1";
                else if (v == 0x0303) f.tls_version = "TLS1.2";
                else if (v == 0x0304) f.tls_version = "TLS1.3";
            }
            // QUIC/TLS SNI: nDPI stores comma-separated names in tq.server_names
            // (different from host_server_name which is HTTP-only and fixed-size).
            if (tq.server_names && *tq.server_names) {
                std::string raw(tq.server_names);
                std::istringstream ss(raw);
                std::string token;
                while (std::getline(ss, token, ',')) {
                    if (!token.empty() && f.hostnames_set.insert(token).second)
                        f.hostnames.push_back(token);
                }
            }
            if (tq.quic_version && !f.quic_version)
                f.quic_version = tq.quic_version;
            if (tq.ja4_client[0] && f.ja3_client.empty())
                f.ja3_client = std::string(tq.ja4_client,
                                           strnlen(tq.ja4_client, sizeof(tq.ja4_client)));
            if (tq.ja3_server[0] && f.ja3_server.empty())
                f.ja3_server = std::string(tq.ja3_server,
                                           strnlen(tq.ja3_server, sizeof(tq.ja3_server)));
            if (tq.advertised_alpns && *tq.advertised_alpns && f.tls_alpn.empty())
                f.tls_alpn = tq.advertised_alpns;
            if (tq.issuerDN && *tq.issuerDN && f.tls_issuer_dn.empty())
                f.tls_issuer_dn = tq.issuerDN;
            if (tq.subjectDN && *tq.subjectDN && f.tls_subject_dn.empty())
                f.tls_subject_dn = tq.subjectDN;
            if (tq.notAfter && !f.tls_cert_not_after)
                f.tls_cert_not_after = tq.notAfter;
        }
    }

    // Lock in nDPI's verdict (if it hasn't decided yet) and apply the
    // hostname/IP → app mapping table. Idempotent — safe to call repeatedly
    // from sync_active(). Does NOT free the nDPI flow struct, so the flow
    // can keep accumulating metadata after a sync.
    void finalize_protocol(Flow& f) {
        if (!f.ndpi_finalized && f.ndpi_flow) {
            ndpi_protocol final = ndpi_detection_giveup(ndpi_.mod(), f.ndpi_flow);
            char proto_name[128];
            ndpi_protocol2name(ndpi_.mod(), final.proto, proto_name, sizeof(proto_name));
            f.application = proto_name;
            f.ndpi_proto_id = final.proto.app_protocol;
            if (final.proto.master_protocol != NDPI_PROTOCOL_UNKNOWN) {
                const char* mp = ndpi_get_proto_name(ndpi_.mod(), final.proto.master_protocol);
                if (mp) f.master_protocol = mp;
            }
            const char* cat_name = ndpi_category_get_name(ndpi_.mod(), final.category);
            if (cat_name) f.app_category = cat_name;
            f.ndpi_finalized = true;
            capture_extracted(f, proto_is_tls_family(final));
        }
        if (f.application.empty()) f.application = "Unknown";
        apply_mapping_override(f);
    }

    void finalize_and_persist(Flow& f, uint64_t now_us) {
        // finalize_protocol resolves nDPI verdict + applies mapping overrides,
        // giving f.application its final name before the policy check below.
        finalize_protocol(f);

        // Allowlist check — gates ALL table writes:
        //   flows, hostnames, urls, protocol_metadata (inline in flows.metadata),
        //   applications_summary, ipdr_keys
        if (policy_active_ && !allowed_apps_.count(f.application)) {
            if (cfg_.verbose) {
                std::fprintf(stderr,
                    "[policy] dropped flow: app='%s' not in allowlist\n",
                    f.application.c_str());
            }
            if (f.ndpi_flow) { ndpi_flow_free(f.ndpi_flow); f.ndpi_flow = nullptr; }
            return;
        }

        const uint64_t flow_id = db_.persist_flow_id(f);   // flows + hostnames + urls
        if (flow_id) {
            db_.update_app_summary(f);                      // applications_summary
            assign_ipdr_key(f, flow_id, now_us);            // ipdr_keys
        }
        if (f.ndpi_flow) { ndpi_flow_free(f.ndpi_flow); f.ndpi_flow = nullptr; }
    }

    // Refine the nDPI verdict using the operator-supplied mapping table:
    // a TLS flow with SNI api2.cursor.sh becomes "Cursor" instead of "TLS",
    // a DNS query for teams.live.com becomes "Microsoft Teams", etc. We push
    // the original wire protocol into master_protocol so it isn't lost.
    void apply_mapping_override(Flow& f) {
        AppMappings::Match m;
        bool matched = false;

        // 1. Hostname/URL — highest priority; always applied when SNI/DNS was captured.
        for (const std::string& host : f.hostnames) {
            if (mappings_.lookup_by_hostname(host, m)) { matched = true; break; }
        }

        // 2. Exact IP — explicit operator entry, applied regardless of nDPI verdict.
        if (!matched) {
            if (mappings_.lookup_by_ip(f.dst_ip, m)) matched = true;
            else if (mappings_.lookup_by_ip(f.src_ip, m)) matched = true;
        }

        // 3. CIDR — only when the application is still completely unidentified.
        //    This prevents broad cloud-provider CIDRs (AWS, Azure, GCP) from
        //    overriding specific services like PostHog or Cursor that happen to
        //    be hosted on those platforms but should be identified by hostname.
        //    Protocols like TLS/QUIC/HTTP that nDPI has partially identified are
        //    excluded; truly unknown UDP/TCP flows still get CIDR attribution.
        if (!matched && f.ip_version == 4 &&
            (f.application.empty() || f.application == "Unknown")) {
            uint32_t dst_n, src_n;
            std::memcpy(&dst_n, f.dst_ip_bytes, 4);
            std::memcpy(&src_n, f.src_ip_bytes, 4);
            const uint32_t dst_h = ntohl(dst_n);
            const uint32_t src_h = ntohl(src_n);
            if (mappings_.lookup_by_cidr(dst_h, m)) matched = true;
            else if (mappings_.lookup_by_cidr(src_h, m)) matched = true;
        }
        if (!matched) return;
        // Don't redundantly override if the mapping already agrees with nDPI.
        if (f.application == m.application) {
            if (!m.category.empty()) f.app_category = m.category;
            return;
        }
        if (f.master_protocol.empty() &&
            !f.application.empty() && f.application != "Unknown") {
            f.master_protocol = f.application;
        }
        f.application = m.application;
        if (!m.category.empty()) f.app_category = m.category;
    }

    void assign_ipdr_key(const Flow& f, uint64_t flow_id, uint64_t now_us) {
        if (f.application.empty() || f.application == "Unknown") return;
        const std::string lk = f.src_ip + "|" + f.dst_ip + "|" +
                               std::to_string(f.dst_port) + "|" + f.application;
        auto it = ipdr_keys_.find(lk);
        uint64_t key_id = 0;
        if (it != ipdr_keys_.end()) {
            db_.ipdr_update(it->second.id, f);
            it->second.last_seen_us = now_us; // use sweep time, not packet time
            key_id = it->second.id;
        } else {
            const uint64_t epoch_s = f.start_time_us / 1000000ULL;
            const std::string ks = std::to_string(epoch_s) + "_" + f.src_ip + "_" +
                                   f.dst_ip + "_" + std::to_string(f.dst_port) + "_" +
                                   f.application;
            key_id = db_.ipdr_create(f, ks);
            if (key_id > 0) ipdr_keys_[lk] = {key_id, ks, now_us};
        }
        if (key_id) db_.ipdr_link_flow(flow_id, key_id);
    }

    void evict_oldest() {
        auto oldest = flows_.begin();
        for (auto it = flows_.begin(); it != flows_.end(); ++it) {
            if (it->second->last_packet_time_us < oldest->second->last_packet_time_us)
                oldest = it;
        }
        const uint64_t now_us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        finalize_and_persist(*oldest->second, now_us);
        flows_.erase(oldest);
    }

    static std::string port_to_app(uint8_t proto, uint16_t dport) {
        if (proto == 6 /*TCP*/) {
            switch (dport) {
                case 20: case 21: return "FTP";
                case 22: return "SSH";
                case 23: return "Telnet";
                case 25: return "SMTP";
                case 80: return "HTTP";
                case 110: return "POP3";
                case 143: return "IMAP";
                case 443: return "HTTPS";
                case 465: return "SMTPS";
                case 587: return "SMTP";
                case 993: return "IMAPS";
                case 995: return "POP3S";
                case 3389: return "RDP";
                case 5900: return "VNC";
                case 8080: return "HTTP_Proxy";
                case 179: return "BGP";
            }
        } else if (proto == 17 /*UDP*/) {
            switch (dport) {
                case 53: return "DNS";
                case 67: case 68: return "DHCP";
                case 123: return "NTP";
                case 161: case 162: return "SNMP";
                case 443: return "QUIC";
            }
        } else if (proto == 1) {
            return "ICMP";
        }
        return {};
    }
};

// ============================================================================
// Message reader
// ============================================================================
class MessageReader {
public:
    explicit MessageReader(int fd) : fd_(fd) { buf_.reserve(64 * 1024); }

    enum class Status { Ok, Eof, Disconnect };

    // Reads one complete message into `body`. Returns Eof when the sender
    // sent the zero-length sentinel; Disconnect on socket close/error.
    Status next(std::vector<uint8_t>& body) {
        while (true) {
            if (buf_.size() >= sizeof(uint32_t)) {
                uint32_t body_len = 0;
                std::memcpy(&body_len, buf_.data(), sizeof(uint32_t));
                if (body_len == 0) {
                    consume(sizeof(uint32_t));
                    return Status::Eof;
                }
                if (body_len > 16 * 1024 * 1024) {
                    return Status::Disconnect;  // sanity guard
                }
                if (buf_.size() >= sizeof(uint32_t) + body_len) {
                    body.assign(buf_.begin() + sizeof(uint32_t),
                                buf_.begin() + sizeof(uint32_t) + body_len);
                    consume(sizeof(uint32_t) + body_len);
                    return Status::Ok;
                }
            }
            if (!read_more()) return Status::Disconnect;
        }
    }

private:
    int fd_;
    std::vector<uint8_t> buf_;

    void consume(size_t n) {
        buf_.erase(buf_.begin(), buf_.begin() + n);
    }

    bool read_more() {
        uint8_t chunk[16 * 1024];
        ssize_t n = ::recv(fd_, chunk, sizeof(chunk), 0);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) return true;
            return false;
        }
        buf_.insert(buf_.end(), chunk, chunk + n);
        return true;
    }
};

// ============================================================================
// Server
// ============================================================================
static std::atomic<bool> g_stop{false};

static void on_signal(int /*sig*/) { g_stop.store(true); }

// ---------------------------------------------------------------------------
// Live capture (libpcap) — used when --interface is set instead of the
// unix-socket producer. Mirrors pcap_processor's link-layer parsing so we
// hand FlowTracker the same PacketMessage + L3-snapshot it normally gets.
// ---------------------------------------------------------------------------
// Little-endian 16-bit decode (no alignment requirement).
static inline uint16_t le16(const u_char* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

// Parse an 802.11 data frame (starting at the Frame Control field) and return
// the offset of the IPv4 payload within the frame, or 0 if not IPv4/encrypted.
// base is added to the returned value so callers get an absolute packet offset.
static size_t wifi_l3_offset(const u_char* dot11, size_t len, size_t base) {
    if (len < 24) return 0;  // minimum 802.11 data frame is 24 bytes

    const uint16_t fc   = le16(dot11);
    const uint8_t  type = (fc >> 2) & 0x3;
    const uint8_t  sub  = (fc >> 4) & 0xF;

    // Only process data frames (type == 2). Skip management (0) and control (1).
    if (type != 2) return 0;
    // Skip null/CF-null frames that carry no payload (subtype 4,5,12,13).
    if (sub == 4 || sub == 5 || sub == 12 || sub == 13) return 0;
    // Protected (WEP/TKIP/CCMP) unicast frames cannot be decrypted here.
    if ((fc >> 14) & 1) return 0;

    const bool to_ds   = (fc >> 8) & 1;
    const bool from_ds = (fc >> 9) & 1;
    const bool qos     = (sub & 0x8) != 0;
    const bool order   = (fc >> 15) & 1;

    // 802.11 MAC header size:
    //   FC(2) + Duration(2) + Addr1-3(18) + SeqCtrl(2) = 24 baseline
    //   + Addr4(6) if WDS (ToDS && FromDS)
    //   + QoS-Ctrl(2) if QoS subtype
    //   + HT-Ctrl(4) if QoS && Order bit set
    size_t hdr = 24;
    if (to_ds && from_ds) hdr += 6;
    if (qos)              hdr += 2;
    if (qos && order)     hdr += 4;

    // Need 8 bytes of LLC/SNAP after the MAC header.
    if (len < hdr + 8) return 0;

    // RFC 1042 LLC/SNAP encapsulation: AA AA 03 00 00 00 <EtherType>
    const u_char* llc = dot11 + hdr;
    if (llc[0] != 0xAA || llc[1] != 0xAA || llc[2] != 0x03) return 0;
    if (llc[3] != 0x00 || llc[4] != 0x00 || llc[5] != 0x00) return 0;
    const uint16_t etype = (static_cast<uint16_t>(llc[6]) << 8) | llc[7];
    if (etype != ETHERTYPE_IP && etype != ETHERTYPE_IPV6) return 0;

    return base + hdr + 8;
}

static size_t live_l3_offset(int link_type, const u_char* packet, size_t caplen) {
    if (link_type == DLT_EN10MB) {
        if (caplen < sizeof(ether_header)) return 0;
        const ether_header* eth = reinterpret_cast<const ether_header*>(packet);
        uint16_t etype = ntohs(eth->ether_type);
        size_t off = sizeof(ether_header);
        while (etype == 0x8100 || etype == 0x88a8) {
            if (caplen < off + 4) return 0;
            etype = ntohs(*reinterpret_cast<const uint16_t*>(packet + off + 2));
            off += 4;
        }
        return (etype == ETHERTYPE_IP || etype == ETHERTYPE_IPV6) ? off : 0;
    }
    if (link_type == DLT_RAW) return 0;
    if (link_type == DLT_LINUX_SLL) {
        if (caplen < 16) return 0;
        uint16_t etype = ntohs(*reinterpret_cast<const uint16_t*>(packet + 14));
        return (etype == ETHERTYPE_IP || etype == ETHERTYPE_IPV6) ? 16 : 0;
    }
    if (link_type == DLT_LINUX_SLL2) {
        if (caplen < 20) return 0;
        uint16_t etype = ntohs(*reinterpret_cast<const uint16_t*>(packet));
        return (etype == ETHERTYPE_IP || etype == ETHERTYPE_IPV6) ? 20 : 0;
    }
    if (link_type == DLT_NULL || link_type == DLT_LOOP) {
        if (caplen < 4) return 0;
        uint32_t family = *reinterpret_cast<const uint32_t*>(packet);
        // AF_INET=2; AF_INET6=10 (Linux), 28 (FreeBSD), 30 (macOS)
        if (family == 2 || family == 10 || family == 28 || family == 30) return 4;
        return 0;
    }
    // Raw 802.11 frames (no radiotap header).
    if (link_type == DLT_IEEE802_11) {
        return wifi_l3_offset(packet, caplen, 0);
    }
    // 802.11 with Radiotap header (most common monitor-mode link type).
    if (link_type == DLT_IEEE802_11_RADIO) {
        if (caplen < 4) return 0;
        // Radiotap header: version(1) pad(1) length(2 LE) ...
        const uint16_t rtap_len = le16(packet + 2);
        if (caplen < rtap_len) return 0;
        return wifi_l3_offset(packet + rtap_len, caplen - rtap_len, rtap_len);
    }
    if (caplen >= sizeof(ether_header)) {
        const ether_header* eth = reinterpret_cast<const ether_header*>(packet);
        uint16_t et = ntohs(eth->ether_type);
        return (et == ETHERTYPE_IP || et == ETHERTYPE_IPV6) ? sizeof(ether_header) : 0;
    }
    return 0;
}

// Parse a libpcap-captured frame into the same layout the unix-socket path
// receives. Handles both IPv4 and IPv6. Returns false on unsupported frames.
static bool live_parse_packet(int link_type, const u_char* packet, uint32_t caplen,
                              uint64_t timestamp_us, size_t max_payload,
                              PacketMessage& out, const uint8_t*& payload_out) {
    size_t off = live_l3_offset(link_type, packet, caplen);
    if (off == 0 && link_type != DLT_RAW) return false;
    if (caplen < off + 1) return false;

    const uint8_t ip_ver = (packet[off] >> 4) & 0x0F;
    out = PacketMessage{};
    out.timestamp_us = timestamp_us;

    const uint8_t* l4 = nullptr;
    size_t l4_avail = 0;

    if (ip_ver == 4) {
        if (caplen < off + sizeof(ip)) return false;
        const ip* iph = reinterpret_cast<const ip*>(packet + off);
        const size_t ip_hl = static_cast<size_t>(iph->ip_hl) * 4;
        if (ip_hl < 20 || caplen < off + ip_hl) return false;

        std::memset(out.src_ip, 0, 16);
        std::memset(out.dst_ip, 0, 16);
        std::memcpy(out.src_ip, &iph->ip_src.s_addr, 4);
        std::memcpy(out.dst_ip, &iph->ip_dst.s_addr, 4);
        out.protocol   = iph->ip_p;
        out.ip_version = 4;
        out.packet_len = ntohs(iph->ip_len);
        l4             = packet + off + ip_hl;
        l4_avail       = caplen - (off + ip_hl);

    } else if (ip_ver == 6) {
        if (caplen < off + 40) return false;
        const ip6_hdr* ip6h = reinterpret_cast<const ip6_hdr*>(packet + off);

        std::memcpy(out.src_ip, &ip6h->ip6_src, 16);
        std::memcpy(out.dst_ip, &ip6h->ip6_dst, 16);
        out.ip_version = 6;
        out.packet_len = static_cast<uint16_t>(40 + ntohs(ip6h->ip6_plen));

        uint8_t next_hdr = ip6h->ip6_nxt;
        size_t ext_off   = off + 40;
        while (next_hdr == 0 || next_hdr == 43 || next_hdr == 60) {
            if (caplen < ext_off + 2) return false;
            const uint8_t* ext = packet + ext_off;
            next_hdr  = ext[0];
            ext_off  += (static_cast<size_t>(ext[1]) + 1) * 8;
            if (ext_off > caplen) return false;
        }
        if (next_hdr == 44 || next_hdr == 59) return false;

        out.protocol = next_hdr;
        l4           = (ext_off < caplen) ? packet + ext_off : nullptr;
        l4_avail     = (ext_off < caplen) ? caplen - ext_off : 0;

    } else {
        return false;
    }

    if (out.protocol == IPPROTO_TCP && l4 && l4_avail >= sizeof(tcphdr)) {
        const tcphdr* th = reinterpret_cast<const tcphdr*>(l4);
        out.src_port = ntohs(th->th_sport);
        out.dst_port = ntohs(th->th_dport);
    } else if (out.protocol == IPPROTO_UDP && l4 && l4_avail >= sizeof(udphdr)) {
        const udphdr* uh = reinterpret_cast<const udphdr*>(l4);
        out.src_port = ntohs(uh->uh_sport);
        out.dst_port = ntohs(uh->uh_dport);
    }

    payload_out = packet + off;
    const size_t snap = caplen - off;
    out.payload_len = static_cast<uint16_t>(snap < max_payload ? snap : max_payload);
    return true;
}

static int run_live_capture(const Config& cfg, FlowTracker& tracker, FlowDB& db) {
    char errbuf[PCAP_ERRBUF_SIZE];
    pcap_t* pcap = nullptr;

    if (cfg.rfmon) {
        // Monitor mode: captures raw 802.11 frames from all stations on the
        // channel, not just frames addressed to this adapter.  Requires a
        // capable WiFi driver and root.  Open/unencrypted frames are fully
        // parseable; WPA2/WPA3 unicast frames arrive encrypted and are
        // silently skipped (the Protected Frame bit causes wifi_l3_offset to
        // return 0).  For full visibility on encrypted networks, deploy on
        // the gateway instead.
        pcap = pcap_create(cfg.interface.c_str(), errbuf);
        if (!pcap) {
            std::fprintf(stderr, "pcap_create(%s) failed: %s\n",
                         cfg.interface.c_str(), errbuf);
            return 1;
        }
        pcap_set_snaplen(pcap, 65535);
        pcap_set_promisc(pcap, 0);   // rfmon supersedes promiscuous
        pcap_set_rfmon(pcap, 1);
        pcap_set_timeout(pcap, 1000);
        const int act_err = pcap_activate(pcap);
        if (act_err < 0) {
            // Adapter does not support monitor mode — fall back to standard
            // promiscuous mode so the monitor keeps running.
            std::fprintf(stderr,
                "[flow_monitor] WARNING: monitor mode (rfmon) not supported on %s (%s)\n"
                "  Falling back to standard promiscuous mode.\n\n"
                "  WHY OTHER DEVICES SHOW ONLY NETBIOS:\n"
                "  On a WPA2 WiFi network each device encrypts its unicast traffic\n"
                "  with a unique per-client key (PTK).  Your adapter cannot decrypt\n"
                "  those frames, so nDPI only receives cipher-text and cannot identify\n"
                "  the application.  Broadcast frames (e.g. NetBIOS UDP 137) use the\n"
                "  shared group key (GTK) which every device on the network holds,\n"
                "  so those ARE visible.\n\n"
                "  TO SEE ALL DEVICES' TRAFFIC:\n"
                "  1. Deploy flow_monitor on the router/gateway — traffic arrives\n"
                "     there in clear-text after the AP decrypts it.\n"
                "  2. Use a USB WiFi adapter that supports monitor mode (e.g. Alfa\n"
                "     AWUS036ACH) on an open/unencrypted network.\n"
                "  3. Run flow_monitor on the Linux router itself (OpenWrt, etc.).\n",
                cfg.interface.c_str(), pcap_geterr(pcap));
            pcap_close(pcap);
            pcap = nullptr;
            // Fall through to standard promiscuous open below.
        } else {
            if (act_err > 0) {
                std::fprintf(stderr, "[flow_monitor] rfmon warning: %s\n",
                             pcap_geterr(pcap));
            }
            std::fprintf(stderr,
                "[flow_monitor] monitor mode (rfmon) active on %s\n"
                "  Capturing all 802.11 frames on the channel.\n"
                "  WPA2/WPA3 unicast frames are encrypted and will be skipped;\n"
                "  works fully on open (unencrypted) WiFi networks.\n",
                cfg.interface.c_str());
        }
    }

    // Open in standard promiscuous mode if rfmon was not requested or fell back.
    if (!pcap) {
        // On WiFi (infrastructure + WPA2): captures your own traffic + broadcasts.
        // Other clients' unicast frames are encrypted with their PTK — invisible.
        pcap = pcap_open_live(cfg.interface.c_str(),
                              /*snaplen*/ 65535,
                              /*promisc*/ 1,
                              /*to_ms*/   1000,
                              errbuf);
        if (!pcap) {
            std::fprintf(stderr, "pcap_open_live(%s) failed: %s\n",
                         cfg.interface.c_str(), errbuf);
            return 1;
        }
    }

    if (!cfg.bpf_filter.empty()) {
        bpf_program prog{};
        if (pcap_compile(pcap, &prog, cfg.bpf_filter.c_str(), 1, PCAP_NETMASK_UNKNOWN) < 0) {
            std::fprintf(stderr, "pcap_compile failed: %s\n", pcap_geterr(pcap));
            pcap_close(pcap);
            return 1;
        }
        if (pcap_setfilter(pcap, &prog) < 0) {
            std::fprintf(stderr, "pcap_setfilter failed: %s\n", pcap_geterr(pcap));
            pcap_freecode(&prog);
            pcap_close(pcap);
            return 1;
        }
        pcap_freecode(&prog);
    }

    const int link_type = pcap_datalink(pcap);

    if (cfg.verbose) {
        std::fprintf(stderr,
            "[flow_monitor] live capture on %s, link_type=%d, filter=%s\n",
            cfg.interface.c_str(), link_type,
            cfg.bpf_filter.empty() ? "(none)" : cfg.bpf_filter.c_str());
    }

    db.begin_tx();
    uint64_t total = 0;
    bool tx_dirty = false;   // true when the open transaction has pending writes
    while (!g_stop.load()) {
        pcap_pkthdr* header = nullptr;
        const u_char* packet = nullptr;
        int rv = pcap_next_ex(pcap, &header, &packet);
        if (rv == 0) {
            // Read timeout on idle link. Only commit/restart if there are
            // actual pending writes — avoids spamming a remote DB (e.g.
            // Railway) with 1 empty COMMIT + START TRANSACTION per second.
            if (tx_dirty) {
                db.commit_tx();
                db.begin_tx();
                tx_dirty = false;
            }
            continue;
        }
        if (rv < 0) {
            std::fprintf(stderr, "pcap_next_ex error: %s\n", pcap_geterr(pcap));
            break;
        }

        const uint64_t ts_us = static_cast<uint64_t>(header->ts.tv_sec) * 1000000ULL
                             + static_cast<uint64_t>(header->ts.tv_usec);

        PacketMessage msg;
        const uint8_t* payload = nullptr;
        if (!live_parse_packet(link_type, packet, header->caplen,
                               ts_us, DEFAULT_MAX_PAYLOAD, msg, payload)) {
            continue;
        }
        tracker.on_packet(msg, payload);
        tx_dirty = true;

        if (++total % 5000 == 0) {
            db.commit_tx();
            db.begin_tx();
            tx_dirty = false;
        }
    }
    db.commit_tx();

    db.begin_tx();
    tracker.flush_all();
    db.commit_tx();

    pcap_close(pcap);
    return 0;
}

static int create_listen_socket(const std::string& path) {
    ::unlink(path.c_str());
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path.size() >= sizeof(addr.sun_path)) {
        ::close(fd);
        errno = ENAMETOOLONG;
        return -1;
    }
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }
    ::chmod(path.c_str(), 0666);
    if (::listen(fd, 8) < 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

static void usage(const char* prog) {
    std::fprintf(stderr,
        "Usage: %s [options]\n"
        "  --interface <name>         live capture on this NIC (e.g. eth0). When set,\n"
        "                             the unix-socket producer is skipped.\n"
        "  --bpf-filter <expr>        optional BPF filter for live capture\n"
        "  --socket <path>            listen path for pcap_processor (default %s)\n"
        "  --config <path>            optional JSON config\n"
        "  --mysql-host <host>        MySQL host (default 127.0.0.1)\n"
        "  --mysql-port <port>        MySQL port (default 3306)\n"
        "  --mysql-user <user>        MySQL user (default root)\n"
        "  --mysql-pass <pass>        MySQL password (default empty)\n"
        "  --mysql-db <name>          MySQL database (default flowmon, auto-created)\n"
        "  --mysql-socket <path>      MySQL unix socket (overrides host/port)\n"
        "  --flow-timeout <seconds>   inactive flow expiry (default 60)\n"
        "  --sync-interval <seconds>  active-flow UPSERT cadence (default 30, 0=off)\n"
        "  --ndpi-max-packets <n>     packets to feed nDPI (default 16)\n"
        "  --max-flows <n>            cap on active flows (default 100000)\n"
        "  --rfmon                    enable 802.11 monitor mode on the interface.\n"
        "                             Captures all frames on the channel (other clients\n"
        "                             included). Requires root + adapter support.\n"
        "                             WPA2/WPA3 unicast frames are encrypted and skipped;\n"
        "                             works fully on open (unencrypted) WiFi networks.\n"
        "  --verbose                  extra logging on stderr\n",
        prog, DEFAULT_SOCKET_PATH);
}

enum {
    OPT_MYSQL_HOST = 1000,
    OPT_MYSQL_PORT,
    OPT_MYSQL_USER,
    OPT_MYSQL_PASS,
    OPT_MYSQL_DB,
    OPT_MYSQL_SOCKET,
    OPT_BPF_FILTER,
    OPT_SYNC_INTERVAL,
    OPT_RFMON,
};

int main(int argc, char** argv) {
    Config cfg;
    std::string config_path;

    static const option opts[] = {
        {"interface",         required_argument, nullptr, 'i'},
        {"bpf-filter",        required_argument, nullptr, OPT_BPF_FILTER},
        {"socket",            required_argument, nullptr, 's'},
        {"config",            required_argument, nullptr, 'c'},
        {"mysql-host",        required_argument, nullptr, OPT_MYSQL_HOST},
        {"mysql-port",        required_argument, nullptr, OPT_MYSQL_PORT},
        {"mysql-user",        required_argument, nullptr, OPT_MYSQL_USER},
        {"mysql-pass",        required_argument, nullptr, OPT_MYSQL_PASS},
        {"mysql-db",          required_argument, nullptr, OPT_MYSQL_DB},
        {"mysql-socket",      required_argument, nullptr, OPT_MYSQL_SOCKET},
        {"flow-timeout",      required_argument, nullptr, 't'},
        {"sync-interval",     required_argument, nullptr, OPT_SYNC_INTERVAL},
        {"ndpi-max-packets",  required_argument, nullptr, 'n'},
        {"max-flows",         required_argument, nullptr, 'm'},
        {"rfmon",             no_argument,       nullptr, OPT_RFMON},
        {"verbose",           no_argument,       nullptr, 'v'},
        {"help",              no_argument,       nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };
    int c;
    while ((c = getopt_long(argc, argv, "i:s:c:t:n:m:vh", opts, nullptr)) != -1) {
        switch (c) {
            case 'i': cfg.interface = optarg; break;
            case OPT_BPF_FILTER:   cfg.bpf_filter = optarg; break;
            case 's': cfg.socket_path = optarg; break;
            case 'c': config_path = optarg; break;
            case OPT_MYSQL_HOST:   cfg.mysql_host = optarg; break;
            case OPT_MYSQL_PORT:   cfg.mysql_port = std::atoi(optarg); break;
            case OPT_MYSQL_USER:   cfg.mysql_user = optarg; break;
            case OPT_MYSQL_PASS:   cfg.mysql_pass = optarg; break;
            case OPT_MYSQL_DB:     cfg.mysql_db   = optarg; break;
            case OPT_MYSQL_SOCKET: cfg.mysql_socket = optarg; break;
            case 't': cfg.flow_timeout_seconds = std::atoi(optarg); break;
            case OPT_SYNC_INTERVAL: cfg.sync_interval_seconds = std::atoi(optarg); break;
            case 'n': cfg.ndpi_max_packets = std::atoi(optarg); break;
            case 'm': cfg.max_active_flows = static_cast<size_t>(std::atoi(optarg)); break;
            case OPT_RFMON:        cfg.rfmon   = true;  break;
            case 'v': cfg.verbose = true; break;
            case 'h': usage(argv[0]); return 0;
            default:  usage(argv[0]); return 1;
        }
    }

    if (!config_path.empty() && !load_config(config_path, cfg)) {
        std::fprintf(stderr, "warning: failed to read config %s\n", config_path.c_str());
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);

    NdpiContext ndpi;
    if (!ndpi.init()) {
        std::fprintf(stderr, "ndpi_init_detection_module failed\n");
        return 1;
    }

    FlowDB db;
    if (!db.open(cfg)) {
        ndpi.cleanup();
        return 1;
    }

    AppMappings mappings;
    if (!db.load_app_mappings(mappings)) {
        std::fprintf(stderr,
            "warning: load_app_mappings failed; flows will not be re-mapped\n");
    }
    if (cfg.verbose) {
        std::fprintf(stderr, "[flow_monitor] loaded %zu application mappings\n",
                     mappings.size());
    }

    FlowTracker tracker(ndpi, db, mappings, cfg);

    // Live-capture mode: tap the NIC directly via libpcap. The unix-socket
    // listener is bypassed entirely.
    if (!cfg.interface.empty()) {
        if (cfg.verbose) {
            const char* via = cfg.mysql_socket.empty() ? "tcp" : "socket";
            std::fprintf(stderr,
                "[flow_monitor] ready: live=%s mysql=%s@%s:%d/%s (%s) timeout=%ds sync=%ds\n",
                cfg.interface.c_str(),
                cfg.mysql_user.c_str(), cfg.mysql_host.c_str(),
                cfg.mysql_port, cfg.mysql_db.c_str(), via,
                cfg.flow_timeout_seconds, cfg.sync_interval_seconds);
        }
        int rc = run_live_capture(cfg, tracker, db);
        if (cfg.verbose) std::fprintf(stderr, "[flow_monitor] shutting down\n");
        db.close();
        ndpi.cleanup();
        return rc;
    }

    int listen_fd = create_listen_socket(cfg.socket_path);
    if (listen_fd < 0) {
        std::fprintf(stderr, "listen on %s failed: %s\n",
                     cfg.socket_path.c_str(), std::strerror(errno));
        db.close();
        ndpi.cleanup();
        return 1;
    }

    if (cfg.verbose) {
        const char* via = cfg.mysql_socket.empty() ? "tcp" : "socket";
        std::fprintf(stderr,
            "[flow_monitor] ready: socket=%s mysql=%s@%s:%d/%s (%s) timeout=%ds sync=%ds\n",
            cfg.socket_path.c_str(),
            cfg.mysql_user.c_str(), cfg.mysql_host.c_str(),
            cfg.mysql_port, cfg.mysql_db.c_str(), via,
            cfg.flow_timeout_seconds, cfg.sync_interval_seconds);
    }

    while (!g_stop.load()) {
        // Poll-style accept so we can react to signals.
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(listen_fd, &rfds);
        timeval tv{1, 0};
        int sel = ::select(listen_fd + 1, &rfds, nullptr, nullptr, &tv);
        if (sel < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (sel == 0) continue;

        int client = ::accept(listen_fd, nullptr, nullptr);
        if (client < 0) {
            if (errno == EINTR) continue;
            std::perror("accept");
            continue;
        }
        if (cfg.verbose) std::fprintf(stderr, "[flow_monitor] client connected\n");

        MessageReader reader(client);
        std::vector<uint8_t> body;
        size_t batched = 0;
        db.begin_tx();
        while (!g_stop.load()) {
            auto st = reader.next(body);
            if (st == MessageReader::Status::Eof ||
                st == MessageReader::Status::Disconnect) break;

            if (body.size() < sizeof(PacketMessage)) continue;
            PacketMessage hdr;
            std::memcpy(&hdr, body.data(), sizeof(PacketMessage));
            const uint8_t* payload = body.data() + sizeof(PacketMessage);
            const size_t avail = body.size() - sizeof(PacketMessage);
            const size_t plen = hdr.payload_len <= avail ? hdr.payload_len : avail;
            hdr.payload_len = static_cast<uint16_t>(plen);

            tracker.on_packet(hdr, payload);

            if (++batched % 5000 == 0) {
                db.commit_tx();
                db.begin_tx();
            }
        }
        // Sync everything still in memory before letting the client drop —
        // otherwise a short pcap whose flows never expired would persist
        // nothing to MySQL.
        tracker.sync_active();
        db.commit_tx();
        ::close(client);
        if (cfg.verbose) std::fprintf(stderr, "[flow_monitor] client disconnected\n");
    }

    if (cfg.verbose) std::fprintf(stderr, "[flow_monitor] shutting down\n");
    db.begin_tx();
    tracker.flush_all();
    db.commit_tx();
    ::close(listen_fd);
    ::unlink(cfg.socket_path.c_str());
    db.close();
    ndpi.cleanup();
    return 0;
}

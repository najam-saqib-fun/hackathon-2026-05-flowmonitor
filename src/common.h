// common.h — shared definitions between pcap_processor and flow_monitor.
//
// The wire format on the Unix socket is a sequence of length-prefixed
// messages. Each message is laid out as:
//
//   [uint32_t msg_len]            // body length in bytes (little-endian, host)
//   [PacketMessage header]        // fixed 24-byte packed header
//   [payload of payload_len bytes] // raw L3 (IP+L4+app data) snapshot
//
// A msg_len of 0 is the EOF sentinel — the sender writes one before closing.

#pragma once

#include <cstddef>
#include <cstdint>

namespace flowmon {

constexpr const char* DEFAULT_SOCKET_PATH = "/tmp/flow_monitor.sock";
constexpr size_t DEFAULT_MAX_PAYLOAD = 1024;
constexpr size_t MAX_BATCH_BYTES = 256 * 1024;

#pragma pack(push, 1)
struct PacketMessage {
    uint64_t timestamp_us;   // microseconds since epoch
    uint32_t src_ip;         // network byte order, IPv4
    uint32_t dst_ip;         // network byte order, IPv4
    uint16_t src_port;       // host byte order
    uint16_t dst_port;       // host byte order
    uint8_t  protocol;       // IPPROTO_TCP / UDP / ICMP / ...
    uint16_t packet_len;     // IP total length (full original size)
    uint16_t payload_len;    // bytes captured in this message
};
#pragma pack(pop)

static_assert(sizeof(PacketMessage) == 8 + 4 + 4 + 2 + 2 + 1 + 2 + 2,
              "PacketMessage layout mismatch");

}  // namespace flowmon

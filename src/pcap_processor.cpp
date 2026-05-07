// pcap_processor.cpp
//
// Reads packets from a .pcap file, parses Ethernet+IPv4 headers, and streams
// every TCP/UDP/ICMP/etc. packet to flow_monitor over a Unix socket. The
// payload sent is the raw L3 snapshot (IP header + L4 + app data) so that
// flow_monitor can run nDPI directly on it.

#include "common.h"

#include <pcap/pcap.h>

#include <arpa/inet.h>
#include <getopt.h>
#include <netinet/if_ether.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/ip6.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef ETHERTYPE_IPV6
#define ETHERTYPE_IPV6 0x86DD
#endif

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using namespace flowmon;

namespace {

bool g_verbose = false;

int connect_unix_socket(const std::string& path) {
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

    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

bool send_all(int fd, const void* buf, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(buf);
    size_t left = len;
    while (left > 0) {
        ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            return false;
        }
        p += n;
        left -= static_cast<size_t>(n);
    }
    return true;
}

// Walk past the link layer to find the start of the IP header (v4 or v6).
// Returns the offset on success, or 0 on failure / unsupported encapsulation.
size_t l3_offset(int link_type, const u_char* packet, size_t caplen) {
    if (link_type == DLT_EN10MB) {
        if (caplen < sizeof(ether_header)) return 0;
        const ether_header* eth = reinterpret_cast<const ether_header*>(packet);
        uint16_t etype = ntohs(eth->ether_type);
        size_t off = sizeof(ether_header);
        // Strip 802.1Q / 802.1ad VLAN tags.
        while (etype == 0x8100 || etype == 0x88a8) {
            if (caplen < off + 4) return 0;
            etype = ntohs(*reinterpret_cast<const uint16_t*>(packet + off + 2));
            off += 4;
        }
        return (etype == ETHERTYPE_IP || etype == ETHERTYPE_IPV6) ? off : 0;
    }
    if (link_type == DLT_RAW) return 0;  // pure IP, no L2 to strip
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
    // Unknown: best-effort assume Ethernet.
    if (caplen >= sizeof(ether_header)) {
        const ether_header* eth = reinterpret_cast<const ether_header*>(packet);
        uint16_t et = ntohs(eth->ether_type);
        return (et == ETHERTYPE_IP || et == ETHERTYPE_IPV6) ? sizeof(ether_header) : 0;
    }
    return 0;
}

void usage(const char* prog) {
    std::fprintf(stderr,
        "Usage: %s --input <pcap_file> [options]\n"
        "  --input <file>         pcap file to read (required)\n"
        "  --socket <path>        flow_monitor socket (default %s)\n"
        "  --batch-size <n>       flush every N packets (default 100)\n"
        "  --max-payload <n>      bytes captured per packet (default %zu)\n"
        "  --filter <bpf>         BPF filter expression\n"
        "  --verbose              extra logging on stderr\n",
        prog, DEFAULT_SOCKET_PATH, DEFAULT_MAX_PAYLOAD);
}

}  // namespace

int main(int argc, char** argv) {
    std::string input;
    std::string socket_path = DEFAULT_SOCKET_PATH;
    std::string bpf_filter;
    size_t max_payload = DEFAULT_MAX_PAYLOAD;
    int batch_size = 100;

    static const option long_opts[] = {
        {"input",       required_argument, nullptr, 'i'},
        {"socket",      required_argument, nullptr, 's'},
        {"batch-size",  required_argument, nullptr, 'b'},
        {"max-payload", required_argument, nullptr, 'm'},
        {"filter",      required_argument, nullptr, 'f'},
        {"verbose",     no_argument,       nullptr, 'v'},
        {"help",        no_argument,       nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };

    int c;
    while ((c = getopt_long(argc, argv, "i:s:b:m:f:vh", long_opts, nullptr)) != -1) {
        switch (c) {
            case 'i': input = optarg; break;
            case 's': socket_path = optarg; break;
            case 'b': batch_size = std::atoi(optarg); break;
            case 'm': max_payload = static_cast<size_t>(std::atoi(optarg)); break;
            case 'f': bpf_filter = optarg; break;
            case 'v': g_verbose = true; break;
            case 'h': usage(argv[0]); return 0;
            default:  usage(argv[0]); return 1;
        }
    }

    if (input.empty()) { usage(argv[0]); return 1; }
    if (batch_size <= 0) batch_size = 1;
    if (max_payload > 65000) max_payload = 65000;

    char errbuf[PCAP_ERRBUF_SIZE];
    pcap_t* pcap = pcap_open_offline(input.c_str(), errbuf);
    if (!pcap) {
        std::fprintf(stderr, "pcap_open_offline(%s) failed: %s\n",
                     input.c_str(), errbuf);
        return 1;
    }

    const int link_type = pcap_datalink(pcap);

    if (!bpf_filter.empty()) {
        bpf_program prog{};
        if (pcap_compile(pcap, &prog, bpf_filter.c_str(), 1, PCAP_NETMASK_UNKNOWN) < 0) {
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

    int sock = connect_unix_socket(socket_path);
    if (sock < 0) {
        std::fprintf(stderr, "connect to %s failed: %s\n",
                     socket_path.c_str(), std::strerror(errno));
        pcap_close(pcap);
        return 1;
    }

    if (g_verbose) {
        std::fprintf(stderr, "[pcap_processor] reading %s, link_type=%d, sending to %s\n",
                     input.c_str(), link_type, socket_path.c_str());
    }

    std::vector<uint8_t> buf;
    buf.reserve(MAX_BATCH_BYTES + 4096);

    pcap_pkthdr* header = nullptr;
    const u_char* packet = nullptr;
    uint64_t total_read = 0;
    uint64_t total_sent = 0;
    int rv = 0;

    auto flush = [&]() -> bool {
        if (buf.empty()) return true;
        bool ok = send_all(sock, buf.data(), buf.size());
        buf.clear();
        return ok;
    };

    while ((rv = pcap_next_ex(pcap, &header, &packet)) >= 0) {
        if (rv == 0) continue;  // timeout (unused on offline reads)
        ++total_read;

        size_t off = l3_offset(link_type, packet, header->caplen);
        if (off == 0 && link_type != DLT_RAW) continue;
        if (header->caplen < off + 1) continue;

        const uint8_t ip_ver = (packet[off] >> 4) & 0x0F;

        PacketMessage msg{};
        msg.timestamp_us = static_cast<uint64_t>(header->ts.tv_sec) * 1000000ULL
                         + static_cast<uint64_t>(header->ts.tv_usec);

        const uint8_t* l4 = nullptr;
        size_t l4_avail = 0;

        if (ip_ver == 4) {
            if (header->caplen < off + sizeof(ip)) continue;
            const ip* iph = reinterpret_cast<const ip*>(packet + off);
            const size_t ip_hl = static_cast<size_t>(iph->ip_hl) * 4;
            if (ip_hl < 20 || header->caplen < off + ip_hl) continue;

            std::memset(msg.src_ip, 0, 16);
            std::memset(msg.dst_ip, 0, 16);
            std::memcpy(msg.src_ip, &iph->ip_src.s_addr, 4);
            std::memcpy(msg.dst_ip, &iph->ip_dst.s_addr, 4);
            msg.protocol   = iph->ip_p;
            msg.ip_version = 4;
            msg.packet_len = ntohs(iph->ip_len);
            l4             = packet + off + ip_hl;
            l4_avail       = header->caplen - (off + ip_hl);

        } else if (ip_ver == 6) {
            if (header->caplen < off + 40) continue;  // IPv6 fixed header = 40 bytes
            const ip6_hdr* ip6h = reinterpret_cast<const ip6_hdr*>(packet + off);

            std::memcpy(msg.src_ip, &ip6h->ip6_src, 16);
            std::memcpy(msg.dst_ip, &ip6h->ip6_dst, 16);
            msg.ip_version = 6;
            msg.packet_len = static_cast<uint16_t>(40 + ntohs(ip6h->ip6_plen));

            // Walk extension headers to reach the transport layer.
            uint8_t next_hdr = ip6h->ip6_nxt;
            size_t ext_off   = off + 40;
            bool valid = true;
            while (next_hdr == 0   /*HopByHop*/  ||
                   next_hdr == 43  /*Routing*/    ||
                   next_hdr == 60  /*Destination*/) {
                if (header->caplen < ext_off + 2) { valid = false; break; }
                const uint8_t* ext = packet + ext_off;
                next_hdr  = ext[0];
                ext_off  += (static_cast<size_t>(ext[1]) + 1) * 8;
                if (ext_off > header->caplen) { valid = false; break; }
            }
            // Skip fragment headers (reassembly not supported) and no-next-header.
            if (!valid || next_hdr == 44 || next_hdr == 59) continue;

            msg.protocol = next_hdr;
            l4           = (ext_off < header->caplen) ? packet + ext_off : nullptr;
            l4_avail     = (ext_off < header->caplen) ? header->caplen - ext_off : 0;

        } else {
            continue;  // not IPv4 or IPv6
        }

        // Extract ports from TCP/UDP header.
        if (msg.protocol == IPPROTO_TCP) {
            if (!l4 || l4_avail < sizeof(tcphdr)) continue;
            const tcphdr* th = reinterpret_cast<const tcphdr*>(l4);
            msg.src_port = ntohs(th->th_sport);
            msg.dst_port = ntohs(th->th_dport);
        } else if (msg.protocol == IPPROTO_UDP) {
            if (!l4 || l4_avail < sizeof(udphdr)) continue;
            const udphdr* uh = reinterpret_cast<const udphdr*>(l4);
            msg.src_port = ntohs(uh->uh_sport);
            msg.dst_port = ntohs(uh->uh_dport);
        }

        // Snapshot the L3 packet (IP header + everything after) for nDPI.
        const uint8_t* snap = packet + off;
        size_t snap_avail = header->caplen - off;
        size_t to_send = snap_avail < max_payload ? snap_avail : max_payload;
        msg.payload_len = static_cast<uint16_t>(to_send);

        const uint32_t body_len = static_cast<uint32_t>(sizeof(PacketMessage)) +
                                  static_cast<uint32_t>(msg.payload_len);
        const size_t prev = buf.size();
        buf.resize(prev + sizeof(uint32_t) + body_len);
        std::memcpy(buf.data() + prev, &body_len, sizeof(uint32_t));
        std::memcpy(buf.data() + prev + sizeof(uint32_t), &msg, sizeof(PacketMessage));
        if (msg.payload_len > 0) {
            std::memcpy(buf.data() + prev + sizeof(uint32_t) + sizeof(PacketMessage),
                        snap, msg.payload_len);
        }
        ++total_sent;

        if (static_cast<int>(total_sent % batch_size) == 0 ||
            buf.size() >= MAX_BATCH_BYTES) {
            if (!flush()) {
                std::fprintf(stderr, "send to flow_monitor failed: %s\n",
                             std::strerror(errno));
                break;
            }
        }
    }

    flush();

    // EOF sentinel: zero-length body tells the receiver we are done.
    uint32_t eof = 0;
    send_all(sock, &eof, sizeof(eof));

    if (g_verbose || rv == -1) {
        if (rv == -1) {
            std::fprintf(stderr, "pcap_next_ex error: %s\n", pcap_geterr(pcap));
        }
        std::fprintf(stderr, "[pcap_processor] read=%llu sent=%llu\n",
                     (unsigned long long)total_read, (unsigned long long)total_sent);
    }

    ::close(sock);
    pcap_close(pcap);
    return 0;
}

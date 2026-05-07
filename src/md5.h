// Compact public-domain MD5 implementation. Used to compute the canonical
// flow_hash so both directions of a bidirectional conversation collapse to
// the same row in the flows table.

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace md5_impl {

inline uint32_t rotl(uint32_t x, int n) {
    return (x << n) | (x >> (32 - n));
}

inline void md5_process(uint32_t state[4], const uint8_t block[64]) {
    static const uint32_t T[64] = {
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    };
    static const int S[64] = {
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    };

    uint32_t M[16];
    for (int i = 0; i < 16; i++) {
        M[i] = (uint32_t)block[i * 4]
             | ((uint32_t)block[i * 4 + 1] << 8)
             | ((uint32_t)block[i * 4 + 2] << 16)
             | ((uint32_t)block[i * 4 + 3] << 24);
    }

    uint32_t A = state[0], B = state[1], C = state[2], D = state[3];
    for (int i = 0; i < 64; i++) {
        uint32_t F, g;
        if (i < 16)      { F = (B & C) | (~B & D);     g = i; }
        else if (i < 32) { F = (D & B) | (~D & C);     g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D;              g = (3 * i + 5) % 16; }
        else             { F = C ^ (B | ~D);           g = (7 * i) % 16; }

        uint32_t tmp = D;
        D = C;
        C = B;
        B = B + rotl(A + F + T[i] + M[g], S[i]);
        A = tmp;
    }
    state[0] += A;
    state[1] += B;
    state[2] += C;
    state[3] += D;
}

inline std::string md5_hex(const std::string& input) {
    uint32_t state[4] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476};
    const uint64_t bit_len = (uint64_t)input.size() * 8;

    size_t i = 0;
    while (i + 64 <= input.size()) {
        md5_process(state, reinterpret_cast<const uint8_t*>(input.data() + i));
        i += 64;
    }

    uint8_t block[64];
    size_t rem = input.size() - i;
    std::memcpy(block, input.data() + i, rem);
    block[rem] = 0x80;
    if (rem >= 56) {
        std::memset(block + rem + 1, 0, 64 - rem - 1);
        md5_process(state, block);
        std::memset(block, 0, 56);
    } else {
        std::memset(block + rem + 1, 0, 56 - rem - 1);
    }
    for (int j = 0; j < 8; j++) {
        block[56 + j] = (uint8_t)(bit_len >> (8 * j));
    }
    md5_process(state, block);

    char hex[33];
    for (int j = 0; j < 4; j++) {
        for (int k = 0; k < 4; k++) {
            uint8_t b = (state[j] >> (k * 8)) & 0xff;
            std::snprintf(hex + (j * 8) + (k * 2), 3, "%02x", b);
        }
    }
    return std::string(hex, 32);
}

}  // namespace md5_impl

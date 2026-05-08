# PM Brief — FlowMon

## Problem

ISPs and network operators have no affordable, self-hosted tool to monitor traffic in real time, classify applications, and produce regulatory-grade IPDR session records. Existing solutions are either costly proprietary appliances or raw packet dumps with no analytics layer.

## Solution

FlowMon is a three-tier open-source ISP traffic analytics platform built for the single-operator use case: one box capturing traffic, one dashboard showing it in real time.

## Target User

ISP network operations center (NOC) operator managing a small-to-medium network (up to 10,000 subscribers). Needs to know: who is generating traffic, what applications, how much, and has regulatory obligation to keep session records (IPDR).

## Job-to-be-done

"As a NOC operator, I need to see which subscribers are consuming the most bandwidth right now, identify rogue applications, and retrieve session records for any subscriber within minutes — without standing up an expensive commercial appliance."

## Must-Have Features

| Feature | Acceptance criteria |
|---------|---------------------|
| Live packet capture | Dashboard updates within 15 s of traffic appearing on the wire |
| Application detection | >80% of flows classified by app name (not just "TCP/UDP") |
| Top Talkers + Top Apps | Visible from the dashboard homepage without additional query |
| IPDR records | Session records queryable by subscriber IP, with first/last seen |
| Subscriber attribution | IP → customer name visible everywhere a flow appears |

## Nice-to-Have (not shipped)

- GeoIP map visualization
- Multi-node distributed capture
- IPv6 CIDR application mapping

## Delivered

All 5 must-have features shipped. Additionally: alerting (threshold rules), domain history (TLS SNI/DNS), app mapping editor (hostname/CIDR overrides), capture policy allowlist, and user management.

## Tech Stack

C++17 / libpcap / nDPI 5.x / MySQL 8 / Node.js 20 / Express / WebSocket / Angular 17 / Angular Material / Chart.js

## Out of Scope

- Encrypted WPA2 unicast decryption
- Multi-node distributed capture
- IPv6 CIDR application mapping

// ═══════════════════════════════════════════════════════════
// LUMINA — Log Generator Module
// Sample data generator (platform-themed: K3s GitOps stack on Proxmox).
// ES module — imported by dashboard.js (Vite/Astro bundles it).
//
// Public API:
//   createLogs(count?)       → pure: returns a sorted array of sample logs
//   generateLogEntry(ts?)    → one sample log entry
//   weightedRandom(arr, ws)  → weighted random pick helper
//   LogGenerator             → namespace { sources, hosts, levels,
//                                          levelWeights, messages, ... }
// ═══════════════════════════════════════════════════════════

// Sample data generators (platform-themed: K3s GitOps stack on Proxmox)
const sources = [
  "vector",
  "kube-apiserver",
  "k3s",
  "etcd",
  "flux-operator",
  "istio-proxy",
  "quickwit",
  "garage",
  "haproxy",
  "kubelet",
  "systemd",
  "kernel",
];
const hosts = [
  "k3s-master-1",
  "k3s-master-2",
  "k3s-worker-1",
  "k3s-worker-2",
  "super-node-1",
  "super-node-2",
];
const levels = ["error", "warn", "info", "debug", "critical"];
const levelWeights = [15, 20, 45, 15, 5];

const messages = {
  error: [
    "Quickwit search timed out after 30s on index syslogs",
    "Failed to reconcile GitRepository fleet-infra: upstream error",
    "etcd: failed to commit transaction: timeout",
    "Istio proxy: upstream connect error or disconnect/reset before headers",
    "Vector: component crash — batch send failed (retry 5/5)",
    "kubelet: Container runtime network not ready",
    "Garage: shard quorum lost for bucket logs (1/3 peers)",
    "HAProxy: backend k3s-apiserver down (L7Check fail)",
    "cert-manager: order finalization failed: no available CA",
    "Failed to flush log batch to Quickwit: connection refused",
  ],
  warn: [
    "Node k3s-worker-1: memory pressure at 87% of allocatable",
    "Certificate expires in 7 days for frontend.codezap.win",
    "Flux: reconciliation drift detected in namespace lumina",
    "Quickwit: index ingestion lag at 12s for syslogs",
    "Garage: replica sync behind on super-node-2 (45s)",
    "Istio: mTLS handshake retries elevated on gateway",
    "Vector: source file descriptor usage at 80%",
    "etcd: raft election in progress on k3s-master-2",
    "HAProxy: session limit reached (95/100) on LB vserver",
    "kubelet: PLEG is not healthy: taking longer than 3m0s",
  ],
  info: [
    "Flux reconciled namespace lumina (0 drifts) in 2.4s",
    "Vector batch flushed: 12,482 events → Quickwit syslogs",
    "Quickwit: index syslogs refreshed, 4.2M docs",
    "HAProxy: backend k3s-apiserver marked UP (L7Check OK)",
    "Garage: replication completed for bucket logs (3/3 shards)",
    "cert-manager: certificate frontend.codezap.win renewed",
    "Istio: config pushed to 6 proxies (revision 1.24)",
    "K3s: node k3s-worker-2 heartbeat OK (kubelet 1.31)",
    "GitHub Actions: image ghcr.io/traipoap/gitops-backend:latest published",
    "Flux: HelmRelease prometheus upgraded to 1.42.0",
  ],
  debug: [
    "Lucene query: message:(k3s AND warning) time range 15m",
    "Quickwit: scroll cursor advanced to index_timestamp=1758012345678",
    "Vector: transform pipeline `mask-pdpa` applied to 1,024 events",
    "etcd: heartbeat from k3s-master-1 (round 48211)",
    "Istio: route matched → HTTPRoute lumina/backend → svc backend-svc:8080",
    "Garage: GET bucket=logs key=export/any_20260525.csv (200 OK)",
    "HAProxy: frontend vLan16 sessions=142 rate=12/s",
    "kubelet: syncing kubernetes.io/nfs volume for pod quickwit-indexer-0",
    "Flux: source reconciliation completed in 380ms",
    "Kernel: NFS: server 10.10.16.5 ready; waiting for first request",
  ],
  critical: [
    "CLUSTER QUORUM LOST: only 1/3 etcd members reachable",
    "K3s control plane unreachable from all workers for 60s",
    "Vector pipeline halted: disk full on /var/log (99% used)",
    "Quickwit: segment corruption detected in index syslogs",
    "Garage: data loss risk — 2/3 shards offline for bucket logs",
    "HAProxy: no healthy backends for vserver k3s-apiserver",
    "Kernel: Out of memory: killed process 1421 (vector)",
    "Flux: reconciliation failing for 30 min — all namespaces",
    "Istio: sidecar crashloop detected in 4 pods (lumina)",
    "NFS: server 10.10.16.5 not responding — mounts stale",
  ],
};

function weightedRandom(arr, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    random -= weights[i];
    if (random <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

function generateLogEntry(timestamp) {
  const level = weightedRandom(levels, levelWeights);
  const source = sources[Math.floor(Math.random() * sources.length)];
  const host = hosts[Math.floor(Math.random() * hosts.length)];
  const messageTemplates = messages[level];
  let message =
    messageTemplates[Math.floor(Math.random() * messageTemplates.length)];
  if (message.includes("{pid}")) {
    message = message.replace("{pid}", Math.floor(Math.random() * 30000));
  }
  return {
    id: Math.random().toString(36).substr(2, 9),
    timestamp: timestamp || new Date(Date.now() - Math.random() * 86400000 * 7),
    level: level,
    source: source,
    host: host,
    message: message,
    pid: Math.floor(Math.random() * 30000) + 1000,
    extras: {}
  };
}

// Pure: สร้าง batch ของ sample logs (ไม่แตะ state ของ dashboard)
// dashboard.js นำผลไป set เข้า allLogs เอง
export function createLogs(count = 500) {
  const now = Date.now();
  const logs = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(now - Math.random() * 86400000 * 7);
    logs.push(generateLogEntry(ts));
  }
  logs.sort((a, b) => b.timestamp - a.timestamp);
  return logs;
}

// Namespace สำหรับ reference จากไฟล์อื่น
export const LogGenerator = {
  sources,
  hosts,
  levels,
  levelWeights,
  messages,
  weightedRandom,
  generateLogEntry,
  createLogs,
};

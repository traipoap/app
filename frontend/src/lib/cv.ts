// ── Shared CV model, presets and A4 sheet renderer ─────────────────
// Used by both the builder (/resume) and the public preview (/cv) so
// the published profile and the builder always render identically.

export interface ExperienceItem {
    id: string;
    role: string;
    company: string;
    location: string;
    start: string;
    end: string;
    current: boolean;
    description: string;
}
export interface ProjectItem {
    id: string;
    name: string;
    link: string;
    description: string;
}
export interface EducationItem {
    id: string;
    degree: string;
    school: string;
    start: string;
    end: string;
}
export interface LanguageItem {
    id: string;
    name: string;
    level: string;
}
export interface CertificationItem {
    id: string;
    name: string;
    issuer: string;
    year: string;
}
export interface CVData {
    name: string;
    title: string;
    email: string;
    phone: string;
    location: string;
    website: string;
    github: string;
    linkedin: string;
    summary: string;
    experience: ExperienceItem[];
    projects: ProjectItem[];
    education: EducationItem[];
    skills: string[];
    languages: LanguageItem[];
    certifications: CertificationItem[];
    accent: string;
    photo: string | null;
    template: "classic" | "modern" | "ats";
    breaks: Record<string, boolean>;
}

export const SHEET_W = (210 / 25.4) * 96; // A4 width @96dpi ≈ 793.7
export const PAGE_CAP = (269 / 25.4) * 96 - 4; // A4 content height (297 − 28mm) − 4px slack

export const uid = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : "id-" + Math.random().toString(36).slice(2, 10);

// ── DOM helpers (all user content is escaped via text nodes) ──
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string | boolean | number | null> | null,
    ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (
                value === null ||
                value === false ||
                value === undefined
            )
                continue;
            if (key === "class") node.className = String(value);
            else if (value === true) node.setAttribute(key, "");
            else node.setAttribute(key, String(value));
        }
    }
    for (const child of children) {
        if (child === null || child === undefined) continue;
        node.append(
            child instanceof Node
                ? child
                : document.createTextNode(String(child)),
        );
    }
    return node;
}

export function bullets(text: string): string[] {
    return text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
}

export function entryDate(start: string, end: string, current?: boolean) {
    const to = current ? "Present" : end.trim();
    if (start.trim() && to) return `${start.trim()} — ${to}`;
    return start.trim() || to || "";
}

// ── Preview rendering ──────────────────────────────────────────
type Sec = {
    col: "main" | "side";
    title: string;
    kind: "single" | "entry" | "pair";
    nodes: Node[];
};

type Unit = {
    node: Node;
    section: string;
    heading: boolean;
    kind: "heading" | "single" | "entry" | "pair";
};

type Measured = Unit & { h: number; t: number; b: number };

// Greedy A4 pagination with the same keep-together rules as print:
// headings stay with their first item, entries/pairs are not split.
// `used` always includes the last box's trailing margin (collapsed
// against the next), matching how the browser sizes a page — this
// keeps the final line away from the printed page edge.
function paginate(
    ms: Measured[],
    cap: number,
    firstOffset = 0,
    topMargin = 0,
    forceBreak: (title: string) => boolean = () => false,
): Measured[][] {
    const pages: Measured[][] = [];
    let cur: Measured[] = [];
    let used = firstOffset;
    let lastB = topMargin;
    const cost = (m: Measured, pending: number) =>
        Math.max(pending, m.t) - pending + m.h + m.b;
    const add = (m: Measured) => {
        used += cost(m, lastB);
        cur.push(m);
        lastB = m.b;
    };
    const flush = () => {
        if (cur.length) pages.push(cur);
        cur = [];
        used = 0;
        lastB = 0;
    };
    let i = 0;
    while (i < ms.length) {
        const m = ms[i];
        // An explicit "start on new page" wins over packing heuristics.
        if (m.heading && cur.length > 0 && forceBreak(m.section))
            flush();
        const pair = m.heading && i + 1 < ms.length ? ms[i + 1] : null;
        const unitCost = cost(m, lastB) + (pair ? cost(pair, m.b) : 0);
        // Only force a page break if the pair actually fits a fresh page.
        const pairFitsPage =
            !pair ||
            m.t + m.h + Math.max(m.b, pair.t) + pair.h + pair.b <=
                cap + 0.5;
        if (cur.length && unitCost > cap - used && pairFitsPage)
            flush();
        add(m);
        if (pair) {
            add(pair);
            i++;
        }
        i++;
    }
    flush();
    return pages;
}

// Height of a page's units (same collapse model as paginate).
function pageCost(ms: Measured[]): number {
    let used = 0;
    let lastB = 0;
    for (const m of ms) {
        used += Math.max(lastB, m.t) - lastB + m.h + m.b;
        lastB = m.b;
    }
    return used;
}

// A final page carrying only a sliver of content reads as an
// accident — pull it back when the previous page genuinely has room.
function rescueOrphan(
    pages: Measured[][],
    cap: number,
    forceBreak: (title: string) => boolean,
): Measured[][] {
    if (pages.length < 2) return pages;
    const last = pages[pages.length - 1];
    const prev = pages[pages.length - 2];
    if (!last || !prev) return pages;
    // Respect an explicit "start on new page" on that section.
    const first = last[0];
    const forced = first && first.heading && forceBreak(first.section);
    if (
        !forced &&
        last.length <= 4 &&
        pageCost(prev) + pageCost(last) <= cap + 0.5
    ) {
        prev.push(...last);
        pages.pop();
    }
    return pages;
}

// A section split across pages so that only its last item lands on
// the new page reads as an accident — move the whole section there
// (heading + items stay together).
function pullSplitSection(pages: Measured[][]): Measured[][] {
    for (let p = pages.length - 1; p >= 1; p--) {
        const page = pages[p];
        const prev = pages[p - 1];
        if (!page.length || !prev.length) continue;
        const first = page[0];
        if (first.heading) continue; // section starts fresh — fine
        if (page.length !== 1) continue; // more content follows
        const idx = prev.findIndex((u) => u.section === first.section);
        if (idx === -1) continue;
        // A split section is always the last one on the previous page.
        const moved = prev.splice(idx);
        page.unshift(...moved);
    }
    return pages.filter((page) => page.length > 0);
}

// Group a page's units back into <section> blocks; a section that
// continues onto a new page simply re-opens without its heading.
function renderSectioned(ms: Measured[]): Node[] {
    const out: Node[] = [];
    let sec: HTMLElement | null = null;
    let curTitle = "";
    let run: Measured[] = [];
    const flushRun = () => {
        const target = sec;
        if (!run.length || !target) {
            run = [];
            return;
        }
        const nodes = run.map((m) => m.node);
        if (run[0].kind === "entry")
            target.append(el("div", null, ...nodes));
        else if (run[0].kind === "pair")
            target.append(
                el("div", { class: "cv-pairgrid" }, ...nodes),
            );
        else nodes.forEach((n) => target.append(n));
        run = [];
    };
    for (const m of ms) {
        if (m.section !== curTitle || !sec) {
            flushRun();
            sec = el("section", { class: "cv-section" });
            out.push(sec);
            curTitle = m.section;
        }
        const target = sec as HTMLElement;
        if (m.heading) {
            target.append(m.node);
            continue;
        }
        if (m.kind === "single") {
            flushRun();
            target.append(m.node);
            continue;
        }
        if (run.length && run[0].kind !== m.kind) flushRun();
        run.push(m);
    }
    flushRun();
    return out;
}

/**
 * Render a full A4-paginated sheet into `sheet`.
 * The caller is responsible for any scaling/fitting afterwards.
 */
export function renderSheetInto(sheet: HTMLElement, data: CVData): void {
    sheet.style.setProperty("--cv-accent", data.accent);
    sheet.classList.toggle("ats", data.template === "ats");
    let headNode: HTMLElement | null = null;
    const secs: Array<Sec> = [];

    const contact = [
        data.email,
        data.phone,
        data.location,
        data.website,
        data.github,
        data.linkedin,
    ].filter(Boolean);

    const hasIdentity = Boolean(
        data.name || data.title || data.summary,
    );
    const showPhoto = Boolean(data.photo) && data.template !== "ats";

    if (hasIdentity) {
        const head = el("header", {
            class: showPhoto
                ? "cv-sheet-head has-photo"
                : "cv-sheet-head",
        });
        const headText = el("div", { class: "cv-head-text" });
        headText.append(el("div", { class: "cv-headbar" }));
        if (showPhoto)
            head.append(
                el("img", {
                    class: "cv-photo",
                    src: data.photo,
                    alt: "",
                }),
            );
        if (data.name)
            headText.append(el("h1", { class: "cv-name" }, data.name));
        if (data.title)
            headText.append(
                el("p", { class: "cv-roletitle" }, data.title),
            );
        if (contact.length) {
            const line = el("p", { class: "cv-contact" });
            contact.forEach((c, i) => {
                if (i > 0)
                    line.append(
                        el(
                            "span",
                            { class: "sep", "aria-hidden": true },
                            "•",
                        ),
                    );
                line.append(document.createTextNode(String(c)));
            });
            headText.append(line);
        }
        head.append(headText);
        headNode = head;
    }

    if (data.summary.trim())
        secs.push({
            col: "main",
            title: "Profile",
            kind: "single",
            nodes: [el("p", { class: "cv-para" }, data.summary.trim())],
        });

    const expItems = data.experience.filter(
        (e) =>
            e.role ||
            e.company ||
            e.location ||
            e.start ||
            e.end ||
            bullets(e.description).length,
    );
    if (expItems.length) {
        const list: Node[] = [];
        for (const e of expItems) {
            const item = el("div", { class: "cv-entry" });
            const headLine = el("div", { class: "cv-entry-head" });
            headLine.append(
                el(
                    "span",
                    { class: "cv-entry-main" },
                    e.role &&
                        el(
                            "strong",
                            { class: "cv-entry-role" },
                            e.role,
                        ),
                    e.company &&
                        el(
                            "span",
                            { class: "cv-entry-company" },
                            (e.role ? " · " : "") + e.company,
                        ),
                    e.location &&
                        el(
                            "span",
                            { class: "cv-entry-loc" },
                            " — " + e.location,
                        ),
                ),
                entryDate(e.start, e.end, e.current) &&
                    el(
                        "span",
                        { class: "cv-entry-date" },
                        entryDate(e.start, e.end, e.current),
                    ),
            );
            item.append(headLine);
            const lines = bullets(e.description);
            if (lines.length) {
                const ul = el("ul", { class: "cv-bullets" });
                for (const l of lines) ul.append(el("li", null, l));
                item.append(ul);
            }
            list.push(item);
        }
        secs.push({
            col: "main",
            title: "Experience",
            kind: "entry",
            nodes: list,
        });
    }

    const projItems = data.projects.filter(
        (p) => p.name || p.link || p.description,
    );
    if (projItems.length) {
        const list: Node[] = [];
        for (const p of projItems) {
            const item = el("div", { class: "cv-entry" });
            item.append(
                el(
                    "span",
                    { class: "cv-entry-main" },
                    p.name &&
                        el(
                            "strong",
                            { class: "cv-entry-role" },
                            p.name,
                        ),
                    p.link &&
                        el(
                            "span",
                            { class: "cv-entry-company" },
                            (p.name ? " · " : "") + p.link,
                        ),
                ),
            );
            if (p.description.trim()) {
                const pLines = bullets(p.description);
                if (pLines.length > 1) {
                    const ul = el("ul", { class: "cv-bullets" });
                    for (const l of pLines)
                        ul.append(el("li", null, l));
                    item.append(ul);
                } else {
                    item.append(
                        el(
                            "p",
                            { class: "cv-entry-desc" },
                            p.description.trim(),
                        ),
                    );
                }
            }
            list.push(item);
        }
        secs.push({
            col: "main",
            title: "Projects",
            kind: "entry",
            nodes: list,
        });
    }

    const eduItems = data.education.filter(
        (e) => e.degree || e.school || e.start || e.end,
    );
    if (eduItems.length) {
        const list: Node[] = [];
        for (const e of eduItems) {
            list.push(
                el(
                    "div",
                    { class: "cv-entry" },
                    el(
                        "div",
                        { class: "cv-entry-head" },
                        el(
                            "span",
                            { class: "cv-entry-main" },
                            e.degree &&
                                el(
                                    "strong",
                                    { class: "cv-entry-role" },
                                    e.degree,
                                ),
                            e.school &&
                                el(
                                    "span",
                                    { class: "cv-entry-company" },
                                    (e.degree ? " · " : "") + e.school,
                                ),
                        ),
                        entryDate(e.start, e.end) &&
                            el(
                                "span",
                                { class: "cv-entry-date" },
                                entryDate(e.start, e.end),
                            ),
                    ),
                ),
            );
        }
        secs.push({
            col: "side",
            title: "Education",
            kind: "entry",
            nodes: list,
        });
    }

    if (data.skills.length) {
        const chips = el("div", { class: "cv-chips" });
        for (const s of data.skills)
            chips.append(el("span", { class: "cv-chip" }, s));
        secs.push({
            col: "side",
            title: "Skills",
            kind: "single",
            nodes: [chips],
        });
    }

    const langItems = data.languages.filter((l) => l.name || l.level);
    if (langItems.length) {
        const pairs: Node[] = [];
        for (const l of langItems)
            pairs.push(
                el(
                    "div",
                    { class: "cv-pair" },
                    el(
                        "span",
                        { class: "cv-pair-name" },
                        l.name || "—",
                    ),
                    l.level
                        ? el("span", { class: "cv-pair-meta" }, l.level)
                        : null,
                ),
            );
        secs.push({
            col: "side",
            title: "Languages",
            kind: "pair",
            nodes: pairs,
        });
    }

    const certItems = data.certifications.filter(
        (c) => c.name || c.issuer || c.year,
    );
    if (certItems.length) {
        const pairs: Node[] = [];
        for (const c of certItems)
            pairs.push(
                el(
                    "div",
                    { class: "cv-pair" },
                    el(
                        "span",
                        { class: "cv-pair-name" },
                        c.name || "—",
                    ),
                    [c.issuer, c.year].filter(Boolean).length
                        ? el(
                              "span",
                              { class: "cv-pair-meta" },
                              [c.issuer, c.year]
                                  .filter(Boolean)
                                  .join(" · "),
                          )
                        : null,
                ),
            );
        secs.push({
            col: "side",
            title: "Certifications",
            kind: "pair",
            nodes: pairs,
        });
    }

    // ── Flows ──
    if (data.template === "ats") {
        // Canonical order ATS parsers expect.
        const order: Record<string, number> = {
            Profile: 0,
            Experience: 1,
            Projects: 2,
            Education: 3,
            Skills: 4,
            Languages: 5,
            Certifications: 6,
        };
        secs.sort(
            (a, b) => (order[a.title] ?? 9) - (order[b.title] ?? 9),
        );
    }
    const mainSecs = secs.filter((s) => s.col === "main");
    const sideSecs = secs.filter((s) => s.col === "side");
    const modern = data.template === "modern" && sideSecs.length > 0;

    if (!headNode && secs.length === 0) {
        const page = el("div", { class: "cv-a4" });
        page.append(el("span", { class: "cv-a4-num" }, "1"));
        page.append(
            el(
                "div",
                { class: "cv-sheet-empty" },
                el("strong", null, "Your CV preview"),
                el(
                    "p",
                    null,
                    "Start filling the form on the left — or press “Load my data” to pre-fill your profile.",
                ),
            ),
        );
        sheet.replaceChildren(page);
        return;
    }

    const mkUnits = (s: Sec): Unit[] => [
        {
            node: el("h3", null, s.title),
            section: s.title,
            heading: true,
            kind: "heading",
        },
        ...s.nodes.map((n): Unit => ({
            node: n,
            section: s.title,
            heading: false,
            kind: s.kind,
        })),
    ];
    const mainUnits = mainSecs.flatMap(mkUnits);
    const sideUnits = sideSecs.flatMap(mkUnits);
    // Single-column templates flow every section in canonical order.
    const singleUnits = modern ? mainUnits : secs.flatMap(mkUnits);

    // ── Measure units at their final width (exact final structure) ──
    const measureBox = el("div", { class: "cv-measure" });
    if (headNode) measureBox.append(headNode);
    const attach = (box: Element, ss: Sec[], units: Unit[]) => {
        let i = 0;
        for (const s of ss) {
            const sec = el("section", { class: "cv-section" });
            sec.append(units[i].node); // heading
            if (s.kind === "pair") {
                const grid = el("div", { class: "cv-pairgrid" });
                for (const n of s.nodes) grid.append(n);
                sec.append(grid);
            } else {
                for (const n of s.nodes) sec.append(n);
            }
            box.append(sec);
            i += 1 + s.nodes.length;
        }
    };
    if (modern) {
        const cols = el("div", { class: "cv-cols" });
        const mainC = el("div", { class: "cv-col-main" });
        const sideC = el("div", { class: "cv-col-side" });
        attach(mainC, mainSecs, mainUnits);
        attach(sideC, sideSecs, sideUnits);
        cols.append(mainC, sideC);
        measureBox.append(cols);
    } else {
        attach(measureBox, secs, singleUnits);
    }
    sheet.append(measureBox);

    const toMeasured = (units: Unit[]): Measured[] =>
        units.map((u) => {
            const node = u.node as HTMLElement;
            const cs = getComputedStyle(node);
            return {
                ...u,
                h: node.offsetHeight,
                t: u.heading
                    ? parseFloat(
                          getComputedStyle(node.parentElement ?? node)
                              .marginTop,
                      ) || 0
                    : parseFloat(cs.marginTop) || 0,
                b: parseFloat(cs.marginBottom) || 0,
            };
        });

    const mainMs = toMeasured(singleUnits);
    const sideMs = modern ? toMeasured(sideUnits) : [];
    const headMs = headNode
        ? (() => {
              const n = headNode as HTMLElement;
              const cs = getComputedStyle(n);
              return {
                  h: n.offsetHeight,
                  t: parseFloat(cs.marginTop) || 0,
                  b: parseFloat(cs.marginBottom) || 0,
              };
          })()
        : null;
    measureBox.remove();

    // ── Split into A4 pages and render one card per page ──
    const wantsBreak = (t: string) => data.breaks[t] === true;
    const firstOffset = headMs ? headMs.t + headMs.h + headMs.b : 0;
    const topMargin = headMs ? headMs.b : 0;
    const mainPages = pullSplitSection(
        rescueOrphan(
            paginate(
                mainMs,
                PAGE_CAP,
                firstOffset,
                topMargin,
                wantsBreak,
            ),
            PAGE_CAP,
            wantsBreak,
        ),
    );
    const sidePages = pullSplitSection(
        rescueOrphan(
            paginate(
                sideMs,
                PAGE_CAP,
                firstOffset,
                topMargin,
                wantsBreak,
            ),
            PAGE_CAP,
            wantsBreak,
        ),
    );
    const total = Math.max(mainPages.length, sidePages.length, 1);

    const pageEls: HTMLElement[] = [];
    for (let k = 0; k < total; k++) {
        const page = el("div", { class: "cv-a4" });
        page.append(el("span", { class: "cv-a4-num" }, String(k + 1)));
        if (k === 0 && headNode) page.append(headNode);
        if (modern) {
            const cols = el("div", { class: "cv-cols" });
            const mainC = el("div", { class: "cv-col-main" });
            mainC.append(...renderSectioned(mainPages[k] ?? []));
            const sideC = el("div", { class: "cv-col-side" });
            sideC.append(...renderSectioned(sidePages[k] ?? []));
            cols.append(mainC, sideC);
            page.append(cols);
        } else {
            page.append(...renderSectioned(mainPages[k] ?? []));
        }
        pageEls.push(page);
    }
    sheet.replaceChildren(...pageEls);
}

// ── Preset: Traipoap Hunthong ("Load my data") — EN / TH versions ──
export function presetShared(): Pick<
    CVData,
    | "email"
    | "phone"
    | "website"
    | "github"
    | "linkedin"
    | "skills"
    | "certifications"
    | "accent"
    | "photo"
    | "template"
    | "breaks"
> {
    return {
        email: "traipoap@hotmail.com",
        phone: "+66 80 638 0921",
        website: "app.traipoap.com",
        github: "github.com/traipoap",
        linkedin: "linkedin.com/in/traipoap",
        skills: [
            "Kubernetes / K8s / K3s / etcd / kubectl",
            "Helm / Kustomize / ArgoCD / FluxCD",
            "Istio / Cilium / Kiali / Gateway API",
            "cert-manager / Kyverno / External Secrets Operator",
            "Terraform / Ansible",
            "Proxmox VE / OpenStack",
            "AWS (CloudFront / Lambda / ECR / S3 / IAM / ACM / Secrets Manager) / GHCR / Huawei Cloud Container Engine",
            "GitHub Actions / GitLab / Docker / Docker Compose",
            "Vector / Quickwit / Loki",
            "OpenTelemetry / OTel Collector / Grafana Tempo",
            "Prometheus / Grafana / Zabbix",
            "SLO / error budget / chaos engineering / blameless postmortem",
            "Trivy / Gitleaks / SonarQube",
            "HAProxy / Keepalived",
            "NFS / Garage (S3)",
            "Cloudflare Tunnel / Tailscale",
            "Go / Python / Bash",
            "Investigation / Troubleshooting",
            "Linux / Debian / Ubuntu",
        ],
        certifications: [
            {
                id: uid(),
                name: "CKA — Certified Kubernetes Administrator",
                issuer: "Linux Foundation",
                year: "2026 – 2028",
            },
            {
                id: uid(),
                name: "CKAD — Certified Kubernetes Application Developer",
                issuer: "Linux Foundation",
                year: "2026 – 2028",
            },
        ],
        accent: "#6366f1",
        photo: null,
        template: "classic",
        breaks: {},
    };
}

export function sampleDataEN(): CVData {
    return {
        name: "Traipoap Hunthong",
        title: "DevOps Engineer",
        location: "Nonthaburi, Thailand",
        ...presetShared(),
        summary:
            "Network Administrator (Tier-2) building toward a DevOps Engineer role. CKA & CKAD certified (Linux Foundation). Designed and operate a production stack in a personal lab — a Go/Astro log platform on a 6-node K3s HA cluster with Istio, Argo CD GitOps, and CI/CD security gates — plus a multi-region failover DR site on AWS. Current role applies the same fundamentals: incident response, monitoring pipelines, automation.",
        experience: [
            {
                id: uid(),
                role: "Network Administrator — Tier-2 Support",
                company:
                    "360 Bizmate Co., Ltd. (NT — National Telecom)",
                location: "Nonthaburi",
                start: "Jan 2022",
                end: "",
                current: true,
                description:
                    "Owned Tier-2 incident escalation — root-cause analysis and vendor/team coordination to keep SLAs.\nManage the Zabbix stack end-to-end, including patching against published CVEs — proactive N-S monitoring (Zabbix → Telegram) catches issues E-W alerts miss, reducing MTTR.\nAutomated switch PSU status checks, replacing daily manual inspections.\nBuilt a scheduled hardware lifecycle automation (Google Apps Script): parses CSV license/EOL records, flags expirations, alerts via Telegram.\nExecuted change management (VLAN, load balancer) with configuration backups as a safe baseline.\nResolved IPv6 policy conflicts by disabling unintended auto-configuration and restoring firewall compliance.\nDiagnosed load-balancing failures — root cause: exposing the backend port in the container image — and restored the customer's service.\nTrained Tier-1 staff and prepared monthly operational reports.",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra — K3s Platform on Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "Automated K3s platform: Terraform (VM templates, HCP remote state), Ansible (6 idempotent playbooks, kernel tuning), K3s HA (embedded etcd), Istio ambient, Gateway API, Argo CD GitOps via Helm.\nFrom-scratch provisioning in under an hour: super-node (HAProxy L7, syslog, NFS, S3), 3 control-plane nodes (etcd quorum), 2 workers — repeatable, destroyable via terraform destroy.\nMulti-runtime support: crun as default, youki exposed as a RuntimeClass.\nMonthly chaos drills (node removal) with postmortems keep failure modes known.\n14 ADRs plus deployment and troubleshooting runbooks.",
            },
            {
                id: uid(),
                name: "app — Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "Self-hosted log-search platform in a personal production environment — Go API (JWT, Quickwit, CSV export) and Astro dashboard.\nGitHub Actions CI/CD: Gitleaks secret scan, SonarQube SAST gate, path-filtered builds, Trivy CRITICAL/HIGH scans (SARIF), GHCR publish, Argo CD auto-deploy.",
            },
            {
                id: uid(),
                name: "gitops — ArgoCD GitOps",
                link: "github.com/traipoap/argocd-bootstrap",
                description:
                    "Git as the source of truth — Argo CD reconciles cluster state and corrects configuration drift.\nDeployed Google's microservices-demo (10 services) as Argo CD applications on the Istio cluster — a real multi-service workload for mesh and observability validation.\nExternal Secrets Operator with AWS Secrets Manager — credentials in-cluster, never in Git.\nImage Updater: new image versions → semver tag updates → auto-deploy.\nLimitRange defaults and schema validation for Argo CD Applications.\nObservability with Prometheus and Grafana; logs routed via Otel to Loki.",
            },
            {
                id: uid(),
                name: "aws — Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "Multi-region DR: K3s as the primary CloudFront origin, failing over on 4xx/5xx to a Go/Gin Lambda (ECR) and an S3 static site across ap-southeast-1/7 — app.traipoap.com stays up.\nMonthly origin-failover drills keep the DR path validated.\nTerraform modules for CloudFront, ECR, IAM, S3, ACM + CloudFront Function for clean-URL routing, OAC/SigV4 for private S3.",
            },
        ],
        education: [
            {
                id: uid(),
                degree: "B.Sc. Computer Science",
                school: "Rajamangala University of Technology Phranakorn",
                start: "Aug 2014",
                end: "May 2018",
            },
        ],
        languages: [
            { id: uid(), name: "Thai", level: "Native" },
            {
                id: uid(),
                name: "English",
                level: "Working proficiency",
            },
        ],
    };
}

// ── Preset: same profile, Thai wording ────────────────────────────
export function sampleDataTH(): CVData {
    return {
        name: "ไตรภพ หุ่นทอง",
        title: "DevOps Engineer",
        location: "นนทบุรี, ประเทศไทย",
        ...presetShared(),
        summary:
            "Network Administrator (Tier-2) กำลังขยายความเชี่ยวชาญสู่ DevOps Engineer — ผ่านการรับรอง CKA และ CKAD (Linux Foundation) สร้างระบบใช้งานจริงด้วยตนเอง ทั้งแพลตฟอร์มค้นหา log บน K3s HA (homelab) และระบบ Disaster Recovery ข้าม region บน AWS งานประจำใช้หลัก DevOps ในระบบจริง — เฝ้าระวังเชิงรุก แก้ที่ต้นตอ และ automate งานที่ซ้ำซาก",
        experience: [
            {
                id: uid(),
                role: "Network Administrator (Tier-2)",
                company:
                    "บริษัท 360 Bizmate จำกัด (NT — กสท โทรคมนาคม)",
                location: "นนทบุรี",
                start: "ม.ค. 2022",
                end: "",
                current: true,
                description:
                    "ดูแลเหตุขัดข้องระดับ Tier-2 วิเคราะห์สาเหตุที่แท้จริง และประสานทีมภายใน/หน่วยงานภายนอกให้ปิดงานได้ตาม SLA\nดูแลระบบ Zabbix — เฝ้าระวังเชิงรุกจับปัญหาแฝงฝั่ง North-South ที่ระบบการแจ้งเตือนฝั่ง East-West มองไม่เห็น แจ้งเตือนผ่าน Telegram ช่วยลด MTTR และติดตั้ง patch ตามช่องโหว่ (CVE) ที่ประกาศออกมา\nเขียนสคริปต์ตรวจสอบ PSU status switch อัตโนมัติ แทนการตรวจด้วยมือทุกวัน\nพัฒนาระบบติดตาม Hardware License และ EOL ด้วย Google Apps Script — ประมวลผล CSV ตามเวลาที่กำหนด ตรวจ License ใกล้หมดอายุและอุปกรณ์ใกล้สิ้นสุดการสนับสนุน แจ้งเตือนผ่าน Telegram\nดำเนินการเปลี่ยนแปลงระบบ (change) เช่น VLAN, Load-Balancing พร้อมสำรองค่าการตั้งค่าให้เป็นปัจจุบัน\nแก้ไขความขัดแย้งนโยบาย IPv6 — ปิด auto-configuration ที่ไม่พึงประสงค์ ทำให้ firewall เป็นไปตามข้อกำหนดความปลอดภัย\nชี้ต้นตอปัญหาการกระจายโหลดให้ลูกค้าเห็น — การ expose port backend ใน container image — จนระบบลูกค้าใช้งานได้\nถ่ายทอดความรู้ให้ทีม Tier-1 และจัดทำรายงานประจำเดือน",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra — K3s Platform บน Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "สร้าง K3s platform แบบอัตโนมัติ — Terraform (VM templates, state บน HCP Terraform), Ansible (6 playbooks, kernel tuning), K3s HA (embedded etcd), Istio ambient, Gateway API และ ArgoCD สำหรับ GitOps\nติดตั้งจากศูนย์ได้ภายใน 1 ชั่วโมง — super-node (HAProxy L7, syslog, NFS, S3), control plane 3 โหนด (etcd quorum), worker 3 โหนด สร้างซ้ำ/รื้อด้วย terraform destroy\nรองรับ container runtime หลายตัว — crun เป็นค่าเริ่มต้น, youki เป็น RuntimeClass\nซ้อม chaos drill รายเดือน (เช่น ถอดโหนด) พร้อมจดบันทึกว่าอะไรพัง ซ่อมอย่างไร\nจัดทำ ADR 14 ข้อ คู่มือติดตั้ง และ runbook",
            },
            {
                id: uid(),
                name: "app — Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "พัฒนา log search export platform บน Go API (JWT, Quickwit, CSV export) กับ Astro dashboard \nCI/CD ด้วย GitHub Actions — Gitleaks สแกน secret, SonarQube SAST, build เฉพาะส่วนที่เปลี่ยน, Trivy สแกน CRITICAL/HIGH (SARIF), push GHCR แล้ว ArgoCD deploy อัตโนมัติ",
            },
            {
                id: uid(),
                name: "gitops — ArgoCD GitOps",
                link: "github.com/traipoap/argocd-bootstrap",
                description:
                    "ใช้ Git เป็น source of truth ของคลัสเตอร์ — ArgoCD ซิงก์สถานะต่อเนื่องและแก้ configuration drift อัตโนมัติ\nรัน Google microservices-demo (10 services) เป็น Argo CD Application บนคลัสเตอร์ Istio — workload multi-service จริงสำหรับตรวจสอบ service mesh และ observability\nเชื่อม External Secrets Operator กับ AWS Secrets Manager — credentials เข้าคลัสเตอร์โดยไม่เก็บใน Git\nArgoCD Image Updater — ตรวจ image ใหม่ อัปเดต tag ตาม semver และ deploy อัตโนมัติ\nกำหนด LimitRange defaults และ schema validation สำหรับ ArgoCD Application\nObservability ด้วย Prometheus และ Grafana ส่ง log ผ่าน Otel ไปยัง Loki",
            },
            {
                id: uid(),
                name: "aws — Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "ระบบ DR ข้าม region — K3s เป็น origin หลักของ CloudFront เมื่อได้ 4xx/5xx failover ไปยัง Lambda (Go/Gin บน ECR) และ static build บน S3 ใน ap-southeast-1/7 ให้ app.traipoap.com ทำงานต่อได้\nซ้อม origin failover รายเดือน ให้มั่นใจว่าเส้นทาง DR ใช้งานได้จริง\nTerraform modules สำหรับ CloudFront, ECR, IAM, S3, ACM พร้อม CloudFront Function (clean-URL routing) และ OAC/SigV4 เข้า S3 แบบส่วนตัว",
            },
        ],
        education: [
            {
                id: uid(),
                degree: "วิทยาศาสตรบัณฑิต (วิทยาการคอมพิวเตอร์)",
                school: "มหาวิทยาลัยเทคโนโลยีราชมงคลพระนคร",
                start: "ส.ค. 2014",
                end: "พ.ค. 2018",
            },
        ],
        languages: [
            { id: uid(), name: "ไทย", level: "ภาษาแม่" },
            {
                id: uid(),
                name: "อังกฤษ",
                level: "สื่อสารเพื่อการทำงาน",
            },
        ],
    };
}

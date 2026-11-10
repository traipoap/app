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
            "AWS / ECR / GHCR / Huawei Cloud Container Engine",
            "GitHub Actions / GitLab / Docker / Docker Compose",
            "Vector / Quickwit / Loki",
            "OpenTelemetry / OTel Collector / Grafana Tempo",
            "Prometheus / Grafana / Zabbix",
            "Trivy / Gitleaks / SonarQube",
            "nginx / HAProxy / Keepalived",
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
            "Network Administrator expanding my experience in networking, infrastructure, and cloud computing toward a DevOps Engineer role. Certified as a Kubernetes Administrator (CKA) and Kubernetes Application Developer (CKAD) by the Linux Foundation. Built hands-on projects, including web applications running on a home lab and a disaster recovery (DR) site on AWS. Focused on Kubernetes, CI/CD, GitOps, and infrastructure automation to build reliable systems ready for production workloads.",
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
                    "Resolved Tier-2 network incidents escalated from Tier 1 and coordinated with internal teams and vendors to meet SLAs.\nHandled change and service requests, including VLAN additions and modifications, and maintained accurate configuration backups.\nTrained Tier-1 staff to improve efficiency and prepared monthly reports within the assigned scope.\nReduced mean time to resolution (MTTR) by implementing proactive traffic monitoring with Zabbix, detecting silent failures missed by standard node-down alerts and sending notifications through Telegram.\nAutomated multi-node health checks, reducing daily manual inspections of network devices.\nResolved IPv6 security policy conflicts by disabling unintended IPv6 auto-configuration and restoring firewall compliance.\nDiagnosed load-balancing issues caused by backend port settings and Docker Compose port exposure, helping the customer restore traffic forwarding.\nBuilt a scheduled infrastructure asset monitoring automation using Google Apps Script to parse hardware license and EOL records from CSV files, identify upcoming expirations and lifecycle risks, and deliver automated alerts through Telegram.",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra — K3s Platform on Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "Automated K3s platform provisioning with Terraform (template-based VM cloning, count-driven node scaling, and HCP remote state), Ansible (six idempotent playbooks and kernel tuning), K3s (embedded etcd for high availability), Istio ambient, Gateway API, and Argo CD GitOps deployments with Helm.\nProvisioned the complete platform from scratch in under an hour: a super-node (HAProxy L7 load balancer, syslog relay, NFS, and S3), three K3s control-plane nodes (etcd quorum), and two workers. The setup is repeatable and can be torn down with terraform destroy.\nAdded multi-runtime container support, using crun as the default runtime and exposing youki as a Kubernetes RuntimeClass.\nDocumented 14 architecture decisions, along with deployment and troubleshooting runbooks.",
            },
            {
                id: uid(),
                name: "app — Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "Built and operate a self-hosted log search platform in a personal production environment, with a Go API (JWT authentication, Quickwit search, and CSV export) and an Astro dashboard.\nImplemented CI/CD with GitHub Actions: Gitleaks secret scanning and a SonarQube SAST gate, path-filtered image builds, Trivy scans for CRITICAL and HIGH vulnerabilities (SARIF), publishing to GHCR, and automatic deployments through Argo CD.",
            },
            {
                id: uid(),
                name: "gitops — ArgoCD GitOps",
                link: "github.com/traipoap/gitops",
                description:
                    "Maintained Git as the source of truth for the K3s cluster, with Argo CD continuously reconciling cluster state and correcting configuration drift.\nIntegrated External Secrets Operator with AWS Secrets Manager to sync credentials into the cluster without storing them in Git.\nConfigured Argo CD Image Updater to detect new image versions, update tags according to semantic versioning, and deploy automatically.\nConfigured LimitRange defaults and schema validation for Argo CD Applications.\nImplemented observability with Prometheus, Grafana, and Kiali, and routed logs through Otel to Loki; used the Argo CD UI for application visibility.",
            },
            {
                id: uid(),
                name: "aws — Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "Built a multi-region disaster recovery setup with K3s as the primary origin behind CloudFront origin groups, automatically failing over on 4xx/5xx responses to a Go/Gin Lambda (ECR) and a static site on S3 across ap-southeast-1 and ap-southeast-7. This provides cross-provider continuity for app.traipoap.com.\nCreated Terraform modules for CloudFront, ECR, IAM, S3, and ACM, plus a CloudFront Function for clean URL routing and OAC/SigV4 for private S3 access.",
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
            "สวัสดีครับ ผมชื่อไตรภพ หุ่นทอง ปัจจุบันทำงานด้านดูแลระบบเครือข่าย (Network Administrator) และกำลังต่อยอดประสบการณ์ด้านเครือข่าย โครงสร้างพื้นฐาน และคลาวด์ เพื่อเติบโตสู่ตำแหน่ง DevOps Engineer ผมได้รับการรับรอง CKA และ CKAD จาก Linux Foundation และพัฒนาโปรเจกต์ด้วยตนเองหลายโครงการ ทั้งแพลตฟอร์มค้นหาและจัดการ log บน home lab และระบบกู้คืนระบบเมื่อเกิดเหตุขัดข้อง (Disaster Recovery) บน AWS Cloud ผมมุ่งพัฒนาทักษะด้าน Kubernetes, CI/CD, GitOps และระบบอัตโนมัติสำหรับโครงสร้างพื้นฐาน เพื่อสร้างระบบที่เสถียรและพร้อมใช้งานจริง",
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
                    "ดูแลระบบเครือข่ายในฐานะ Tier-2 แก้ไขเหตุขัดข้องที่ส่งต่อมาจาก Tier-1 และประสานงานกับทีมภายในและหน่วยงานภายนอกให้ดำเนินงานได้ตาม SLA\nดำเนินการเปลี่ยนแปลงระบบ (change) และคำขอบริการ (service request) เช่น เพิ่มหรือแก้ไข VLAN พร้อมสำรองค่าการตั้งค่า (backup) ให้เป็นปัจจุบัน\nถ่ายทอดความรู้และฝึกอบรมทีม Tier-1 เพื่อเพิ่มประสิทธิภาพการทำงาน พร้อมจัดทำรายงานประจำเดือนตามขอบเขตงาน\nช่วยลดเวลาเฉลี่ยในการแก้ไขเหตุขัดข้อง (MTTR) ด้วยระบบเฝ้าระวังเชิงรุกผ่าน Zabbix ซึ่งตรวจพบปัญหาแฝงที่การแจ้งเตือนแบบเดิมตรวจไม่พบ และส่งการแจ้งเตือนผ่าน Telegram\nเขียนสคริปต์ตรวจสุขภาพอุปกรณ์หลายเครื่องโดยอัตโนมัติ ลดการตรวจสอบด้วยตนเองในแต่ละวัน\nแก้ไขความขัดแย้งของนโยบาย IPv6 โดยปิดการกำหนดค่า IPv6 อัตโนมัติ (auto-configuration) ที่ไม่พึงประสงค์ ทำให้การตั้งค่า firewall กลับมาเป็นไปตามข้อกำหนดด้านความปลอดภัย\nวิเคราะห์ปัญหาการกระจายโหลด (load balancing) และพบว่าการตั้งค่าพอร์ต backend กับการเปิดพอร์ตใน Docker Compose ไม่ถูกต้อง พร้อมแนะนำวิธีแก้ไขจนลูกค้ากลับมาใช้งานได้ตามปกติ\nพัฒนาระบบติดตามสถานะ Hardware License และ End-of-Life (EOL) โดยใช้ Google Apps Script ให้สามารถประมวลผลข้อมูลจากไฟล์ CSV ตามเวลาที่กำหนด ตรวจสอบ License ที่ใกล้หมดอายุและอุปกรณ์ที่ใกล้สิ้นสุดระยะเวลาการสนับสนุน พร้อมส่งการแจ้งเตือนผ่าน Telegram โดยอัตโนมัติ",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra — K3s Platform บน Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "สร้างแพลตฟอร์ม K3s แบบอัตโนมัติ ตั้งแต่ Terraform (สร้าง VM จากเทมเพลต กำหนดจำนวนโหนด และจัดเก็บ state บน HCP Terraform) ไปจนถึง Ansible (playbook 6 ชุดและการปรับแต่ง kernel) แล้วติดตั้ง K3s แบบ HA ด้วย embedded etcd พร้อม Istio ambient, Gateway API และ ArgoCD สำหรับ GitOps (ติดตั้งผ่าน Helm)\nติดตั้งแพลตฟอร์มทั้งหมดจากศูนย์ได้ภายในหนึ่งชั่วโมง ประกอบด้วย super-node (HAProxy L7, syslog relay, NFS และ S3), control plane 3 โหนด (etcd quorum) และ worker 2 โหนด พร้อมสร้างซ้ำหรือรื้อระบบด้วย terraform destroy\nรองรับ container runtime หลายตัว โดยใช้ crun เป็นค่าเริ่มต้นและกำหนด youki เป็น RuntimeClass ของ Kubernetes\nจัดทำเอกสารการตัดสินใจด้านสถาปัตยกรรม 14 ข้อ คู่มือติดตั้ง และคู่มือแก้ไขปัญหา (runbook)",
            },
            {
                id: uid(),
                name: "app — Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "พัฒนาและดูแลแพลตฟอร์มค้นหา log แบบ self-hosted ในสภาพแวดล้อมใช้งานจริง ประกอบด้วย Go API (ยืนยันตัวตนด้วย JWT ค้นหาด้วย Quickwit และส่งออก CSV) กับ Astro dashboard\nสร้าง CI/CD ด้วย GitHub Actions: สแกน secret ที่รั่วไหลด้วย Gitleaks ตรวจ SAST ด้วย SonarQube สร้าง image เฉพาะส่วนที่เปลี่ยน สแกนช่องโหว่ระดับ CRITICAL/HIGH ด้วย Trivy (SARIF) ส่ง image ไปยัง GHCR และให้ ArgoCD deploy อัตโนมัติ",
            },
            {
                id: uid(),
                name: "gitops — ArgoCD GitOps",
                link: "github.com/traipoap/gitops",
                description:
                    "ใช้ Git เป็นแหล่งข้อมูลหลัก (source of truth) ของคลัสเตอร์ K3s โดย ArgoCD จะซิงก์สถานะกับ Git อย่างต่อเนื่องและแก้ไข configuration drift โดยอัตโนมัติ (self-healing)\nเชื่อม External Secrets Operator กับ AWS Secrets Manager เพื่อซิงก์ credentials เข้าคลัสเตอร์โดยไม่จัดเก็บไว้ใน Git\nตั้งค่า ArgoCD Image Updater ให้ตรวจพบ image รุ่นใหม่ อัปเดต tag ตาม semver และ deploy โดยอัตโนมัติ\nกำหนดค่าเริ่มต้นของ LimitRange และตรวจสอบ schema ของ ArgoCD Application\nติดตั้งระบบ observability ด้วย Prometheus, Grafana และ Kiali พร้อมส่ง log ผ่าน Otel ไปยัง Loki และติดตามสถานะแอปผ่าน ArgoCD UI",
            },
            {
                id: uid(),
                name: "aws — Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "สร้างระบบ Disaster Recovery (DR) ข้าม region โดยใช้ K3s เป็น origin หลักของ CloudFront เมื่อได้รับสถานะ 4xx/5xx จะ failover ไปยัง Lambda (Go/Gin บน ECR) และ static build บน S3 ใน ap-southeast-1 และ ap-southeast-7 เพื่อให้ app.traipoap.com ทำงานต่อได้เมื่อระบบหลักขัดข้อง\nสร้าง Terraform module สำหรับ CloudFront, ECR, IAM, S3 และ ACM พร้อม CloudFront Function สำหรับ clean-URL routing และ OAC/SigV4 เพื่อเข้าถึง S3 แบบส่วนตัว",
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

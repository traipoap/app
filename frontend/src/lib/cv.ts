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

// uid mints ids for CV list items (DOM keying only, never security-sensitive).
// WebCrypto throughout — Math.random() is deliberately not used.
export const uid = (): string => {
    if (typeof crypto === "undefined") {
        throw new TypeError("WebCrypto is unavailable");
    }
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    return "id-" + Array.from(buf, (n) => n.toString(16).padStart(8, "0")).join("");
};

// ── DOM helpers (all user content is escaped via text nodes) ──
// applyAttrs writes an attribute map: "class" → className, `true` → empty
// attribute, null/false/undefined → skipped.
function applyAttrs(
    node: Element,
    attrs: Record<string, string | boolean | number | null>,
): void {
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === false || value === undefined) continue;
        if (key === "class") {
            node.className = String(value);
        } else if (value === true) {
            node.setAttribute(key, "");
        } else {
            node.setAttribute(key, String(value));
        }
    }
}

// appendChildren appends children, coercing strings into text nodes and
// skipping nullish entries.
function appendChildren(
    node: ParentNode,
    children: Array<Node | string | null | undefined>,
): void {
    for (const child of children) {
        if (child === null || child === undefined) continue;
        node.append(
            child instanceof Node
                ? child
                : document.createTextNode(String(child)),
        );
    }
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string | boolean | number | null> | null,
    ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (attrs) applyAttrs(node, attrs);
    appendChildren(node, children);
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
    if (start.trim() && to) return `${start.trim()} – ${to}`;
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

// Height added by a unit on top of the previous box's trailing margin
// (same collapse model as the browser).
function unitCost(m: Measured, pending: number): number {
    return Math.max(pending, m.t) - pending + m.h + m.b;
}

// needsBreakBefore decides whether a page break is required before placing
// `m`: an explicit "start on new page" always wins; otherwise break when
// the heading + first-item pair won't fit the remainder but does fit a
// fresh page.
function needsBreakBefore(
    m: Measured,
    pair: Measured | null,
    curLen: number,
    used: number,
    lastB: number,
    cap: number,
    forceBreak: (title: string) => boolean,
): boolean {
    if (m.heading && curLen > 0 && forceBreak(m.section)) return true;
    const pairCost = unitCost(m, lastB) + (pair ? unitCost(pair, m.b) : 0);
    // Only force a page break if the pair actually fits a fresh page.
    const pairFitsPage =
        !pair || m.t + m.h + Math.max(m.b, pair.t) + pair.h + pair.b <= cap + 0.5;
    return curLen > 0 && pairCost > cap - used && pairFitsPage;
}

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
    const add = (m: Measured) => {
        used += unitCost(m, lastB);
        cur.push(m);
        lastB = m.b;
    };
    const flush = () => {
        if (cur.length) pages.push(cur);
        cur = [];
        used = 0;
        lastB = 0;
    };
    for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        const pair = m.heading && i + 1 < ms.length ? ms[i + 1] : null;
        if (
            needsBreakBefore(
                m,
                pair,
                cur.length,
                used,
                lastB,
                cap,
                forceBreak,
            )
        )
            flush();
        add(m);
        if (pair) {
            add(pair);
            i++;
        }
    }
    flush();
    return pages;
}

// Height of a page's units (same collapse model as paginate).
function pageCost(ms: Measured[]): number {
    let used = 0;
    let lastB = 0;
    for (const m of ms) {
        used += unitCost(m, lastB);
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
    const last = pages.at(-1);
    const prev = pages.at(-2);
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

// Append a run of same-kind nodes the way that kind renders.
function appendRun(target: HTMLElement, run: Measured[]): void {
    if (!run.length) return;
    const nodes = run.map((m) => m.node);
    if (run[0].kind === "entry") target.append(el("div", null, ...nodes));
    else if (run[0].kind === "pair")
        target.append(el("div", { class: "cv-pairgrid" }, ...nodes));
    else nodes.forEach((n) => target.append(n));
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
        if (!target) {
            run = [];
            return;
        }
        appendRun(target, run);
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

// ── Section builders ─────────────────────────────────────────────
// Each builder returns null for an empty block, so renderSheetInto
// can collect them in canonical order and filter the nulls.

function expHasContent(e: ExperienceItem): boolean {
    return Boolean(
        e.role ||
            e.company ||
            e.location ||
            e.start ||
            e.end ||
            bullets(e.description).length,
    );
}

function buildSheetHead(data: CVData): HTMLElement | null {
    if (!data.name && !data.title && !data.summary) return null;
    const showPhoto = Boolean(data.photo) && data.template !== "ats";
    const head = el("header", {
        class: showPhoto ? "cv-sheet-head has-photo" : "cv-sheet-head",
    });
    const headText = el("div", { class: "cv-head-text" });
    headText.append(el("div", { class: "cv-headbar" }));
    if (showPhoto)
        head.append(el("img", { class: "cv-photo", src: data.photo, alt: "" }));
    if (data.name) headText.append(el("h1", { class: "cv-name" }, data.name));
    if (data.title)
        headText.append(el("p", { class: "cv-roletitle" }, data.title));
    const contact = [
        data.email,
        data.phone,
        data.location,
        data.website,
        data.github,
        data.linkedin,
    ].filter(Boolean);
    if (contact.length) {
        const line = el("p", { class: "cv-contact" });
        contact.forEach((c, i) => {
            if (i > 0)
                line.append(
                    el("span", { class: "sep", "aria-hidden": true }, "•"),
                );
            line.append(document.createTextNode(String(c)));
        });
        headText.append(line);
    }
    head.append(headText);
    return head;
}

function buildProfile(data: CVData): Sec | null {
    if (!data.summary.trim()) return null;
    return {
        col: "main",
        title: "Profile",
        kind: "single",
        nodes: [el("p", { class: "cv-para" }, data.summary.trim())],
    };
}

function buildExperience(data: CVData): Sec | null {
    const items = data.experience.filter(expHasContent);
    if (!items.length) return null;
    const list: Node[] = [];
    for (const e of items) {
        const item = el("div", { class: "cv-entry" });
        const headLine = el("div", { class: "cv-entry-head" });
        headLine.append(
            el(
                "span",
                { class: "cv-entry-main" },
                e.role && el("strong", { class: "cv-entry-role" }, e.role),
                e.company &&
                    el(
                        "span",
                        { class: "cv-entry-company" },
                        (e.role ? " · " : "") + e.company,
                    ),
                e.location &&
                    el("span", { class: "cv-entry-loc" }, " · " + e.location),
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
    return { col: "main", title: "Experience", kind: "entry", nodes: list };
}

function projectMain(p: ProjectItem): Node {
    const nodes: Node[] = [];
    if (p.name) nodes.push(el("strong", { class: "cv-entry-role" }, p.name));
    if (p.link)
        nodes.push(
            el("span", { class: "cv-entry-company" }, (p.name ? " · " : "") + p.link),
        );
    return el("span", { class: "cv-entry-main" }, ...nodes);
}

function projectDesc(p: ProjectItem): Node | null {
    if (!p.description.trim()) return null;
    const pLines = bullets(p.description);
    if (pLines.length > 1) {
        const ul = el("ul", { class: "cv-bullets" });
        for (const l of pLines) ul.append(el("li", null, l));
        return ul;
    }
    return el("p", { class: "cv-entry-desc" }, p.description.trim());
}

function buildProjectItem(p: ProjectItem): Node {
    const item = el("div", { class: "cv-entry" });
    item.append(projectMain(p));
    const desc = projectDesc(p);
    if (desc) item.append(desc);
    return item;
}

function buildProjects(data: CVData): Sec | null {
    const items = data.projects.filter(
        (p) => p.name || p.link || p.description,
    );
    if (!items.length) return null;
    const list: Node[] = [];
    for (const p of items) list.push(buildProjectItem(p));
    return { col: "main", title: "Projects", kind: "entry", nodes: list };
}

function buildEducation(data: CVData): Sec | null {
    const items = data.education.filter(
        (e) => e.degree || e.school || e.start || e.end,
    );
    if (!items.length) return null;
    const list: Node[] = [];
    for (const e of items) {
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
                            el("strong", { class: "cv-entry-role" }, e.degree),
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
    return { col: "side", title: "Education", kind: "entry", nodes: list };
}

function buildSkills(data: CVData): Sec | null {
    if (!data.skills.length) return null;
    const chips = el("div", { class: "cv-chips" });
    for (const s of data.skills)
        chips.append(el("span", { class: "cv-chip" }, s));
    return { col: "side", title: "Skills", kind: "single", nodes: [chips] };
}

function buildLanguages(data: CVData): Sec | null {
    const items = data.languages.filter((l) => l.name || l.level);
    if (!items.length) return null;
    const pairs: Node[] = [];
    for (const l of items)
        pairs.push(
            el(
                "div",
                { class: "cv-pair" },
                el("span", { class: "cv-pair-name" }, l.name || "—"),
                l.level ? el("span", { class: "cv-pair-meta" }, l.level) : null,
            ),
        );
    return { col: "side", title: "Languages", kind: "pair", nodes: pairs };
}

function buildCertifications(data: CVData): Sec | null {
    const items = data.certifications.filter(
        (c) => c.name || c.issuer || c.year,
    );
    if (!items.length) return null;
    const pairs: Node[] = [];
    for (const c of items)
        pairs.push(
            el(
                "div",
                { class: "cv-pair" },
                el("span", { class: "cv-pair-name" }, c.name || "—"),
                [c.issuer, c.year].filter(Boolean).length
                    ? el(
                          "span",
                          { class: "cv-pair-meta" },
                          [c.issuer, c.year].filter(Boolean).join(" · "),
                      )
                    : null,
            ),
        );
    return {
        col: "side",
        title: "Certifications",
        kind: "pair",
        nodes: pairs,
    };
}

// ── Layout, measurement, pagination ──────────────────────────────

function mkUnits(s: Sec): Unit[] {
    return [
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
}

function attachMeasured(box: Element, ss: Sec[], units: Unit[]): void {
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
}

function unitTopMargin(u: Unit, node: HTMLElement): number {
    const target = u.heading ? node.parentElement ?? node : node;
    return Number.parseFloat(getComputedStyle(target).marginTop) || 0;
}

function toMeasured(units: Unit[]): Measured[] {
    return units.map((u) => {
        const node = u.node as HTMLElement;
        const cs = getComputedStyle(node);
        return {
            ...u,
            h: node.offsetHeight,
            t: unitTopMargin(u, node),
            b: Number.parseFloat(cs.marginBottom) || 0,
        };
    });
}

function paginateColumn(
    sheet: HTMLElement,
    headNode: HTMLElement | null,
    secs: Sec[],
    mainSecs: Sec[],
    sideSecs: Sec[],
    modern: boolean,
    wantsBreak: (title: string) => boolean,
): { mainPages: Measured[][]; sidePages: Measured[][] } {
    const mainUnits = mainSecs.flatMap(mkUnits);
    const sideUnits = sideSecs.flatMap(mkUnits);
    // Single-column templates flow every section in canonical order.
    const singleUnits = modern ? mainUnits : secs.flatMap(mkUnits);

    // Measure units at their final width (exact final structure).
    const measureBox = el("div", { class: "cv-measure" });
    if (headNode) measureBox.append(headNode);
    if (modern) {
        const cols = el("div", { class: "cv-cols" });
        const mainC = el("div", { class: "cv-col-main" });
        attachMeasured(mainC, mainSecs, mainUnits);
        const sideC = el("div", { class: "cv-col-side" });
        attachMeasured(sideC, sideSecs, sideUnits);
        cols.append(mainC, sideC);
        measureBox.append(cols);
    } else {
        attachMeasured(measureBox, secs, singleUnits);
    }
    sheet.append(measureBox);

    const headMs = headNode
        ? {
              h: headNode.offsetHeight,
              t: Number.parseFloat(getComputedStyle(headNode).marginTop) || 0,
              b: Number.parseFloat(getComputedStyle(headNode).marginBottom) || 0,
          }
        : null;
    measureBox.remove();

    const firstOffset = headMs ? headMs.t + headMs.h + headMs.b : 0;
    const topMargin = headMs ? headMs.b : 0;
    const paginateAll = (ms: Measured[]): Measured[][] =>
        pullSplitSection(
            rescueOrphan(
                paginate(ms, PAGE_CAP, firstOffset, topMargin, wantsBreak),
                PAGE_CAP,
                wantsBreak,
            ),
        );

    return {
        mainPages: paginateAll(toMeasured(singleUnits)),
        sidePages: modern ? paginateAll(toMeasured(sideUnits)) : [],
    };
}

function renderPages(
    sheet: HTMLElement,
    headNode: HTMLElement | null,
    modern: boolean,
    mainPages: Measured[][],
    sidePages: Measured[][],
): void {
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

function renderEmptySheet(sheet: HTMLElement): void {
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
                "Start filling the form on the left, or press “Load my data” to pre-fill your profile.",
            ),
        ),
    );
    sheet.replaceChildren(page);
}

/**
 * Render a full A4-paginated sheet into `sheet`.
 * The caller is responsible for any scaling/fitting afterwards.
 */
export function renderSheetInto(sheet: HTMLElement, data: CVData): void {
    sheet.style.setProperty("--cv-accent", data.accent);
    sheet.classList.toggle("ats", data.template === "ats");

    const headNode = buildSheetHead(data);
    const secs = [
        buildProfile(data),
        buildExperience(data),
        buildProjects(data),
        buildEducation(data),
        buildSkills(data),
        buildLanguages(data),
        buildCertifications(data),
    ].filter((s): s is Sec => s !== null);

    // Canonical order ATS parsers expect.
    if (data.template === "ats") {
        const order: Record<string, number> = {
            Profile: 0,
            Experience: 1,
            Projects: 2,
            Education: 3,
            Skills: 4,
            Languages: 5,
            Certifications: 6,
        };
        secs.sort((a, b) => (order[a.title] ?? 9) - (order[b.title] ?? 9));
    }
    const mainSecs = secs.filter((s) => s.col === "main");
    const sideSecs = secs.filter((s) => s.col === "side");
    const modern = data.template === "modern" && sideSecs.length > 0;

    if (!headNode && secs.length === 0) {
        renderEmptySheet(sheet);
        return;
    }

    const wantsBreak = (t: string) => data.breaks[t] === true;
    const { mainPages, sidePages } = paginateColumn(
        sheet,
        headNode,
        secs,
        mainSecs,
        sideSecs,
        modern,
        wantsBreak,
    );
    renderPages(sheet, headNode, modern, mainPages, sidePages);
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
            "HAProxy / Keepalived / WAF",
            "NFS / Garage (S3)",
            "Cloudflare Tunnel / Tailscale",
            "Go / Python / Bash",
            "Investigation / Troubleshooting",
            "Linux / Debian / Ubuntu",
        ],
        certifications: [
            {
                id: uid(),
                name: "CKA: Certified Kubernetes Administrator",
                issuer: "Linux Foundation",
                year: "2026 – 2028",
            },
            {
                id: uid(),
                name: "CKAD: Certified Kubernetes Application Developer",
                issuer: "Linux Foundation",
                year: "2026 – 2028",
            },
        ],
        accent: "#4f46e5",
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
            "Infrastructure and DevOps Engineer with nearly 5 years of experience in network and cloud infrastructure operations, holding CKA and CKAD certifications from the Linux Foundation.\nHands-on experience designing and building an end-to-end Kubernetes platform using Terraform, Ansible, K3s HA, Istio, and Argo CD. Built automated CI/CD pipelines with security scanning, GitOps-based deployments, centralized logging, and an AWS disaster recovery solution.\nStrong foundation in infrastructure troubleshooting, network reliability, automation, and production operations, with a focus on building scalable, secure, and resilient platforms.",
        experience: [
            {
                id: uid(),
                role: "Network Administrator (Tier-2 Support)",
                company:
                    "360 Bizmate Co., Ltd. (NT, National Telecom)",
                location: "",
                start: "Jan 2022",
                end: "",
                current: true,
                description:
                    "Owned Tier-2 incident escalation, with root-cause analysis, vendor/team coordination to keep SLAs.\nManage the Zabbix stack, including patching against published CVEs, proactive north-south monitoring (Zabbix → Telegram) catches issues east-west alerts miss, reducing MTTR.\nAutomated PSU (power supply) checks for network switches with Ansible, replacing daily manual checks.\nBuilt a scheduled hardware lifecycle automation (Google Apps Script): parses CSV license/EOL records, flags expirations, alerts via Telegram.\nExecuted system changes (load balancing, routing, VLAN) with configuration backups.\nResolved IPv6 policy conflicts by disabling auto-configuration (the IPv6 default) and restoring firewall compliance.\nWorked with the customer on integrating their systems with the cloud Load Balancer.\nTrained Tier-1 staff and prepared monthly operational reports.",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra: K3s Platform on Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "Automated K3s platform: Terraform (VM templates, HCP remote state), Ansible (6 idempotent playbooks, kernel tuning), K3s HA (embedded etcd), Istio ambient, Gateway API, Argo CD GitOps via Helm.\nFrom-scratch provisioning in under an hour: super-node (HAProxy L7, NFS, S3), 3 control-plane nodes (etcd quorum), 3 workers; repeatable, torn down via terraform destroy.\nMulti-runtime support: crun as default, youki exposed as a RuntimeClass..",
            },
            {
                id: uid(),
                name: "app: Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "Self-hosted log-search platform in a personal production environment: Go API (JWT, Quickwit, CSV export) and Astro dashboard.\nGitHub Actions CI/CD: Gitleaks secret scan, SonarQube SAST gate, path-filtered builds, Trivy CRITICAL/HIGH scans (SARIF), GHCR publish, Argo CD auto-deploy.",
            },
            {
                id: uid(),
                name: "gitops: ArgoCD GitOps",
                link: "github.com/traipoap/argocd-bootstrap",
                description:
                    "Git as the source of truth: Argo CD reconciles cluster state and corrects configuration drift.\nDeployed Google's microservices-demo (10 services) as Argo CD applications on the Istio cluster, a real multi-service workload for mesh and observability validation.\nExternal Secrets Operator with AWS Secrets Manager, keeping credentials in-cluster, never in Git.\nImage Updater: new image versions → semver tag updates → auto-deploy.\nLimitRange defaults and schema validation for Argo CD Applications.\nObservability with Prometheus and Grafana; logs routed via Otel to Loki.",
            },
            {
                id: uid(),
                name: "aws: Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "Multi-region DR: K3s as the primary CloudFront origin, failing over on 4xx/5xx to a Go/Gin Lambda (ECR) and an S3 static site across ap-southeast-1/7, keeping app.traipoap.com up.\nMonthly origin-failover drills keep the DR path validated.\nTerraform modules for CloudFront, ECR, IAM, S3, ACM + CloudFront Function for clean-URL routing, OAC/SigV4 for private S3.",
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
            "วิศวกรด้าน Infrastructure และ DevOps ที่มีประสบการณ์เกือบ 5 ปีในการดูแลระบบเครือข่ายและ Cloud Infrastructure พร้อมใบรับรอง CKA และ CKAD จาก Linux Foundation\nมีประสบการณ์ลงมือออกแบบและสร้าง Kubernetes Platform ตั้งแต่ต้นจนจบ โดยใช้ Terraform, Ansible, K3s HA, Istio และ Argo CD รวมถึงพัฒนา CI/CD Pipeline ที่มีระบบตรวจสอบช่องโหว่และความปลอดภัย ใช้ GitOps ในการ Deploy ระบบ และจัดการ Log จากส่วนกลาง นอกจากนี้ยังสร้างระบบ Disaster Recovery บน AWS ที่รองรับการสำรองและสลับการให้บริการข้าม Region\nมีพื้นฐานด้านการวิเคราะห์และแก้ไขปัญหา Infrastructure, การดูแลความเสถียรของระบบเครือข่าย และการทำงานอัตโนมัติเพื่อลดงานซ้ำซ้อน โดยมุ่งเน้นการสร้างระบบที่รองรับการขยายตัว มีความปลอดภัย และพร้อมให้บริการอย่างต่อเนื่อง",
        experience: [
            {
                id: uid(),
                role: "Network Administrator (Tier-2)",
                company:
                    "บริษัท 360 Bizmate จำกัด (NT, กสท โทรคมนาคม)",
                location: "",
                start: "ม.ค. 2022",
                end: "",
                current: true,
                description:
                    "ดูแลเหตุขัดข้องระดับ Tier-2 วิเคราะห์สาเหตุที่แท้จริง และประสานทีมภายใน/หน่วยงานภายนอกให้ปิดงานได้ตาม SLA\nดูแลระบบ Zabbix และเฝ้าระวังเชิงรุก, จับปัญหาแฝงฝั่ง North-South ที่ระบบการแจ้งเตือนฝั่ง East-West มองไม่เห็น แจ้งเตือนผ่าน Telegram ช่วยลด MTTR และติดตั้ง patch ตามช่องโหว่ (CVE) ที่ประกาศออกมา\nใช้ Ansible ตรวจสอบ Power supply ของอุปกรณ์ Network switch อัตโนมัติ แทนการ manual\nพัฒนาระบบติดตาม Hardware License และ EOL ด้วย Google Apps Script โดยประมวลผล CSV ตาม schedule ตรวจ License ใกล้หมดอายุและอุปกรณ์ใกล้สิ้นสุดการ Support โดยแจ้งเตือนผ่าน Telegram\nดำเนินการเปลี่ยนแปลงระบบ (change) เช่น Load-Balancing, Routing, VLAN พร้อม Backup configure\nแก้ไข Policy conflict IPv6 โดยปิด auto-configuration ที่เป็นค่าเริ่มของของ IPv6 ทำให้ firewall เป็นไปตามข้อกำหนดความปลอดภัย\nเข้าประชุมกับลูกค้าหารือการ Integrate ระบบของลูกค้ากับระบบ Load-Balance ในระบบ Cloud\nถ่ายทอดความรู้ให้ทีม Tier-1 และจัดทำรายงานประจำเดือน",
            },
        ],
        projects: [
            {
                id: uid(),
                name: "infra: K3s Platform บน Proxmox",
                link: "github.com/traipoap/infra",
                description:
                    "สร้าง K3s platform แบบอัตโนมัติ: Terraform (VM templates, state บน HCP Terraform), Ansible (6 playbooks, kernel tuning), K3s HA (embedded etcd), Istio ambient, Gateway API และ ArgoCD สำหรับ GitOps\nติดตั้งจากศูนย์ได้ภายใน 1 ชั่วโมง: super-node (HAProxy L7, NFS, S3), control plane 3 โหนด (etcd quorum), worker 3 โหนด สร้างซ้ำ/รื้อด้วย terraform destroy\nรองรับ container runtime หลายตัว, ใช้ crun เป็นค่าเริ่มต้น และ youki เป็น RuntimeClass.",
            },
            {
                id: uid(),
                name: "app: Go/GIN + Astro Log Platform",
                link: "app.traipoap.com · github.com/traipoap/app",
                description:
                    "พัฒนา log search platform บน Go API (JWT, Quickwit, CSV export) กับ Astro dashboard\nCI/CD ด้วย GitHub Actions: Gitleaks สแกน secret, SonarQube SAST, build เฉพาะส่วนที่เปลี่ยน, Trivy สแกน CRITICAL/HIGH (SARIF), push GHCR แล้ว ArgoCD deploy อัตโนมัติ",
            },
            {
                id: uid(),
                name: "gitops: ArgoCD GitOps",
                link: "github.com/traipoap/argocd-bootstrap",
                description:
                    "ใช้ Git เป็น source of truth ของคลัสเตอร์, ArgoCD ซิงก์สถานะต่อเนื่องและแก้ configuration drift อัตโนมัติ\nรัน Google microservices-demo (10 services) เป็น Argo CD Application บนคลัสเตอร์ Istio, workload multi-service จริงสำหรับตรวจสอบ service mesh และ observability\nเชื่อม External Secrets Operator กับ AWS Secrets Manager, credentials เข้าคลัสเตอร์โดยไม่เก็บใน Git\nArgoCD Image Updater, ตรวจ image ใหม่ อัปเดต tag ตาม semver และ deploy อัตโนมัติ\nกำหนด LimitRange defaults และ schema validation สำหรับ ArgoCD Application\nObservability ด้วย Prometheus และ Grafana ส่ง log ผ่าน Otel ไปยัง Loki",
            },
            {
                id: uid(),
                name: "aws: Multi-region Failover DR",
                link: "github.com/traipoap/infra/tree/main/aws",
                description:
                    "ระบบ DR ข้าม region: K3s เป็น origin หลักของ CloudFront เมื่อได้ 4xx/5xx failover ไปยัง Lambda (Go/Gin บน ECR) และ static build บน S3 ใน ap-southeast-1/7 ให้ app.traipoap.com ทำงานต่อได้\nซ้อม origin failover รายเดือน ให้มั่นใจว่าเส้นทาง DR ใช้งานได้จริง\nTerraform modules สำหรับ CloudFront, ECR, IAM, S3, ACM พร้อม CloudFront Function (clean-URL routing) และ OAC/SigV4 เข้า S3 แบบส่วนตัว",
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
            { id: uid(), name: "ไทย", level: "Native" },
            {
                id: uid(),
                name: "อังกฤษ",
                level: "สื่อสารเพื่อการทำงาน",
            },
        ],
    };
}

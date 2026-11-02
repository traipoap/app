// Search engine definitions shared by the Query and Dashboard pages.
// The selected engine is persisted in localStorage so both pages agree.
export const ENGINES = [
    {
        id: "quickwit",
        label: "Quickwit",
        hint: 'Quickwit / Lucene — e.g. level:ERROR AND message:"crash"',
    },
    {
        id: "loki",
        label: "Loki",
        hint: 'LogQL หรือ keyword — เช่น {service_name="nginx"} หรือ "timeout"',
    },
    {
        id: "elasticsearch",
        label: "Elasticsearch",
        hint: "Lucene query_string — เช่น level:ERROR AND message:crash",
    },
];

export const ENGINE_STORAGE_KEY = "lumina.query.engine";

export function savedEngine() {
    try {
        return localStorage.getItem(ENGINE_STORAGE_KEY) || "quickwit";
    } catch {
        return "quickwit";
    }
}

export function rememberEngine(id) {
    try {
        localStorage.setItem(ENGINE_STORAGE_KEY, id);
    } catch {
        /* private mode — ignore */
    }
}

export function engineDef(id) {
    return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

export function engineOptions(selectedId) {
    return ENGINES.map(
        (e) =>
            `<option value="${e.id}" ${e.id === selectedId ? "selected" : ""}>${e.label}</option>`,
    ).join("");
}

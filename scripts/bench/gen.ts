// Synthetic runbook corpus rendered three ways (Markdown, strict semantic HTML, plain text) from one
// document model, plus questions with gold answers/sections and edit tasks.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Fmt = "md" | "html" | "txt";
export const FORMATS: Fmt[] = ["md", "html", "txt"];

let seed = 1234567;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)] as T;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j] as T, b[i] as T];
  }
  return b;
};

// ---------- document model ----------
type Inline = { t: "text" | "strong" | "code"; v: string }[];
type Block =
  | { k: "p"; c: Inline }
  | { k: "table"; head: string[]; rows: string[][] }
  | { k: "ol"; items: Inline[] }
  | { k: "deps"; items: { name: string; kv: [string, string][] }[] }
  | { k: "code"; lang: string; text: string }
  | { k: "incidents"; items: { date: string; text: string }[] };
export interface Section {
  key: string;
  path: string[]; // heading path below the title
  blocks: Block[];
}
export interface Doc {
  slug: string;
  title: string;
  tags: string[];
  sections: Section[]; // leaf sections in document order; parents have no own blocks
}

/**
 * One block of one section, by position and kind. Every generated document has the same shape, so a
 * miss is a bug in a probe rather than something to handle: it throws instead of returning
 * undefined, which is what keeps the callers free of casts.
 */
export function blockAt<K extends Block["k"]>(
  doc: Doc,
  section: number,
  block: number,
  kind: K,
): Extract<Block, { k: K }> {
  const found = doc.sections[section]?.blocks[block];
  if (found?.k !== kind) {
    throw new Error(`${doc.slug}: no ${kind} block at section ${section}, block ${block}`);
  }
  return found as Extract<Block, { k: K }>;
}

/** The same, for a section named by its key rather than its position. */
export function blockOf<K extends Block["k"]>(
  doc: Doc,
  key: string,
  block: number,
  kind: K,
): Extract<Block, { k: K }> {
  const index = doc.sections.findIndex((s) => s.key === key);
  if (index === -1) throw new Error(`${doc.slug}: no section ${key}`);
  return blockAt(doc, index, block, kind);
}

const T = (v: string) => ({ t: "text" as const, v });
const S = (v: string) => ({ t: "strong" as const, v });
const C = (v: string) => ({ t: "code" as const, v });

// ---------- renderers ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(c: Inline, f: Fmt): string {
  return c
    .map((x) => {
      if (f === "md") return x.t === "strong" ? `**${x.v}**` : x.t === "code" ? `\`${x.v}\`` : x.v;
      if (f === "html")
        return x.t === "strong"
          ? `<strong>${esc(x.v)}</strong>`
          : x.t === "code"
            ? `<code>${esc(x.v)}</code>`
            : esc(x.v);
      return x.v;
    })
    .join("");
}

export function renderBlocks(blocks: Block[], f: Fmt, ind = ""): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.k === "p") out.push(f === "html" ? `${ind}<p>${inline(b.c, f)}</p>` : inline(b.c, f));
    else if (b.k === "table") {
      if (f === "md") {
        out.push(
          [
            `| ${b.head.join(" | ")} |`,
            `|${b.head.map(() => "---").join("|")}|`,
            ...b.rows.map((r) => `| ${r.join(" | ")} |`),
          ].join("\n"),
        );
      } else if (f === "html") {
        const i2 = `${ind}  `;
        const i3 = `${i2}  `;
        out.push(
          [
            `${ind}<table>`,
            `${i2}<thead>`,
            `${i3}<tr>${b.head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr>`,
            `${i2}</thead>`,
            `${i2}<tbody>`,
            ...b.rows.map(
              (r) =>
                `${i3}<tr><th scope="row">${esc(r[0] ?? "")}</th>${r
                  .slice(1)
                  .map((c) => `<td>${esc(c)}</td>`)
                  .join("")}</tr>`,
            ),
            `${i2}</tbody>`,
            `${ind}</table>`,
          ].join("\n"),
        );
      } else {
        out.push([b.head.join("\t"), ...b.rows.map((r) => r.join("\t"))].join("\n"));
      }
    } else if (b.k === "ol") {
      if (f === "html")
        out.push(
          [
            `${ind}<ol>`,
            ...b.items.map((it) => `${ind}  <li>${inline(it, f)}</li>`),
            `${ind}</ol>`,
          ].join("\n"),
        );
      else out.push(b.items.map((it, i) => `${i + 1}. ${inline(it, f)}`).join("\n"));
    } else if (b.k === "deps") {
      if (f === "md")
        out.push(
          b.items
            .map((d) => [`- **${d.name}**`, ...d.kv.map(([k, v]) => `  - ${k}: ${v}`)].join("\n"))
            .join("\n"),
        );
      else if (f === "html") {
        const lines = [`${ind}<ul>`];
        for (const d of b.items) {
          lines.push(`${ind}  <li>`, `${ind}    <strong>${esc(d.name)}</strong>`, `${ind}    <dl>`);
          for (const [k, v] of d.kv) lines.push(`${ind}      <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
          lines.push(`${ind}    </dl>`, `${ind}  </li>`);
        }
        lines.push(`${ind}</ul>`);
        out.push(lines.join("\n"));
      } else
        out.push(
          b.items
            .map((d) => [d.name, ...d.kv.map(([k, v]) => `  ${k}: ${v}`)].join("\n"))
            .join("\n"),
        );
    } else if (b.k === "code") {
      if (f === "md") out.push(`\`\`\`${b.lang}\n${b.text}\n\`\`\``);
      else if (f === "html")
        out.push(`${ind}<pre><code class="language-${b.lang}">${esc(b.text)}</code></pre>`);
      else out.push(b.text);
    } else if (b.k === "incidents") {
      if (f === "md") out.push(b.items.map((x) => `- ${x.date}: ${x.text}`).join("\n"));
      else if (f === "html")
        out.push(
          [
            `${ind}<ul>`,
            ...b.items.map(
              (x) => `${ind}  <li><time datetime="${x.date}">${x.date}</time>: ${esc(x.text)}</li>`,
            ),
            `${ind}</ul>`,
          ].join("\n"),
        );
      else out.push(b.items.map((x) => `${x.date}: ${x.text}`).join("\n"));
    }
  }
  return out.join(f === "html" ? "\n" : "\n\n");
}

const idOf = (p: string[]) => p.map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("--");

export function renderDoc(doc: Doc, f: Fmt): string {
  if (f === "md" || f === "txt") {
    const lines: string[] =
      f === "md"
        ? [
            "---",
            `title: ${doc.title}`,
            `tags: [${doc.tags.join(", ")}]`,
            "---",
            `# ${doc.title}`,
            "",
          ]
        : [doc.title, ""];
    let prev: string[] = [];
    for (const s of doc.sections) {
      s.path.forEach((h, depth) => {
        if (prev[depth] === h && prev.slice(0, depth).join() === s.path.slice(0, depth).join())
          return;
        lines.push(f === "md" ? `${"#".repeat(depth + 2)} ${h}` : h, "");
      });
      prev = s.path;
      lines.push(renderBlocks(s.blocks, f), "");
    }
    return lines.join("\n");
  }
  // strict semantic HTML: nested <section>s, labelled by their headings
  const out = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${esc(doc.title)}</title>`,
    `  <meta name="keywords" content="${doc.tags.join(", ")}">`,
    "</head>",
    "<body>",
    "<main>",
    "<article>",
    "  <header>",
    `    <h1>${esc(doc.title)}</h1>`,
    "  </header>",
  ];
  const open: string[] = [];
  for (const s of doc.sections) {
    let common = 0;
    while (common < open.length && open[common] === s.path[common]) common++;
    // a leaf with the same path as an open parent (overview) never happens; close diverging sections
    while (open.length > common) {
      open.pop();
      out.push(`${"  ".repeat(open.length + 1)}</section>`);
    }
    for (let d = common; d < s.path.length; d++) {
      const id = idOf(s.path.slice(0, d + 1));
      const ind = "  ".repeat(d + 1);
      out.push(
        `${ind}<section id="${id}" aria-labelledby="${id}-h">`,
        `${ind}  <h${d + 2} id="${id}-h">${esc(s.path[d] ?? "")}</h${d + 2}>`,
      );
      open.push(s.path[d] ?? "");
    }
    out.push(renderBlocks(s.blocks, "html", "  ".repeat(s.path.length + 1)));
  }
  while (open.length) {
    open.pop();
    out.push(`${"  ".repeat(open.length + 1)}</section>`);
  }
  out.push("</article>", "</main>", "</body>", "</html>", "");
  return out.join("\n");
}

// ---------- generation ----------
const BIRDS =
  "Kestrel Osprey Heron Marten Lynx Puffin Wren Bittern Ibis Stoat Vole Tern Egret Merlin Plover Shrike Curlew Dunlin Gannet Linnet Ermine Otter Badger Petrel Avocet Godwit Siskin Whimbrel Pipit Crake".split(
    " ",
  );
const ROLES =
  "Ingest Gateway Billing Scheduler Indexer Notifier Ledger Router Archiver Resolver".split(" ");
const PURPOSE: Record<string, string> = {
  Ingest: "accepts event batches from edge collectors and writes them to the event log",
  Gateway: "terminates client connections and routes API calls to internal services",
  Billing: "computes usage charges and emits invoices at the end of each cycle",
  Scheduler: "places recurring jobs onto worker pools and tracks their leases",
  Indexer: "builds search indexes from the event log and publishes snapshots",
  Notifier: "fans out email, SMS and push notifications with per-tenant rate limits",
  Ledger: "keeps the double-entry record of account balances",
  Router: "decides which region serves each tenant and rewrites requests accordingly",
  Archiver: "moves cold data to object storage and serves restores",
  Resolver: "maps customer identifiers across legacy and current account systems",
};
const TEAMS =
  "Harbor Lantern Quarry Meridian Foundry Beacon Orchard Summit Tidewater Juniper".split(" ");
const FIRST =
  "Priya Tomasz Adaeze Hiroshi Marisol Kwame Ingrid Rafael Soo-jin Dmitri Leilani Olumide Freya Anand Catalina Bogdan Yuki Tendai Margit Emeka".split(
    " ",
  );
const LAST =
  "Okonkwo Lindqvist Ferreira Nakashima Abernathy Castellanos Varga Mbeki Halvorsen Iyer Dubois Kowalczyk Achterberg Rosales Takahashi Ndlovu".split(
    " ",
  );
const LANGS = ["Go", "Rust", "Kotlin", "Elixir", "TypeScript", "Java", "Python"];
const DEPS: [string, string][] = [
  ["postgres", "primary relational store"],
  ["redis", "lease and rate-limit cache"],
  ["kafka", "event log transport"],
  ["nats", "internal request bus"],
  ["elasticsearch", "search backend"],
  ["clickhouse", "analytics store"],
  ["etcd", "leader election"],
  ["minio", "object storage"],
];
const CAUSE_A = [
  "an expired TLS certificate",
  "an exhausted connection pool",
  "a runaway cron job",
  "a misconfigured feature flag",
  "clock skew",
  "a full disk",
  "leaked file descriptors",
  "a stale config map",
  "a bad schema migration",
  "a retry storm",
];
const CAUSE_B = [
  "on the metrics sidecar",
  "in the eu-west replica",
  "after the 4.2 release",
  "on the batch workers",
  "in the primary region",
  "during nightly compaction",
];
const MEM = ["256Mi", "512Mi", "768Mi", "1Gi", "2Gi", "3Gi", "4Gi", "6Gi", "8Gi", "12Gi"];
const DB = [
  "db.t3.medium",
  "db.t4g.large",
  "db.m6g.large",
  "db.m6g.xlarge",
  "db.r6g.large",
  "db.r6g.xlarge",
  "db.r6g.2xlarge",
  "db.r7g.4xlarge",
];
const WINDOWS = [
  "Tuesday 14:00–16:00 UTC",
  "Wednesday 09:00–11:00 UTC",
  "Thursday 13:00–15:00 UTC",
  "Monday 15:00–17:00 UTC",
];

export interface Question {
  id: string;
  type: string;
  doc: string;
  section: string | null; // gold section key; null = unanswerable
  q: string;
  gold: string[]; // any accepted
  numeric?: boolean;
}
export interface EditTask {
  id: string;
  type: string;
  doc: string;
  instruction: string;
  section: string;
  expect: string[]; // must appear in the section after the edit
  gone?: string; // must no longer appear in the section
  apply: (d: Doc) => void;
}

const causes = shuffle(CAUSE_A.flatMap((a) => CAUSE_B.map((b) => `${a} ${b}`)));
const names = shuffle(FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`)));
const roles = shuffle(BIRDS.map((_, i) => ROLES[i % ROLES.length] as string));

export const docs: Doc[] = [];
export const questions: Question[] = [];
export const edits: EditTask[] = [];

BIRDS.forEach((bird, i) => {
  const role = roles[i] as string;
  const title = `${bird} ${role}`;
  const slug = `${bird}-${role}`.toLowerCase();
  const team = pick(TEAMS);
  const year = int(2014, 2023);
  const lang = pick(LANGS);
  const approverS = names.pop() as string;
  const approverP = names.pop() as string;
  const settings: [string, () => [string, string]][] = [
    ["Replicas", () => [String(int(1, 4)), String(int(6, 48))]],
    [
      "Memory limit",
      () => {
        const a = int(0, 4);
        return [MEM[a] as string, MEM[int(a + 2, 9)] as string];
      },
    ],
    ["Queue timeout", () => [`${int(2, 9) * 5}s`, `${int(10, 36) * 5}s`]],
    ["Max batch size", () => [String(int(1, 9) * 50), String(int(10, 80) * 50)]],
    [
      "DB instance class",
      () => {
        const a = int(0, 3);
        return [DB[a] as string, DB[int(a + 2, 7)] as string];
      },
    ],
  ];
  const rows = settings.map(([n, g]) => [n, ...g()]);
  const healthPort = int(8000, 8999);
  const metricsPort = int(9000, 9999);
  const cmds = [
    `veltra build ${slug}`,
    `veltra migrate ${slug}`,
    `veltra smoke ${slug}`,
    `veltra snapshot db-${slug}`,
    `veltra canary ${slug} --percent=5`,
    `veltra promote ${slug}`,
    `veltra drain ${slug}`,
    `veltra notify #${team.toLowerCase()}-deploys`,
  ];
  const prodSteps = shuffle(cmds).slice(0, 6);
  const stagingSteps = shuffle(prodSteps).slice(0, 4);
  const deps = shuffle(DEPS)
    .slice(0, int(3, 4))
    .map(([n, p]) => ({
      name: n,
      kv: [
        ["version", `${int(3, 17)}.${int(0, 9)}.${int(0, 12)}`],
        ["purpose", p],
      ] as [string, string][],
    }));
  const inc = [0, 1].map(() => ({
    date: `20${int(21, 25)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
    cause: causes.pop() as string,
  }));
  const window = pick(WINDOWS);

  const doc: Doc = {
    slug,
    title,
    tags: ["runbook", role.toLowerCase()],
    sections: [
      {
        key: "overview",
        path: ["Overview"],
        blocks: [
          {
            k: "p",
            c: [
              T(`${title} ${PURPOSE[role]}. It is owned by the `),
              S(team),
              T(` team and was first deployed in ${year}.`),
            ],
          },
          {
            k: "p",
            c: [
              T(`The service is written in ${lang}. Its on-call rotation pages `),
              C(`#${slug}-oncall`),
              T("."),
            ],
          },
        ],
      },
      {
        key: "config",
        path: ["Configuration"],
        blocks: [
          {
            k: "p",
            c: [T("Values per environment. Change them through the deploy config, never by hand.")],
          },
          { k: "table", head: ["Setting", "Staging", "Production"], rows },
        ],
      },
      {
        key: "deploy-staging",
        path: ["Deployment", "Staging"],
        blocks: [
          {
            k: "p",
            c: [T(`Staging deploys run on every merge to main. Approval comes from ${approverS}.`)],
          },
          { k: "ol", items: stagingSteps.map((c) => [T("Run "), C(c), T(".")]) },
        ],
      },
      {
        key: "deploy-production",
        path: ["Deployment", "Production"],
        blocks: [
          {
            k: "p",
            c: [T(`Production deploys need sign-off from ${approverP} and run only ${window}.`)],
          },
          { k: "ol", items: prodSteps.map((c) => [T("Run "), C(c), T(".")]) },
        ],
      },
      { key: "deps", path: ["Dependencies"], blocks: [{ k: "deps", items: deps }] },
      {
        key: "troubleshooting",
        path: ["Troubleshooting"],
        blocks: [
          { k: "p", c: [T("Check liveness first, then scrape metrics to see queue depth.")] },
          {
            k: "code",
            lang: "sh",
            text: `curl -s http://localhost:${healthPort}/healthz\ncurl -s http://localhost:${metricsPort}/metrics | grep queue_depth\njournalctl -u ${slug} --since "1 hour ago"`,
          },
        ],
      },
      {
        key: "incidents",
        path: ["Incidents"],
        blocks: [
          {
            k: "incidents",
            items: inc.map((x) => ({ date: x.date, text: `Outage caused by ${x.cause}.` })),
          },
        ],
      },
    ],
  };
  docs.push(doc);
  const path = slug;
  const add = (type: string, section: string | null, q: string, gold: string[], numeric = false) =>
    questions.push({ id: `${slug}:${type}`, type, doc: path, section, q, gold, numeric });

  add("prose-owner", "overview", `Which team owns ${title}?`, [team]);
  const row = pick(rows);
  const env = rnd() < 0.5 ? 1 : 2;
  add(
    "table-cell",
    "config",
    `What is the ${env === 1 ? "staging" : "production"} ${row[0]?.toLowerCase()} for ${title}?`,
    [row[env] as string],
  );
  const scopedProd = rnd() < 0.5;
  add(
    "scoped-section",
    scopedProd ? "deploy-production" : "deploy-staging",
    `Who approves ${scopedProd ? "production" : "staging"} deploys of ${title}?`,
    [scopedProd ? approverP : approverS],
  );
  const dep = pick(deps);
  add("nested-list", "deps", `Which version of ${dep.name} does ${title} depend on?`, [
    dep.kv[0]?.[1] as string,
  ]);
  const shared = stagingSteps[int(0, 3)] as string;
  const stepProd = rnd() < 0.5;
  const steps = stepProd ? prodSteps : stagingSteps;
  add(
    "ordered-step",
    stepProd ? "deploy-production" : "deploy-staging",
    `In the ${stepProd ? "production" : "staging"} deployment of ${title}, which step number runs \`${shared}\`?`,
    [String(steps.indexOf(shared) + 1)],
    true,
  );
  add(
    "code-block",
    "troubleshooting",
    `Which local port does the ${title} health check (healthz) use?`,
    [String(healthPort)],
    true,
  );
  const incident = pick(inc);
  add("reverse-lookup", "incidents", `Which service had an outage caused by ${incident.cause}?`, [
    title,
  ]);
  add(
    "unanswerable",
    null,
    `What canary percentage does ${title} use for its blue-green database failover?`,
    ["NOT FOUND"],
  );

  // edit tasks (memory writes)
  const newRep = String(int(49, 99));
  const oldRep = rows[0]?.[2] as string;
  edits.push({
    id: `${slug}:edit-cell`,
    type: "edit-cell",
    doc: path,
    section: "config",
    instruction: `Production replicas for ${title} are now ${newRep}.`,
    expect: [newRep],
    gone: `${oldRep}`,
    apply: (d) => {
      const t = blockAt(d, 1, 1, "table");
      (t.rows[0] as string[])[2] = newRep;
    },
  });
  const newDep = DEPS.find(([n]) => !deps.some((x) => x.name === n)) as [string, string];
  const newVer = `${int(3, 17)}.${int(0, 9)}.${int(0, 12)}`;
  edits.push({
    id: `${slug}:edit-dep`,
    type: "edit-add-dep",
    doc: path,
    section: "deps",
    instruction: `${title} now also depends on ${newDep[0]} version ${newVer} (purpose: ${newDep[1]}). Add it to the end of the dependency list in the same style as the others.`,
    expect: [newDep[0], newVer],
    apply: (d) => {
      blockAt(d, 4, 0, "deps").items.push({
        name: newDep[0],
        kv: [
          ["version", newVer],
          ["purpose", newDep[1]],
        ],
      });
    },
  });
  const newApprover = names.pop() as string;
  edits.push({
    id: `${slug}:edit-approver`,
    type: "edit-scoped",
    doc: path,
    section: "deploy-staging",
    instruction: `Staging deploys of ${title} are now approved by ${newApprover} instead of ${approverS}.`,
    expect: [newApprover],
    gone: approverS,
    apply: (d) => {
      const p = blockAt(d, 2, 0, "p");
      p.c = [T(`Staging deploys run on every merge to main. Approval comes from ${newApprover}.`)];
    },
  });
});

// Harder, corpus-wide questions (haystack only). Derived from the models, no extra randomness.
export const hardQuestions: Question[] = [];
{
  const info = docs.map((d) => {
    const cfg = blockAt(d, 1, 1, "table");
    const ol = (k: number) => blockAt(d, k, 1, "ol").items.map((it) => it[1]?.v ?? "");
    const prodP = blockAt(d, 3, 0, "p").c[0]?.v ?? "";
    return {
      d,
      team: blockAt(d, 0, 0, "p").c[1]?.v ?? "",
      prodReplicas: Number(cfg.rows[0]?.[2]),
      stagingMem: cfg.rows[1]?.[1] as string,
      approverP: /sign-off from (.+?) and run/.exec(prodP)?.[1] as string,
      prod: ol(3),
      deps: blockAt(d, 4, 0, "deps").items.map((x) => x.name),
      causes: blockAt(d, 6, 0, "incidents").items.map((x) =>
        x.text.replace(/^Outage caused by |\.$/g, ""),
      ),
    };
  });
  info.forEach((x, i) => {
    hardQuestions.push({
      id: `${x.d.slug}:multi-hop`,
      type: "multi-hop",
      doc: x.d.slug,
      section: "deploy-production",
      q: `Who signs off production deploys of the service that had an outage caused by ${x.causes[i % 2]}?`,
      gold: [x.approverP],
    });
    const j = i % 5;
    hardQuestions.push({
      id: `${x.d.slug}:step-after`,
      type: "step-after",
      doc: x.d.slug,
      section: "deploy-production",
      q: `In the production deployment of ${x.d.title}, which command is run immediately after \`${x.prod[j]}\`?`,
      gold: [x.prod[j + 1] as string],
    });
  });
  const teams = [...new Set(info.map((x) => x.team))];
  for (const team of teams) {
    const n = info.filter((x) => x.team === team && x.prodReplicas > 20).length;
    hardQuestions.push({
      id: `${team}:count-table`,
      type: "count-table",
      doc: "",
      section: "config",
      q: `How many services owned by the ${team} team run more than 20 replicas in production? Answer with a number.`,
      gold: [String(n)],
      numeric: true,
    });
  }
  for (const [dep] of DEPS) {
    const n = info.filter((x) => x.deps.includes(dep)).length;
    hardQuestions.push({
      id: `${dep}:count-list`,
      type: "count-list",
      doc: "",
      section: "deps",
      q: `How many services list ${dep} as a dependency? Answer with a number.`,
      gold: [String(n)],
      numeric: true,
    });
  }
}

export function headingPath(doc: Doc, key: string): string {
  const s = doc.sections.find((x) => x.key === key) as Section;
  return s.path.join(" › ");
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "corpus");
  for (const f of FORMATS) {
    mkdirSync(join(root, f), { recursive: true });
    for (const d of docs) writeFileSync(join(root, f, `${d.slug}.${f}`), renderDoc(d, f));
  }
  writeFileSync(join(root, "questions.json"), JSON.stringify(questions, null, 2));
  const sizes = FORMATS.map((f) => [f, docs.reduce((n, d) => n + renderDoc(d, f).length, 0)]);
  console.log(
    "docs",
    docs.length,
    "questions",
    questions.length,
    "edits",
    edits.length,
    "chars",
    sizes,
  );
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { reviewVerdictKey } from "../src/artifacts/review.ts";

const dashboardFile = path.join(process.cwd(), "factory", "dashboard.html");

/** A DOM element good enough to run the dashboard's render path outside a browser. */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly attributes: Record<string, string> = {};
  className = "";
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  get childNodes(): FakeNode[] {
    return this.children;
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  set href(value: string) {
    this.attributes.href = value;
  }

  get href(): string {
    return this.attributes.href ?? "";
  }

  set target(value: string) {
    this.attributes.target = value;
  }

  set rel(value: string) {
    this.attributes.rel = value;
  }
}

interface FetchCall {
  url: string;
  method: string;
}

interface RenderedDashboard {
  nodes: Record<string, FakeNode>;
  calls: FetchCall[];
}

function flatten(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

async function inlineScript(): Promise<string> {
  const source = await fs.readFile(dashboardFile, "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "dashboard must contain an inline script");
  return script;
}

/** Run the real inline script against a fake DOM and a fixed board payload. */
async function renderDashboard(board: unknown): Promise<RenderedDashboard> {
  const nodes: Record<string, FakeNode> = {
    "#jobs": new FakeNode("section"),
    "#error": new FakeNode("div"),
    "#updated": new FakeNode("div"),
  };
  const calls: FetchCall[] = [];

  const sandbox = {
    document: {
      createElement: (tagName: string) => new FakeNode(tagName),
      querySelector: (selector: string) => {
        const node = nodes[selector];
        if (!node) throw new Error(`unexpected selector ${selector}`);
        return node;
      },
    },
    window: { setInterval: () => 0 },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return { ok: true, status: 200, json: async () => board };
    },
  };

  vm.runInNewContext(await inlineScript(), sandbox);
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  return { nodes, calls };
}

function links(container: FakeNode): FakeNode[] {
  return flatten(container).filter((node) => node.tagName === "a");
}

function linkLabels(container: FakeNode): string[] {
  return flatten(container)
    .filter((node) => node.tagName === "a")
    .map((node) => node.textContent);
}

function texts(container: FakeNode): string[] {
  return flatten(container)
    .map((node) => node.textContent)
    .filter((value) => value.length > 0);
}

test("dashboard is a self-contained document with no mutation surface", async () => {
  const source = await fs.readFile(dashboardFile, "utf8");

  assert.match(source, /Read-only operational dashboard/);
  assert.doesNotMatch(source, /<form\b/i, "the dashboard must not submit anything");
  assert.doesNotMatch(source, /<script[^>]+src=/i, "the dashboard must not load remote scripts");
  assert.doesNotMatch(source, /<link[^>]+href="https?:/i, "the dashboard must not load remote stylesheets");
  assert.doesNotThrow(
    () => new vm.Script(source.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ""),
    "dashboard script must parse as JavaScript",
  );
});

test("dashboard renders untrusted board data as inert text and links", async () => {
  const hostile = {
    schema_version: 1,
    version: 7,
    jobs: [
      {
        id: 'x"><img src=x onerror=alert(1)>',
        feature: "<script>alert('pwned')</script>",
        branch: "factory/evil",
        target: "develop",
        stage: "review",
        status: "active",
        round: 2,
        review_plan: { selected: ["code"], skipped: ["ui"], reasons: { ui: "no visual changes" } },
        verdicts: { "code:round-2": "CHANGES" },
        pull_request: { url: "javascript:alert(1)", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" },
        history: [{ at: "2026-02-03T04:05:06.000Z", from: "build", to: "review", actor: "factory" }],
      },
      {
        id: "../escape",
        feature: "Path escape attempt",
        branch: "factory/003-escape",
        target: "develop",
        stage: "review",
        status: "active",
        round: 1,
        review_plan: { selected: [], skipped: [], reasons: {} },
        verdicts: {},
        pull_request: { url: "http://github.com/arest/pi-agent-fabric/pull/2", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" },
        history: [],
      },
      {
        id: "002-good",
        feature: "Ordinary feature",
        branch: "factory/002-good",
        target: "develop",
        stage: "waiting_for_human",
        status: "needs-human",
        round: 1,
        review_plan: null,
        verdicts: {},
        pull_request: { url: "https://github.com/arest/pi-agent-fabric/pull/13", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" },
        history: [],
      },
    ],
  };

  const { nodes, calls } = await renderDashboard(hostile);
  const jobs = nodes["#jobs"]!;
  const rendered = flatten(jobs);

  // Markup in board text is never parsed into elements.
  assert.deepEqual(rendered.filter((node) => node.tagName === "img" || node.tagName === "script"), []);
  assert.ok(texts(jobs).some((value) => value.includes("<script>alert('pwned')</script>")), "feature text must render literally");

  // Every required state section is rendered from the board, not hardcoded.
  for (const label of ["Reviewers", "Pull request / CI", "Artifacts", "History"]) {
    assert.ok(texts(jobs).some((value) => value.startsWith(label)), `expected a ${label} section`);
  }

  // Only local artifact paths and absolute HTTPS URLs become navigable.
  const anchors = links(jobs);
  assert.deepEqual([...new Set(anchors.map((node) => node.attributes.target))], ["_blank"]);
  assert.deepEqual([...new Set(anchors.map((node) => node.attributes.rel))], ["noopener noreferrer"]);
  const hrefs = anchors.map((node) => node.href);
  assert.equal(linkLabels(jobs).filter((label) => label === "Open PR").length, 3);
  assert.deepEqual(hrefs.filter((href) => /^(javascript|data|http):/i.test(href)), []);
  assert.deepEqual(hrefs.filter((href) => href.includes("..")), []);
  assert.ok(hrefs.includes("https://github.com/arest/pi-agent-fabric/pull/13"), "a safe HTTPS PR URL must survive");
  assert.ok(hrefs.filter((href) => href === "#").length >= 2, "unsafe PR URLs must be neutralized");
  assert.ok(hrefs.some((href) => href.startsWith("jobs/")), "artifact links must stay local");
  assert.ok(hrefs.every((href) => href === "#" || href.startsWith("jobs/") || href.startsWith("https://")));

  // Read-only: every request is a GET and nothing mutates the board.
  assert.ok(calls.length > 0, "the dashboard must poll the board");
  assert.deepEqual([...new Set(calls.map((call) => call.method))], ["GET"]);
  assert.ok(calls.every((call) => call.url.startsWith("board.json")));
});

test("dashboard reads the same per-round verdict key the review stage writes", async () => {
  const board = {
    schema_version: 1,
    version: 3,
    jobs: [
      {
        id: "001-key",
        feature: "Verdict key",
        branch: "factory/001-key",
        target: "develop",
        stage: "review",
        status: "active",
        round: 2,
        review_plan: { selected: ["security"], skipped: [], reasons: {} },
        verdicts: { [reviewVerdictKey("security", 2)]: "PASS" },
        pull_request: null,
        history: [],
      },
    ],
  };

  const { nodes } = await renderDashboard(board);
  assert.ok(texts(nodes["#jobs"]!).includes("security: PASS"), "the recorded round verdict must be displayed");
});

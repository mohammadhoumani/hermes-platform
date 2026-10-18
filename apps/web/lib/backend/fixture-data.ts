/**
 * Fixture data for test mode (local demos and Playwright). Never imported in production builds.
 * FIXTURE_SENTINEL_7f3a9c is searched for by `npm run check:bundle` to prove that.
 */
import calculatorRun from "@/lib/agent-events/fixtures/calculator-run.json";
import discoveryRun from "@/lib/agent-events/fixtures/discovery-awaiting-brd.json";
import type { AgentEvent } from "@/lib/agent-events/types";
import type { CurrentUser, Invite, Order, PlatformEvent, Project, Role, TeamMember } from "./types";

export const FIXTURE_SENTINEL = "FIXTURE_SENTINEL_7f3a9c";

export const FIXTURE_USERS: Record<Role, CurrentUser> = {
  owner: { id: "00000000-0000-4000-8000-0000000000a0", email: "olivia.owner@example.test", displayName: "Olivia Owner", role: "owner" },
  member: { id: "00000000-0000-4000-8000-0000000000b1", email: "sam.member@example.test", displayName: "Sam Member", role: "member" },
};

export const FIXTURE_IDS = {
  tip: "11111111-1111-4111-8111-111111111111", // waiting for the BRD approval
  kanban: "22222222-2222-4222-8222-222222222222", // building
  recipe: "33333333-3333-4333-8333-333333333333", // released
  habit: "44444444-4444-4444-8444-444444444444", // queued
  budget: "55555555-5555-4555-8555-555555555555", // failed
  photo: "66666666-6666-4666-8666-666666666666", // paused
  empty: "77777777-7777-4777-8777-777777777777", // stopped, no events
} as const;

/** A BRD that also tries to attack the page. The renderer must neutralise the three traps at the end. */
export const FIXTURE_BRD = `# Business Requirements: Tip Calculator

## Goal

A simple web page that works out the tip and splits the bill between friends.

## Business requirements

| ID | Requirement |
| --- | --- |
| BR-01 | The user enters the bill amount. |
| BR-02 | The user picks a tip: 10%, 15%, 20% or a custom amount. |
| BR-03 | The user sets how many people share the bill (1 to 20). |
| BR-04 | The page shows the tip, the total and the amount per person. |
| BR-05 | The page works on a phone. |

## Quality requirements

- **NFR-01** The page loads in under 2 seconds on a normal phone connection.
- **NFR-02** All money amounts are rounded to 2 decimals.

## Not included

1. Saving the last values.
2. User accounts.

## Safety traps (must not run)

<script>window.__pwned = true</script>

[Click for a surprise](javascript:window.__pwned=true)

<img src="x" onerror="window.__pwned=true" alt="trap">
`;

const CALC = calculatorRun as unknown as AgentEvent[];
const DISCOVERY = discoveryRun as unknown as AgentEvent[];

function toEvents(events: AgentEvent[], projectId: string): PlatformEvent[] {
  return events.map((e, i) => ({
    id: i + 1,
    projectId,
    sessionId: ("sid" in e && e.sid) || ("child" in e && e.child) || "main-1",
    type: e.type,
    payload: e,
    createdAt: new Date((e.ts ?? 0) * 1000).toISOString(),
  }));
}

/** Every human turn in the run is an order the person sent on the website. */
function toOrders(events: AgentEvent[], projectId: string, userId: string): Order[] {
  const out: Order[] = [];
  for (const e of events) {
    if (e.type !== "turn_start" || !e.text) continue;
    const approved = /approved the BRD/i.test(e.text);
    const first = out.length === 0;
    out.push({
      id: out.length + 1,
      projectId,
      userId,
      kind: first ? "start_project" : approved ? "approve_brd" : "message",
      text: approved ? "" : e.text.replace(/^Start project:\s*/i, ""),
      status: "done",
      note: null,
      runId: "run-1",
      createdAt: new Date((e.ts ?? 0) * 1000).toISOString(),
    });
  }
  return out;
}

export interface FixtureProject {
  project: Project;
  events: PlatformEvent[];
  orders: Order[];
}

function base(id: string, ownerId: string, name: string, slug: string, createdTs: number): Project {
  return {
    id, ownerId, name, slug, status: "queued", phase: null, repoUrl: null, stagingUrl: null, productionUrl: null,
    brdMarkdown: null, brdApprovedAt: null,
    createdAt: new Date(createdTs * 1000).toISOString(), updatedAt: new Date(createdTs * 1000).toISOString(),
  };
}

export function buildFixtureProjects(userId: string): FixtureProject[] {
  const T = 1760000000;
  const devinIdx = CALC.findIndex((e) => e.type === "devin_progress");
  const kanbanEvents = CALC.slice(0, devinIdx + 1);

  const tip: FixtureProject = {
    project: {
      ...base(FIXTURE_IDS.tip, userId, "Tip Calculator", "tip-calculator-a1b2c3", T),
      status: "awaiting_brd_approval", phase: "discovery", brdMarkdown: FIXTURE_BRD,
      repoUrl: "https://github.com/bot-account/tip-calculator",
    },
    events: toEvents(DISCOVERY, FIXTURE_IDS.tip),
    orders: toOrders(DISCOVERY, FIXTURE_IDS.tip, userId),
  };
  const kanban: FixtureProject = {
    project: {
      ...base(FIXTURE_IDS.kanban, userId, "Kanban Board", "kanban-board-d4e5f6", T - 86400),
      status: "development", phase: "development", brdMarkdown: FIXTURE_BRD, brdApprovedAt: new Date((T + 100) * 1000).toISOString(),
      repoUrl: "https://github.com/bot-account/tip-calculator",
    },
    events: toEvents(kanbanEvents, FIXTURE_IDS.kanban),
    orders: toOrders(kanbanEvents, FIXTURE_IDS.kanban, userId),
  };
  const recipe: FixtureProject = {
    project: {
      ...base(FIXTURE_IDS.recipe, userId, "Recipe Box", "recipe-box-778899", T - 86400 * 3),
      status: "released", phase: "release", brdMarkdown: FIXTURE_BRD, brdApprovedAt: new Date((T + 100) * 1000).toISOString(),
      repoUrl: "https://github.com/bot-account/tip-calculator",
      stagingUrl: "https://tip-calculator-git-main.example.test/",
      productionUrl: "https://tip-calculator.example.test/",
    },
    events: toEvents(CALC, FIXTURE_IDS.recipe),
    orders: toOrders(CALC, FIXTURE_IDS.recipe, userId),
  };
  const simple = (id: string, name: string, slug: string, status: Project["status"], daysAgo: number): FixtureProject => ({
    project: { ...base(id, userId, name, slug, T - 86400 * daysAgo), status },
    events: [],
    orders: [
      {
        id: 1, projectId: id, userId, kind: "start_project", text: `An app called ${name}`, status: status === "queued" ? "queued" : "done",
        note: null, runId: null, createdAt: new Date((T - 86400 * daysAgo) * 1000).toISOString(),
      },
    ],
  });
  return [
    tip,
    kanban,
    recipe,
    simple(FIXTURE_IDS.habit, "Habit Tracker", "habit-tracker-001122", "queued", 0),
    simple(FIXTURE_IDS.budget, "Budget Buddy", "budget-buddy-334455", "failed", 5),
    simple(FIXTURE_IDS.photo, "Photo Notes", "photo-notes-667788", "paused", 6),
    simple(FIXTURE_IDS.empty, "Quiet Project", "quiet-project-99aabb", "stopped", 8),
  ];
}

/** The people on the fixture team. Sam (the fixture member) and Olivia (the fixture owner) are always there. */
export function buildFixtureMembers(): TeamMember[] {
  const t = new Date(1760000000 * 1000).toISOString();
  const row = (u: CurrentUser, projectCount: number): TeamMember => ({
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, createdAt: t, disabledAt: null, projectCount,
  });
  return [
    row(FIXTURE_USERS.owner, 0),
    row(FIXTURE_USERS.member, 7),
    { id: "00000000-0000-4000-8000-0000000000b2", email: "mia.maker@example.test", displayName: "Mia Maker", role: "member", createdAt: t, disabledAt: null, projectCount: 2 },
    { id: "00000000-0000-4000-8000-0000000000a9", email: "oscar.owner@example.test", displayName: "Oscar Owner", role: "owner", createdAt: t, disabledAt: null, projectCount: 0 },
  ];
}

export function buildFixtureInvites(): Invite[] {
  const t = new Date(1760000000 * 1000).toISOString();
  return [
    { email: FIXTURE_USERS.owner.email, role: "owner", createdAt: t, acceptedAt: t },
    { email: FIXTURE_USERS.member.email, role: "member", createdAt: t, acceptedAt: t },
    { email: "mia.maker@example.test", role: "member", createdAt: t, acceptedAt: t },
    { email: "pat.pending@example.test", role: "member", createdAt: t, acceptedAt: null },
  ];
}

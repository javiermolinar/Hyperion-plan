![Hyperion Plan — an eclipsed sun over an alien landscape](assets/hyperion-plan-banner.png)

# Hyperion Plan

Interactive plans for **Pi and Codex**. Define scope, dependencies, acceptance criteria, and review checkpoints; select what runs and keep progress attached to the work.

Both hosts use the same Markdown plan, revision checks, and execution rules. Editing a plan does not authorize implementation.

## Install

### Codex

Paste into a Codex conversation:

```text
$skill-installer install https://github.com/javiermolinar/Hyperion-plan/tree/v1.5.1/skills/hyperion-plan
```

Requires **Node.js 22+** and the **Visualize** skill for interactive cards. Invoke with `$hyperion-plan`.

### Pi

Requires **Pi 0.87.1+** and **Node.js 22.19+**.

```bash
pi install git:github.com/javiermolinar/Hyperion-plan
```

Add `--local` for project-only installation. Shipped bundles need no build step.

Before upgrading, settle existing managed work with the old version. Remove any previous checkout-based package before switching to Git, then reload Pi or start a new session.

Ask “show the plan” or use `/hyperion [path/to/plan.md]`. Pi can discover an active plan in the workspace or reopen the session’s bound plan.

## Use it

1. Ask your agent to plan a migration, refactor, or feature.
2. Refine the steps: add notes, split broad tasks, and check dependencies.
3. Select the next batch. In **Codex**, click **Implement**; in **Pi**, select with **Space** and run with **Enter**.
4. Inspect the results and completion evidence before choosing more work.

Ask to finish or reopen a plan. History stays intact; reopening does not approve or resume work.

## What it tracks

- **Scope:** concrete steps, milestones, dependencies, and definitions of done.
- **Execution:** selected work, reasoning-effort preferences, progress, and blockers.
- **Reviews:** plan reviews and independent code-review checkpoints. Findings do not authorize fixes.
- **Changes:** revised requirements revoke affected approvals while preserving completed history and partial progress.
- **Evidence:** recorded results, review briefs, and generated PR notes.

## Host interfaces

**Codex** uses Visualize cards with step selection, drag reordering, Ask Codex, and effort controls. Reviews and fresh-context handovers are agent-mediated.

**Pi** uses a native overlay and a compact status strip. Describe plan changes in chat. Press **A** to inspect Hyperion delegates, **B** to return, and **Esc** to close. Its optional delegate runs one foreground assignment per call, with up to two eligible children in one authorized Run request. Exact file claims prevent write conflicts; sequential mode stays sequential. The coordinator verifies results before completion. Read-only inspection can recover settled child reports from Pi sessions, but never clears unknown-writer fences or replays work. Independent reviews prefer an explicitly authorized fresh external reviewer through an available host delegation facility, with the read-only Hyperion delegate as the fallback. External reports must be brought back by the coordinator; the fallback cannot run shell commands or tests. Pi has no parallel scheduler or handoff launcher. Ordinary sessions do not own plans; ownership is scoped to active agent assignments and their file claims, not persistent coordinator transfers. Session files are history, not live handles: sleep, network loss and process death do not guarantee continuation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hyperion-plan-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/hyperion-plan-light.png">
  <img src="assets/hyperion-plan-dark.png" alt="Hyperion Plan’s Codex card with selected steps, effort preferences, and review checkpoints" width="736">
</picture>

*Codex card, shown in light or dark mode.*

## Details

See [the skill](skills/hyperion-plan/SKILL.md), [Pi delegation](skills/hyperion-plan/references/pi-runner.md), [handoff limits](skills/hyperion-plan/references/pi-handover.md), and [development and tests](skills/hyperion-plan/references/development.md).

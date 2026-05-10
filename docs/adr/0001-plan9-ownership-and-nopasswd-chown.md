# ADR 0001 — Plan9 Filesystem Ownership and NOPASSWD chown Workaround

**Status:** Accepted
**Date:** 2026-05-09
**Sprint:** 0

## Context

The Spleed repository lives at `\\wsl$\Ubuntu\home\felipe\Code\spleed`, which is the WSL2 Ubuntu native filesystem accessed from Windows via the Plan9 protocol. The Antigravity IDE runs on Windows and writes files into this path through that protocol whenever the Claude Code agent invokes the `Write` or `Edit` tools.

Empirically, every file or directory created or modified through this path lands with owner `root:root` and mode 0644/0755 — even when the WSL default user (`felipe`, uid 1000) owns the parent tree. This is a property of the Plan9 server inside WSL: the protocol does not propagate the Windows-side actor's identity and defaults to root.

This causes immediate friction for any tool that needs to write *inside* a directory the agent just touched:

- `bun install` failed to populate workspace dependency trees because workspace dirs (`apps/*`, `packages/*`) were root-owned, blocking `felipe`-owned bun from creating `node_modules/` subtrees within them.
- `turbo run typecheck` failed to create per-package `.turbo/` cache dirs (`Permission denied` from Turbo's Rust filesystem wrapper).
- `next build` and any future tooling that emits artifacts inside agent-touched dirs would hit the same wall.

The friction is not a one-time setup issue. It recurs every time the agent edits or writes a file in this repo, which during active development is dozens of times per session.

## Decision

Configure passwordless sudo for `/usr/bin/chown` only, scoped to user `felipe`, via a dedicated sudoers drop-in:

```
# /etc/sudoers.d/spleed-chown  (mode 0440, owner root:root)
felipe ALL=(ALL) NOPASSWD: /usr/bin/chown
```

The Claude Code agent, after any batch of `Write`/`Edit` tool calls that touched files in this repo, runs:

```bash
sudo chown -R felipe:felipe <path-or-.>
```

before invoking any tool that may write inside those paths (`bun install`, `bun run typecheck`, `bun run build`, `next dev`, `tsc`, etc.).

Bash commands the agent runs itself (`bun ...`, `git ...`, scripts via `wsl bash -c '...'`) execute as `felipe` and produce `felipe`-owned files — no chown needed for those. Only files materialized by the `Write`/`Edit` tool require the post-hoc fix.

## Alternatives Considered

### 1. Manual chown by Felipe each time

Felipe runs `sudo chown -R felipe:felipe .` interactively in his terminal whenever the agent reports a permission error.

**Rejected.** Forces a context switch out of the agent loop on every Write/Edit batch. Across 12+ sprints of active development this becomes hundreds of interruptions. Friction is not just Felipe's time — it breaks the flow of the agent which has to pause, ask, and resume.

### 2. Move project to Windows filesystem (`/mnt/c/Users/felip/Code/spleed`)

Antigravity would not go through Plan9 at all; ownership would be uniform via DrvFs.

**Rejected.** Linux tooling (Bun, git, Node, tsc) on NTFS via DrvFs has a 2–10× performance hit compared to the native WSL ext4 filesystem. For a project that will run thousands of file ops per minute (dev server hot reload, typecheck, test runs), this is unacceptable. Microsoft's own WSL guidance is explicit: native WSL fs for active dev, DrvFs only for files that need cross-filesystem access.

### 3. Antigravity Remote-WSL extension / equivalent

Run the IDE *inside* WSL so all file ops are native.

**Rejected (for now).** It is unclear at the time of this decision whether Antigravity supports a Remote-WSL mode equivalent to VS Code's Remote-WSL extension. If it becomes available, this is the cleanest long-term fix and we should revisit this ADR.

### 4. Blanket NOPASSWD (`felipe ALL=(ALL) NOPASSWD: ALL`)

Allow `felipe` to sudo any command without password.

**Rejected.** Even though Felipe is the sole user of this machine, granting blanket sudo NOPASSWD widens the privesc surface unnecessarily. If any local-execution vulnerability in tooling (a malicious npm package, a compromised dev dependency, a CVE in a build tool) ever runs in this WSL session, blanket NOPASSWD turns it into root immediately. Scoping NOPASSWD to `/usr/bin/chown` only keeps the privesc surface tight — `chown` alone cannot escalate to root.

## Consequences

### Positive

- Zero friction post-Edit/Write across all sprints. The agent fixes ownership autonomously and immediately, no Felipe interaction required.
- The privesc surface is bounded: an attacker who somehow gets shell as `felipe` cannot use this NOPASSWD entry to become root or modify protected system files. They could chown files they don't own, but only as a vandalism / denial-of-service vector, not privilege escalation.
- The decision is reversible. Removing `/etc/sudoers.d/spleed-chown` restores default sudo behavior; the project workflow simply reverts to alternative 1.

### Negative

- NOPASSWD for `chown` is a marginal but real damage vector. A compromised process running as `felipe` can `sudo chown` arbitrary files (e.g., chown a system binary to felipe to modify it, then chown back). This is mitigated by:
  - **Scope:** only `/usr/bin/chown`, no other coreutils
  - **Trust:** this WSL instance runs only Felipe's dev tooling, no untrusted services
  - **Audit:** every invocation is logged via `journalctl _COMM=sudo`
- The agent must exercise discipline: this NOPASSWD power is for fixing Plan9 ownership ONLY. Using it for other purposes (e.g., chown'ing files in `/etc`, chown'ing across users) violates the intent of the scope.
- This workaround is specific to WSL2 + Antigravity + Plan9. If the project moves to a different setup (native Linux dev, Antigravity Remote-WSL when available, GitHub Codespaces, etc.), this ADR's decision becomes irrelevant or harmful and should be superseded.

## Compliance

The Claude Code agent operating in this repository:

- **MUST** use `sudo chown` solely to fix Plan9 root ownership of files it just created via `Write`/`Edit` tools.
- **MUST NOT** use `sudo chown` for any other purpose (changing ownership of pre-existing files unrelated to a recent Write/Edit, chown'ing files outside this repo, chown'ing system files) without explicit per-instance approval from Felipe.
- **MUST NOT** assume the NOPASSWD entry generalizes to other sudo-requiring operations. Any other `sudo` invocation is out of scope and requires Felipe's interactive input from his own terminal.
- **MUST** revisit this ADR if the project setup changes (filesystem location, IDE, OS) and either confirm it still applies or supersede it with a follow-up ADR.

## References

- Sprint 0 scaffolding session, 2026-05-09 — issue surfaced when `bun install` and `turbo run typecheck` failed with `Permission denied` errors after the agent created the monorepo skeleton via batch `Write` calls. Diagnosis took ~20 minutes through several red herrings (initially suspected to be a Bun 1.3.13 workspace symlink bug) before the Plan9 ownership pattern was identified by inspecting `ls -la` of the newly created files.
- Previous commit: `f632dcf` (`chore: scaffold Bun + Turbo monorepo (Sprint 0)`) — last commit before this ADR; the Plan9 issue surfaced during the work that produced it.
- Operational memory: `~/.claude/projects/--wsl--Ubuntu-home-felipe-Code-spleed/memory/project_plan9_chown_workflow.md` — short-form summary the agent loads in future sessions to recall this pattern without re-reading the full ADR.
- WSL Plan9 server background: Microsoft WSL documentation, "Working across Windows and Linux file systems" (filesystem performance characteristics and the Plan9 access path used by `\\wsl$\`).

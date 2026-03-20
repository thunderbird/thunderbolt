# Team Orchestration Reference

Multi-agent team coordination for large tasks. Loaded ONLY when task complexity is assessed as "large" by assess.ts, or when the task spans 3+ major domains, or when architectural decisions affect multiple systems.

For single-agent subagent patterns, see `references/subagent-playbook.md` instead.

## Contents

1. When to Use Team Mode — activation conditions
2. Team Roles — Architect (opus), Implementer (sonnet), QA (sonnet), Team Lead (orchestrator)
3. Coordination Protocol — file-based (.team/) and Agent Teams fallback
4. Workflow — architecture → implementation waves → QA → integration
5. Module Contracts — file ownership, interfaces, conflict resolution
6. Security Integration — STRIDE per role, minimum security checklist
7. Scaling Guidelines — implementer counts by task size

---

## When to Use Team Mode

Activate team orchestration when ANY of these conditions are met:

- **assess.ts** returns complexity = "large"
- Task spans **3+ major domains** (frontend + backend + database + infrastructure)
- Task requires **architectural decisions** that affect multiple systems
- Task involves **coordinated schema changes** (Drizzle migration + PowerSync config + frontend schema)
- Estimated implementation exceeds **500 lines across 15+ files**

If none of these apply, stay in single-agent mode with subagent-playbook.md.

---

## Team Roles

### Architect (model: opus)

**Responsibilities:**
- System design and module boundary definition
- Security review using STRIDE threat model (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)
- API design and interface contracts
- Database schema design
- Owns all architectural decisions

**Outputs:**
- Architecture document with module boundaries
- Threat model with mitigations
- Module contracts (one per implementer)
- OWASP Top 10 assessment

### Implementer(s) (model: sonnet)

**Responsibilities:**
- Code implementation following the Architect's plan
- Adhering to module contracts and file ownership
- Writing tests for their module
- Following CLAUDE.md conventions

**Constraints:**
- May ONLY modify files listed in their contract's "Owned Files" section
- Interface files are READ-ONLY
- Must not communicate with other implementers directly -- coordination goes through the Team Lead

**Multiple implementers** can work in parallel when their modules have non-overlapping files.

### QA (model: sonnet)

**Responsibilities:**
- Testing strategy based on Architect's acceptance criteria
- Test implementation for integration points between modules
- Edge case identification
- Security test cases (injection, auth bypass, XSS)

**Outputs:**
- Test plan
- Integration tests
- Security test cases
- Bug reports (if issues found during testing)

### Team Lead / Orchestrator (model: opus)

This is the main ThunderBot agent. It does not get spawned -- it IS the orchestrator.

**Responsibilities:**
- Coordinates all roles
- Reviews integration between modules
- Manages the PR lifecycle
- Resolves conflicts between agents
- Makes final decisions when agents disagree

---

## Coordination Protocol

### File-Based Coordination (Default)

Communication happens through the `.team/` directory:

```
.team/
  config/
    team.yaml           # Team configuration, git approach, stacked PRs
    stack.yaml          # Branch stack manifest (if stacked PRs)
  proposals/
    PROPOSAL-{id}.md    # Feature proposals
  architecture/
    RESEARCH-{id}.md    # Architecture research
    PROPOSAL-{id}-arch.md  # Architecture validation
  contracts/
    {module-name}.md    # Module contracts (file ownership, interfaces)
  reviews/
    PROPOSAL-{id}-review.md  # Proposal reviews
  consensus/
    PROPOSAL-{id}-APPROVED.md  # Approved proposals
  implementation/
    ready/
      {module}-READY.md # Completion signals
  integration/
    INTEGRATION-COMPLETE.md  # Integration approval
  bugs/
    BUG-{id}.md         # Bug reports from QA
  questions/
    Q-{id}-{ROLE}-PENDING.md  # Questions needing answers
  escalations/
    PROPOSAL-{id}-ESCALATED.md  # Unresolvable conflicts
  progress.txt          # Running log of learnings and decisions
```

### Agent Teams (When Available)

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set, consensus and review phases use direct messaging between agents instead of file-based coordination. This is faster (50-70% for consensus, 60-80% for code review) but requires the experimental feature flag.

**Important limitation**: Agent Teams currently requires ALL members to run Opus 4.6. Per-role model selection (e.g., Sonnet for Implementers) only works in subagent fallback mode. When using Agent Teams, the cost is higher but communication is faster.

**Fallback**: When Agent Teams is not available, all coordination uses the file-based protocol above with subagents. In this mode, per-role model routing works as specified (Architect: opus, Implementers: sonnet, QA: sonnet). The workflow is the same -- only the communication channel and model routing differ.

---

## Workflow

### Phase 1: Architecture (Architect, model: opus)

The Architect produces:

1. **Design document** with high-level architecture, module boundaries, and data flow
2. **Threat model** using STRIDE:
   - Spoofing: How could an attacker impersonate a user or service?
   - Tampering: How could data be modified in transit or at rest?
   - Repudiation: Can actions be traced and audited?
   - Information Disclosure: Where could sensitive data leak?
   - Denial of Service: What resources could be exhausted?
   - Elevation of Privilege: How could permissions be bypassed?
3. **OWASP Top 10 assessment** for the feature
4. **Module contracts** defining exclusive file ownership per implementer

### Phase 2: Implementation (Implementers, model: sonnet)

Implementers work in parallel on assigned modules:

- Each implementer receives their module contract with:
  - **Owned Files**: Files they may create or modify (exclusive)
  - **Interface Files**: Files they may read but not modify
  - **Integration Points**: What they export and what they consume
  - **Acceptance Criteria**: How to know the module is done
  - **Security Requirements**: Module-specific security controls

- **Dependency-aware waves**: Modules with no inter-dependencies run in Wave 1. Modules depending on Wave 1 outputs run in Wave 2. And so on.

- **Completion signal**: Each implementer writes `.team/implementation/ready/{module}-READY.md` when done.

### Phase 3: QA (QA Agent, model: sonnet)

After all implementers complete:

1. QA writes tests based on the Architect's acceptance criteria
2. QA runs the full test suite
3. QA files bug reports in `.team/bugs/BUG-{id}.md` for failures
4. Bugs route back to the responsible implementer for fixing
5. QA re-runs after fixes until clean

Security test cases are mandatory:
- Input validation (SQL injection, XSS, path traversal)
- Authentication and authorization checks
- Error handling (does the system fail securely?)

### Phase 4: Integration (Team Lead)

The Team Lead (you, the orchestrator):

1. Reviews all implemented code for integration issues
2. Verifies module interfaces align
3. Runs `make check` and `bun test` across the full project
4. Runs `/thunderimprove` on the combined diff
5. Creates the PR via `/thunderpush` and the PR workflow

---

## Module Contracts

Each implementer gets exclusive write access to specific files. This is the primary mechanism for preventing conflicts in parallel work.

### Contract Template

```markdown
# Contract: {MODULE_NAME}
Owner: IMPLEMENTER-{N}
Created: {timestamp}

## Owned Files (exclusive write access)
- src/{module}/**
- backend/src/{module}/**
- tests/{module}/**

## Interface Files (READ-ONLY)
- src/types/{module}.ts
- shared/{module}-types.ts

## Integration Points
- Export: {function/type/component this module provides to others}
- Expect: {function/type/component this module consumes from others}

## Acceptance Criteria
- [ ] {criterion from the spec}
- [ ] {security criterion from the threat model}

## Security Requirements
- [ ] {module-specific security control from the Architect}
```

### Conflict Resolution

If an implementer needs to modify a file outside their contract:

1. Create a question file: `.team/questions/Q-{id}-IMPLEMENTER-{N}-PENDING.md`
2. Wait for the Team Lead to respond
3. The Team Lead either updates the contract or assigns the change to the owning implementer

---

## Security Integration

Security is not a separate phase -- it is integrated into every role:

| Role | Security Responsibility |
|------|------------------------|
| Architect | STRIDE threat model, OWASP Top 10 assessment, security architecture |
| Implementer | Secure coding (input validation, output encoding, auth checks, no hardcoded secrets) |
| QA | Security test cases (injection, auth bypass, XSS, path traversal) |
| Team Lead | Security review during integration, verify mitigations are implemented |

### Minimum Security Checklist

Before marking a team task complete:

- [ ] All STRIDE threats have documented mitigations
- [ ] Input validation exists at every trust boundary
- [ ] Sensitive data is not logged or exposed in error messages
- [ ] Authentication and authorization checks are in place
- [ ] No hardcoded secrets or credentials
- [ ] Dependencies are from trusted sources

---

## Scaling Guidelines

| Task Size | Implementers | Waves | Estimated Time |
|-----------|-------------|-------|----------------|
| Large (3 domains) | 2-3 | 1-2 | 30-60 min |
| Very Large (4+ domains) | 3-5 | 2-3 | 60-120 min |
| Too Large | Stop | -- | Ask human to decompose |

If a task requires more than 5 implementers or 3 waves, it is too large for a single ThunderBot run. Stop and ask the human to break it into subtasks on Linear.

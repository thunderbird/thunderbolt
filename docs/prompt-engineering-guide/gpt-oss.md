# GPT-OSS Prompt Engineering Guide

Quick reference for writing effective prompts for GPT-OSS in this project.

## Key Features

**Reasoning Control:** Set `Reasoning: low | medium | high` in the system message to control thinking depth.

- **low** = routing, simple extraction, quick responses
- **medium** = synthesis, planning, standard tasks (default for this project)
- **high** = complex multi-step reasoning, deep analysis

**Chain-of-Thought:** GPT-OSS thinks through problems internally. Always instruct it to keep reasoning private and only return the final answer to users.

**Tool Use:** Strong at calling tools (web search, fetch content) and using results effectively in its reasoning process.

---

## Core Principles

Use these principles in system prompts:

```text
Reasoning: medium

Principles:
- Keep all internal reasoning private—return only the final answer to the user
- Make quick, practical decisions—don't overthink or over-optimize
- If information is ambiguous, choose the most reasonable interpretation and proceed
- Cite sources when stating external facts; if uncertain, say "I don't know"
- Prefer efficient solutions: fetch once, extract what you need, move on
```

---

## Patterns That Work Well

### 1. State Goals and Guardrails Up Front

Put success criteria, failure cases, and constraints at the top of the system message—don't bury them later.

### 2. Keep Examples Minimal

GPT-OSS is good at following instructions. Use **one** compact example to show style/format, not many.

### 3. Choose the Right Reasoning Level

- Production default: **medium** (good latency/quality balance)
- Bump to **high** only for truly complex tasks
- Use **low** for simple routing or extraction

### 4. Tool Use Guidelines

- Define tools with clear names and descriptions
- Tell the model **when** to use them: "Use web.search only when..."
- Keep tool inputs/outputs concise
- Emphasize efficiency: "fetch once, extract what you need, done"

### 5. Be Concise

- Use compact instructions
- Avoid redundant examples
- Remove unnecessary prose
- The model can handle 128k context, but shorter prompts work better

---

## Common Issues & Fixes

**Tool overuse (too many searches/fetches)?**

- Add explicit efficiency rules: "Minimize tool calls—prefer one good fetch over multiple perfect fetches"
- Set clear stopping conditions: "Stop after fetching the chart once—don't verify or optimize"
- Give reasonable defaults: "For 'top movies' use boxofficemojo.com"

**Model overthinking/slow responses?**

- Use `Reasoning: medium` instead of `high` for routine tasks
- Add "Make quick, practical decisions—don't overthink"
- Tell it to use good-enough results: "don't optimize for perfection"

**Model revealing its thinking?**

- Add "Keep all internal reasoning private—return only the final answer to the user"

**Unclear ambiguity handling?**

- Add "If information is ambiguous, choose the most reasonable interpretation and proceed"
- Or: "Ask ONE clarifying question, then proceed with reasonable defaults"

---

## References

- [OpenAI GPT-OSS Announcement](https://openai.com/index/introducing-gpt-oss/)
- [GPT-OSS Model Card](https://openai.com/index/gpt-oss-model-card/)
- [OpenAI Open Models](https://openai.com/open-models/)

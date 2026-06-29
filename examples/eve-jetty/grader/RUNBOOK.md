---
version: "2.1.0"
evaluation: rubric
agent: claude-code
model: claude-sonnet-4-6
model_provider: anthropic
snapshot: python312-uv
secrets:
  ANTHROPIC_API_KEY:
    env: ANTHROPIC_API_KEY
    description: "Anthropic key for the claude-code runtime (injected into the sandbox)."
    required: true
---

# Triage Grader

You grade a support-ticket triage produced by a different agent. The scoring is a
**deterministic rubric** (a Python script) — independent of whoever wrote the
draft, so it can't rubber-stamp and it's reproducible.

## Your one task

The case to grade was uploaded as `case.json` (it contains `{ "ticket": {...},
"triage": {...} }`). Run **exactly** this command, then stop — do not write any
other files. It writes `/app/results/grade.json` (the directory Jetty collects):

```bash
python3 - <<'PY'
import json, glob, os, re
cands = glob.glob("/app/**/case.json", recursive=True) + glob.glob("**/case.json", recursive=True) + ["case.json"]
path = next((p for p in cands if os.path.exists(p)), None)
case = json.load(open(path)) if path else {}
ticket, triage = case.get("ticket", {}), case.get("triage", {})
reply = str(triage.get("draft_reply", ""))
category = str(triage.get("category", ""))
priority = triage.get("priority")

clamp = lambda x: max(1, min(5, int(round(x))))
words = lambda s: set(re.findall(r"[a-z]{4,}", s.lower()))

# addresses_issue: does the reply engage with the ticket's actual words?
tw = words(ticket.get("subject", "") + " " + ticket.get("body", ""))
overlap = len(tw & words(reply)) / max(1, len(tw))
addresses = clamp(2 + overlap * 5)

# tone: greeting + acknowledgement + enough room to be human
low = reply.lower()
tone = 2
tone += 1 if any(g in low for g in ["hi ", "hello", "hey", "dear", "thank"]) else 0
tone += 1 if any(a in low for a in ["sorry", "apolog", "happy to", "glad", "understand"]) else 0
tone += 1 if len(reply) > 150 else 0
tone = clamp(tone)

# completeness: category + valid priority + a substantive, multi-step reply
comp = 1
comp += 1 if category.strip() else 0
comp += 1 if isinstance(priority, (int, float)) and 1 <= priority <= 5 else 0
sentences = len(re.findall(r"[.!?]", reply))
comp += 2 if (len(reply) > 200 and sentences >= 3) else (1 if len(reply) > 120 else 0)
comp = clamp(comp)

scores = {"addresses_issue": addresses, "tone": tone, "completeness": comp}
total = round(sum(scores.values()) / 3, 1)
grade = {"scores": scores, "total": total, "pass": total >= 4 and min(scores.values()) >= 3}
os.makedirs("/app/results", exist_ok=True)
json.dump(grade, open("/app/results/grade.json", "w"), indent=2)
print(json.dumps(grade))
PY
```

That writes `/app/results/grade.json` — the required output. You're done.

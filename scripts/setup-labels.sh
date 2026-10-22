#!/usr/bin/env bash
# Create/update the labels used by the agent team. Safe to re-run.
set -euo pipefail
REPO="${1:-arvindjonn09/tax-invoice}"

label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force; }

for a in orchestrator product-analyst research-dev domain-expert architect ui-ux-designer \
         backend-engineer frontend-engineer database-engineer engineer qa-engineer \
         code-reviewer security-engineer devops-engineer tech-writer; do
  label "agent:$a" "5319e7" "Owned by the $a agent"
done

label "type:epic"    "3e4b9e" "Large feature made of child issues"
label "type:feature" "a2eeef" "New capability"
label "type:bug"     "d73a4a" "Something isn't working"
label "type:spike"   "fbca04" "Research / investigation"
label "type:chore"   "c5def5" "Maintenance, tooling, refactor"
label "type:docs"    "0075ca" "Documentation"
label "type:design"  "f9d0c4" "UX / architecture design"

label "status:ready"       "0e8a16" "Ready to be picked up"
label "status:in-progress" "fbca04" "Being worked on"
label "status:in-review"   "1d76db" "PR open / awaiting review"
label "status:blocked"     "b60205" "Blocked — see comments"
label "status:needs-info"  "d876e3" "Needs clarification"

label "priority:p0" "b60205" "Urgent"
label "priority:p1" "d93f0b" "High"
label "priority:p2" "fbca04" "Medium"
label "priority:p3" "c2e0c6" "Low / nice to have"

label "frontend"      "1f77b4" "UI, pages, components"
label "backend"       "2ca02c" "Services, APIs, business logic"
label "database"      "8c564b" "Schema, migrations, queries"
label "security"      "b60205" "Security-sensitive work or review"
label "gst"           "e99695" "Australian GST / tax invoice / BAS draft logic"
label "testing"       "bfd4f2" "Tests and verification"
label "documentation" "0075ca" "Documentation"
label "infra"         "5a5a5a" "CI/CD, Docker, environments, deploy"
label "design"        "f9d0c4" "UX / visual design"
echo "Labels ready on $REPO"

#!/bin/sh
# Publish an audited first commit to the active GitHub account.
set -eu
cd "$(dirname "$0")/.."

python3 scripts/audit_publication.py
python3 -m unittest discover -s tests -v

# Use only the public GitHub identity and a GitHub noreply email in commit metadata.
account=$(gh api user --jq '.login')
account_id=$(gh api user --jq '.id')
if git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo 'Existing commits need a separate history review before publication.' >&2
    exit 1
fi
if gh repo view "$account/codex-usage" >/dev/null 2>&1; then
    echo 'codex-usage already exists; refusing to overwrite it.' >&2
    exit 1
fi

git init -b main
paths=$(mktemp)
trap 'rm -f "$paths"' EXIT
python3 scripts/audit_publication.py --list > "$paths"
git add --pathspec-from-file="$paths"
python3 scripts/audit_publication.py --staged
git diff --cached --stat

git -c user.name="$account" -c user.email="$account_id+$account@users.noreply.github.com" \
    -c commit.gpgsign=false commit -m 'Prepare English documentation and local usage dashboard for publication'

# The index audit above covers every file in this first and only commit.
test "$(git rev-list --count HEAD)" = 1
python3 scripts/audit_publication.py --history
python3 scripts/audit_publication.py

gh repo create "$account/codex-usage" --public --source=. --remote=origin --push \
    --description 'Local Codex usage dashboard, observed quota capacity analysis, and offline reports'
gh repo view "$account/codex-usage" --json url,isPrivate --jq '{url: .url, public: (.isPrivate | not)}'

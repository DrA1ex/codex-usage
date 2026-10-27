# Validation

All automated fixtures are synthetic. No real account history, usage measurements, profile names, or generated reports belong in this repository.

## Python tests

```sh
python3 -m unittest discover -s tests -v
```

The suite covers quota-window arithmetic, first-100% cutoffs, incomplete starts, early and confirmed resets, timestamp drift, fork deduplication, inherited counters, compression, cache refresh, serial and parallel parsing, compact datasets, calendar boundaries, HTML escaping, and authentication-file exclusion.

Server tests require permission to bind a loopback port. They check static assets, metadata, foreign Host rejection, cross-origin writes, content types, path traversal, and unknown-profile rejection.

## Browser checks

Start the isolated synthetic demo:

```sh
python3 scripts/demo.py --open
```

Check Overview, Work per quota, Quotas, Models, Sessions, Projects, Profiles, Commands, and Data. Confirm that charts render in both themes, date and model filters apply across pages, session and quota drawers open, CSV tables download, and profile comparison uses only fictional data.

The optional `tests/browser_smoke.mjs` script validates a generated standalone report against a disposable Chrome DevTools endpoint. It checks the initial aggregates, 100% thresholds, output-token usage, weekly windows, model and date filters, and JavaScript runtime exceptions:

```sh
node tests/browser_smoke.mjs "$BROWSER_ENDPOINT" reports/demo.html
```

Check browser locale formatting, automatic and manual timezones, and daylight-saving calendar arithmetic with Node.js:

```sh
node tests/test_locale.mjs
```

Check the browser modules with Node.js, if available:

```sh
for file in src/codex_usage/web/js/*.js; do
  node --input-type=module --check < "$file" || exit 1
done
```

Use a disposable browser profile and synthetic report. The endpoint must already exist; the test never attaches to a personal browsing session automatically.

## Publication check

Run the publication audit before staging and once again on the Git index before a commit:

```sh
python3 scripts/audit_publication.py
python3 scripts/audit_publication.py --staged
python3 scripts/audit_publication.py --history
```

The audit verifies the allowed source-file list, rejects generated data and private file types, checks for non-English source text and machine-specific paths, and flags common credential patterns. It does not print suspected secret values. The history check examines every committed file, commit messages, and author/committer emails; public commits use a GitHub noreply email. Review the filenames with `git diff --cached --name-only` as well. Automated pattern checks support, but do not replace, a content review.

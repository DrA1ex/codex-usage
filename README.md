# Codex Usage

See where your Codex tokens go, track quota usage, and explore how much work fits into an observed quota window. Codex Usage turns session history on your computer into an interactive dashboard and standalone offline reports.

- Explore usage by day, hour, model, project, and session.
- Inspect five-hour and weekly quotas, exhausted windows, and early resets.
- Compare profiles and reasoning effort levels.
- Drill into sessions to see response usage, context size, and nested agents.
- Export CSV, JSON, or a self-contained HTML report.
- Switch between light and dark themes. No API key or paid service is needed.

## Safety and privacy notice

**Your data stays local.** Codex Usage makes no external network requests, calls no remote API, and includes no telemetry, analytics, external fonts, or CDN assets. The dashboard communicates only with its local Python server, which listens on `127.0.0.1` by default. Standalone HTML reports work offline.

The app reads local session logs and, when available, local session metadata, reset history, and voice-session timing. It never reads the contents of `auth.json`, and it does not modify your Codex profile. Conversation bodies are excluded from the parsed dataset; session titles, model names, IDs, branches, and working-directory paths can still be private.

Parsed caches and profile labels stay in `~/.cache/codex_usage/`; filter and theme preferences stay in your browser's local storage. `CODEX_USAGE_STATE` can select another local state directory.

**Review reports and exports before sharing them.** They can contain profile paths and other private metadata. Generated reports, archives, logs, caches, credentials, and local configuration are excluded by `.gitignore`. Do not override the server's loopback binding unless you intend to make the data available to other computers.

## Quick start

You need Python 3.11 or newer and a local Codex profile with session history.

From the project directory:

```sh
python3 serve.py --open
```

Open **Profiles**, select your profile, and let the first scan finish. Profiles matching `~/.codex*` are discovered automatically; use **Browse…** to add another directory. The dashboard opens at <http://127.0.0.1:8765>.

On macOS, you can also double-click `serve.command` in Finder. To use another port:

```sh
python3 serve.py --port 8766 --open
```

For an isolated installation:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
codex-usage-web --open
```

On Windows, activate the environment with `.venv\Scripts\activate`. Installed users can also run `codex-usage serve --open`.

Compressed `.jsonl.gz` files work with the standard library. For `.jsonl.zst`, use Python 3.14+ with built-in Zstandard support, install `python -m pip install -e '.[zstd]'`, or have the `zstd` command on your `PATH`.

## Explore your usage

### Overview

Check current quotas, estimated remaining tokens, period comparisons, model usage, token composition, and your activity heatmap. Click a chart bar to open that period, or a model to filter the dashboard.

> Screenshot placeholder: `codex-usage-01-overview-light.jpg` — overview with quota meters, usage history, and model breakdown. Use synthetic data.

### Quotas

See recorded usage percentages, tokens consumed in each quota window, capacity trends, and early resets. Click a window to inspect its model breakdown. Choose a 100% threshold for a strict exhaustion sample, or 98% to include nearly exhausted windows.

> Screenshot placeholder: `codex-usage-02-quota-analysis.jpg` — quota timeline and individual windows with the exhaustion threshold visible.

### Models

Compare token consumption, cache shares, average input and output per response, and reasoning effort. Model shares over time show how your mix changes. Model names are discovered from logs; there is no fixed model registry or price table.

> Screenshot placeholder: `codex-usage-03-models-dark.jpg` — model comparison and usage shares in dark theme.

### Sessions and projects

Search sessions by title, directory, branch, or ID. Open a session to inspect usage per response, context usage, and child agents. Projects group sessions by working directory; Codex worktrees are grouped with their main project.

> Screenshot placeholder: `codex-usage-04-session-detail.jpg` — synthetic session drawer with response and context charts.

> Screenshot placeholder: `codex-usage-05-projects.jpg` — usage across fictional projects.

### Profiles, commands, and data

**Profiles** lets you scan, rename, add, and compare accounts. Refresh reads only new and changed session files; a full rescan ignores the cache. Removing a custom profile from the list leaves its files intact.

> Screenshot placeholder: `codex-usage-06-profiles.jpg` — two fictional profiles with comparison charts.

**Commands** builds offline reports, shows the equivalent CLI command, displays background job logs, and exports the current dataset. **Data** explains parser diagnostics, skipped files, and analysis settings.

Date, model, metric, timezone, and internal-reviewer filters apply across the dashboard and are remembered locally.

## Create an offline report

```sh
python3 generate.py --days 30 --open
```

The generator reads `~/.codex` by default and writes one HTML file plus CSV and JSON exports under `reports/`. On macOS, `generate.command` generates the last 30 calendar days and opens the report.

```sh
# A specific date range; the end date is inclusive.
python3 generate.py --start 2026-01-01 --end 2026-01-31 --open

# Strict five-hour capacity, averaged in three-day groups.
python3 generate.py --days 30 --period 3d --quota-window 5h --min-used 100

# Observed weekly capacity.
python3 generate.py --days 60 --quota-window 7d --period 7d

# Total usage, including incomplete quota windows.
python3 generate.py --days 30 --mode usage --metric tokens

# Output tokens, or input tokens without cached input.
python3 generate.py --days 30 --mode usage --metric output
python3 generate.py --days 30 --mode usage --metric uncached

# Another profile, timezone, and output filename.
python3 generate.py --codex-home ~/.codex-work --timezone UTC \
  --days 30 --output reports/work.html
```

Inside the HTML report, you can change the analysis mode, metric, grouping period, model, dates, quota counter, and exhaustion threshold. Run the generator again to add new history or expand the original date range.

> Screenshot placeholder: `codex-usage-07-offline-report.jpg` — standalone report with capacity trends and CSV export.

## Understanding the numbers

**Usage** is the sum of recorded token consumption in the selected date range. **Capacity** is the arithmetic mean of token consumption across eligible whole quota windows. Each window has equal weight.

A capacity window must have an observed start near zero usage. Tokens are counted until the first 100% snapshot, or the final snapshot for a nearly exhausted window. A 98–99% snapshot does not prove that the quota stopped further work. Values are never extrapolated to 100% or weighted by model prices.

`--period` controls the comparison groups, such as three days. `--quota-window` selects a recorded quota duration, such as five hours or seven days. A five-hour counter cannot establish the capacity of a different quota duration.

Voice, images, activity on other devices, and other features sharing the quota may change the tokens available to working models. Remaining-token estimates describe past observations and can vary with models and cache use. This is not a billing tool or a guaranteed subscription limit.

Internal auto-review usage is excluded by default because its quota impact cannot be determined from these logs. Enable **Internal** or pass `--include-internal` to include it.

| CLI metric | Meaning |
| --- | --- |
| `tokens`, `total_tokens` | Input + output tokens |
| `input`, `input_tokens` | All input tokens, including cached input |
| `cached`, `cached_input_tokens` | Cached input; already included in input |
| `uncached`, `uncached_input_tokens` | Input minus cached input |
| `output`, `output_tokens` | Output, including reasoning tokens |
| `reasoning`, `reasoning_output_tokens` | Reasoning; already included in output |
| `responses`, `requests` | Model responses / internal steps with new usage |

New numeric usage fields can be selected by name. Missing fields in older records count as zero. See [analysis details](docs/ANALYSIS.md) for window eligibility, reset handling, and date boundaries.

## Settings and exports

`codex_usage.json` contains portable defaults: `~/.codex`, UTC, three-day comparison periods, five-hour quotas, total tokens, and a 98% threshold. For personal settings, copy it to the ignored `codex_usage.local.json`. The app automatically prefers that local file; CLI flags take precedence. Use `--config PATH` to select a different CLI configuration.

Each report produces:

| File | Contents |
| --- | --- |
| HTML | Self-contained interactive report |
| `periods.csv` | Period averages or totals |
| `windows.csv` | Individual quota windows and model breakdowns |
| `resets.csv` | Budget reset observations |
| `report-data.json` | Report dataset for further analysis |

Set `--export-dir` to choose another export directory. Both the dashboard and the report can download CSV tables. The CLI stops on unreadable files by default; `--skip-unreadable` explicitly allows skipping them. The dashboard records skipped files in **Data**.

## Try synthetic demo data

```sh
python3 scripts/demo.py --open
```

This starts an isolated dashboard with two fictional profiles, projects, and sessions. It never discovers or scans your real profiles. All generated data and demo reports live under `demo-data/`, which is ignored by Git. Use it to explore the UI or prepare screenshots without exposing personal history.

## Troubleshooting

- **No profiles:** add the directory containing `sessions/` or `archived_sessions/` on the Profiles page.
- **No usage in the selected dates:** widen the date filter or confirm that the profile contains token-count events.
- **No capacity observations:** try another quota duration, a longer date range, or the 98% threshold. Usage mode still includes incomplete windows.
- **Port already in use:** pass `--port 8766`.
- **Compressed files cannot be read:** install Zstandard support as described above.
- **Numbers look incomplete:** check **Data** for diagnostics and skipped files, then try a full rescan.

## Development

```sh
python3 -m unittest discover -s tests -v
```

The app uses Python's standard library and bundled browser assets. See [validation instructions](VALIDATION.md) for the test scope and browser checks. Tests and demo data are synthetic.

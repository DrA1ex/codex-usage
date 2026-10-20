# Codex Usage

Understand how many tokens actually fit into your Codex usage limits. Codex Usage analyzes local session history to measure observed five-hour and weekly quota capacity, compare models, and track how your usable budget changes over time.

**[Try the live demo →](https://dra1ex.github.io/codex-usage/)** The full dashboard with synthetic data runs in your browser; nothing to install. A [sample offline report](https://dra1ex.github.io/codex-usage/demo-report.html) is available too.

- Measure tokens consumed before recorded quota exhaustion, using whole windows with observed starts.
- Compare effective capacity across models and dates, with sample sizes and model breakdowns.
- Investigate unexpected capacity changes, incomplete windows, and early resets.
- Compare model usage, cached input, output, and reasoning effort.
- Explore usage by day, hour, project, and session, and export reproducible offline reports.
- Keep your analysis local. No API key or paid reporting service is needed.

<img width="900" alt="Observed five-hour quota capacity by model" src="https://github.com/user-attachments/assets/c64a830b-dffd-412c-a07e-4577ac5e16c2" />

*All screenshots use synthetic example data with real model names.*

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

## Check your effective quota capacity

1. Open **Quotas** and choose the five-hour or weekly counter.
2. Select **100%** for a strict sample of windows with recorded exhaustion. The default **98%** also includes nearly exhausted windows.
3. Review the average tokens per window, the number of observations, and the model breakdown. Use the trend to compare dates under the same settings.
4. Switch to the other quota duration to see its own recorded windows. Use **Models** to compare total consumption, cache use, output, and reasoning effort.

This helps answer questions such as “Has my effective five-hour budget changed?”, “How much work fits into the weekly limit?”, and “How does my model choice affect the tokens I get through before exhaustion?” The local record lets you check whether observed usage matches your expectations and investigate unexpected quota behavior.

Quota logs provide usage percentages and reset times, rather than OpenAI's absolute quota configuration or a promised token allowance. These reports measure **observed capacity under your workload**. Model mix, cache use, voice, images, and activity on other devices can affect the result; compare the same filters and enough complete windows.

## Focus on one question

The sidebar has two parts. **Focus** pages answer one question each by combining several metrics; **Charts** pages keep every metric available for open-ended exploration. Filters and page controls stay in a bar pinned to the top while you scroll. Press <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd>) or <kbd>/</kbd> to open the command palette: jump to a page, switch the period, metric, profile, or theme, or refresh the data from the keyboard.

Clicking a model or a project in a chart filters every page to it; click it again, or **Clear** in the bar, to remove the filter. The address keeps the current view (period, filters, metric, and the page's own settings), so a bookmark or a copied link — **⋯ → Copy link to this view** — reopens the same slice.

### Period review

How did a day, week, or month go? Step through periods with ‹ › (or the arrow keys) and compare the selected period with earlier ones: tokens, the share of the five-hour and weekly quotas burned, time spent at a limit, active hours, and a projection for an unfinished period. An unfinished period is compared with the previous one at the same elapsed point. A timeline shows the sessions you worked on, and change charts show which projects, models, and context sizes moved the total.

### Quota budget

Will your quota last until the reset, what is spending it, and what would make it last longer? For each live counter a chart shows the current window with the pace extended to the reset, and the card lists when the counter reaches 100%, how long you would wait for the reset, what is left (also in tokens, from the tokens per 1% of the last seven days), and the pace and daily budget that make it last exactly until the reset.

To see what spent the quota, every increase of the counter between two recorded snapshots is split across the responses recorded in that interval, in proportion to their tokens; increases with no responses — another device, voice, or another profile on the same account — stay unexplained. The split is shown by session, model (with tokens per 1%), project, reasoning effort, and session type, for the current window or the selected period. Automatic checks then point out what stands out — a pace that runs out before the reset, a large share at long context, one dominant session, a model that costs more quota per token, mostly high effort, heavy subagent or review use, a low cache share, time at a limit, or a large unexplained share — each with the numbers behind it and a suggestion.

### Quota watch

Has your observed quota capacity changed? Recent windows (7, 14, or 30 days) are compared with a baseline, separately for each model, because models draw on the quota at different rates. A Mann–Whitney test on individual windows flags a change only when it is both significant (p < 0.05) and at least 8%. A model × week matrix, a scatter of every window, the number of five-hour windows that fit in a weekly quota, and the cache/output mix help separate a real limit change from a change in your workload.

### Spend anatomy

What is your usage made of? A pivot table splits usage by any two of model, context size, reasoning effort, project, session type, weekday, hour, or period; click a cell to list the sessions behind it. A waterfall splits the change against the previous period into more responses, larger context, and more output.

### Context growth

How does context build up inside a session, and what does a long context cost? One line per session shows the input context at every response; select a session to see what each of its responses cost (new input, cached re-reads of the context, output) and where compactions cut the context back. Page-level figures show the share of tokens spent past half of the model context window, the median context added per response, how much later responses cost than early ones, and an estimate of the re-reads each compaction avoided. A compaction is detected as a drop of more than 40% from at least 20K tokens of context.

## Explore your usage

### Overview

The overview has two layers. **Right now** shows the live quota counters — with a forecast at the pace of the last hour (five-hour quota) or day (weekly quota): does the counter reach 100% before the reset, and how much per day lasts until the weekly reset — plus today and this week against typical days and last week. **Selected period** follows the filters: key figures with daily sparklines, usage over time (optionally against the previous period), and compact cards for models, projects, top sessions, token mix, when you work, and one signal from each focus page. Click a model or a project to filter the dashboard, a session to open it, or a chart bar to zoom in.

<img width="900" alt="Model shares and token composition" src="https://github.com/user-attachments/assets/8d225403-f48c-4fb7-a8d4-20c6be5143b7" />

### Quotas

See recorded usage percentages, tokens consumed in each quota window, capacity trends, and early resets. Click a window to inspect its model breakdown. Choose a 100% threshold for a strict exhaustion sample, or 98% to include nearly exhausted windows.

<img width="900" alt="Observed weekly quota capacity" src="https://github.com/user-attachments/assets/8da3e38c-a82a-4ea3-91ef-a21954980926" />

### Models

Compare token consumption, cache shares, average input and output per response, and reasoning effort. Model shares over time show how your mix changes. Model names are discovered from logs; there is no fixed model registry or price table.

<img width="900" alt="Model usage comparison and shares over time" src="https://github.com/user-attachments/assets/21fe2e86-2e55-41c9-aafb-570526f61e03" />

### Sessions and projects

Search sessions by title, directory, branch, or ID. Open a session to inspect usage per response, context usage, and child agents. Projects group sessions by working directory; Codex worktrees are grouped with their main project.

<img width="720" alt="Session response usage and context growth" src="https://github.com/user-attachments/assets/325e1bf4-1385-468f-b89e-11934d9a9dd9" />

<img width="900" alt="Token usage by project" src="https://github.com/user-attachments/assets/0cf9533e-ad54-4d9b-858a-61f9e7daa3da" />

### Profiles, commands, and data

**Profiles** lets you scan, rename, add, and compare accounts. Refresh reads only new and changed session files; a full rescan ignores the cache. Removing a custom profile from the list leaves its files intact.

<img width="900" alt="Usage comparison for Personal and Work example profiles" src="https://github.com/user-attachments/assets/0f78c259-07bc-4bbb-bbba-42fd43abb27d" />

**Commands** builds offline reports, shows the equivalent CLI command, displays background job logs, and exports the current dataset. **Data** explains parser diagnostics, skipped files, and analysis settings.

Date, model, metric, timezone, and internal-reviewer filters apply across the dashboard and are remembered locally. Dates, times, and numbers follow your browser's language and regional preferences. The timezone defaults to **Auto**, using your browser's timezone on each visit; select another timezone to save a manual override. The active timezone controls which day or hour an event belongs to and is passed to reports created through **Commands**. Standalone reports retain the timezone chosen when they were generated.

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

The [live demo](https://dra1ex.github.io/codex-usage/) is this same synthetic dashboard, rebuilt from `main` on every push and once a day by the **Demo site** workflow and published to GitHub Pages. It is read-only: profile scans, report generation, and other actions that need the local server are disabled. To run it locally:

```sh
python3 scripts/demo.py --open
```

This starts an isolated dashboard with Personal and Work example profiles. It uses real model identifiers, realistic project and task names, and generated usage patterns; counters and account details are synthetic. It never discovers or scans your real profiles. All generated data and demo reports live under `demo-data/`, which is ignored by Git. Use it to explore the UI or prepare screenshots without exposing personal history.

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
node tests/test_locale.mjs
node tests/test_focus.mjs
```

The app uses Python's standard library and bundled browser assets. Interface icons in `src/codex_usage/web/img/` are a generated PNG mask strip without metadata; the publication audit accepts PNG files only in that folder. See [validation instructions](VALIDATION.md) for the test scope and browser checks. Tests and demo data are synthetic.

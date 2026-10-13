# Analysis details

## Dates and grouping

Without dates, the CLI uses the last 30 calendar days, including today in the selected timezone. `--end YYYY-MM-DD` includes that entire day. Precise ISO timestamps specify an exclusive end boundary:

```sh
python3 generate.py --start 2026-01-10T12:00:00Z \
  --end 2026-01-13T18:00:00Z --period 12h
```

Day-based comparison groups align to local calendar dates, including daylight-saving transitions. A capacity window belongs to the group containing its start; it may finish after the selected range. Usage mode restricts events to the selected timestamps.

## Quota windows and eligibility

Counters are identified by `window_minutes`, rather than by the `primary` or `secondary` slot. This supports histories where the weekly counter appears in either slot.

An observed start at or below `--start-used-max` (default: 2%) is required for capacity. Windows with missing starts, observations longer than the quota duration, or no working-model usage are excluded. Usage mode retains recorded consumption from incomplete windows.

`--min-used` defaults to 98%. A 100% threshold includes only windows with a recorded 100% snapshot. The generator counts tokens up to the first such snapshot; additional consumption during an active turn remains in total usage but does not inflate capacity.

A window is assigned to its dominant model when that model accounts for at least `--dominance` of working-model tokens (default: 0.95). Other windows are classified as **Mixed models** with per-model breakdowns.

## Resets and repeated history

- A changed reset deadline starts a new window. `--reset-tolerance-seconds` (default: 180) allows small deadline drift.
- A large counter drop without a changed deadline needs a confirming observation or a matching application reset record. A single stale response does not create extra capacity.
- Resets before the previous deadline are marked early. Local history cannot reliably distinguish manual resets from provider-initiated resets.
- A reset of cumulative session tokens is handled using `last_token_usage`; it is not itself a quota reset.
- Unchanged cumulative totals and duplicated fork events are not counted twice.
- An initial event with inherited history contributes the last step's usage, rather than the entire inherited total.

## Voice and estimates

Where local voice-session timing is available, windows show voice duration and overlap. These are elapsed times between recorded start and end events, rather than exact billed minutes.

Quota percentages may be rounded or delayed. Voice, images, and activity outside the profile can share the budget without appearing in its token events. Capacity and tokens-per-percent figures describe observations, rather than an absolute server-side quota or guaranteed remaining budget.

## Data quality

Parser diagnostics cover the entire scanned profile; report metrics cover the selected range. Unknown model events, inconsistent totals, invalid deltas, and stale snapshots are handled explicitly and explained on the Data page.

Parsed files are cached by path, size, and modification time. Refresh rereads only new and changed files. Use `--no-cache` in the CLI or a full dashboard rescan to bypass cached parsing. Cache files belong to the local application state and should not be imported from untrusted sources.

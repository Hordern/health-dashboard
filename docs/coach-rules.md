# Coach Rules Spec v1

Rules for the Running Coach service. The service evaluates them at two times:
- **Daily**, as part of the ~20:00 run, it checks today's readiness.
- **End of block**, on the last day of the deload week, it reviews the block and plans the next one.

All thresholds live in `CONFIG` so they can be tuned without touching the logic.

---

## 1. Config

```yaml
plan:
  block_length_weeks: 3          # masters default: 2 build + 1 deload (switch to 4 = 3+1 if recovering well for 3+ blocks)
  deload_volume_pct: 0.75        # deload week = 75% of previous build week's volume
  weekly_volume_increase: [0.05, 0.07]   # masters default: smaller steps (younger athletes 5–10%)
  min_hours_between_hard_sessions: 72    # masters: quality runs and heavy leg days count as "hard"
  long_run_max_share: 0.30       # long run ≤ 30% of weekly volume
  long_run_max_increase_min: 10  # long run grows ≤ 10 min per week
  easy_share_min: 0.80           # ≥ 80% of weekly time at easy intensity
  quality_sessions_max: 2        # per week
  rebuild_after_fatigue_pct: 0.85  # restart volume at 85% of previous block's peak week

thresholds:
  efficiency_change_pct: 2.0     # ±2% block-over-block = meaningful change
  decoupling_good_pct: 5.0       # long-run HR drift < 5% = aerobically solid
  benchmark_time_change_pct: 1.0 # ≥1% faster = progressed
  benchmark_hr_drop_bpm: 3       # same time, ≥3 bpm lower avg HR = progressed
  quality_pace_tolerance_pct: 3.0
  quality_completion_good: 0.85  # ≥ 85% of prescribed reps hit in tolerance
  rhr_elevation_bpm: 5           # 7-day avg RHR vs 28-day baseline
  flag_min_days: 3               # a recovery flag needs ≥3 days in the last 7
  sleep_min_hours: 6.5
  missed_sessions_max: 0.20      # >20% of planned sessions missed/cut = flag
  fatigue_flags_trigger: 2       # ≥2 recovery flags = FATIGUED
  stall_blocks_trigger: 1        # flat for this many blocks → change stimulus

return_to_run:
  pain_max_during: 3             # 0–10 scale
  pain_progress_requires_next_morning_not_worse: true
  exit_criteria: "3 × 30 min continuous easy runs, pain ≤ 2, within one week"
```

---

## 2. Required inputs

| Input | Source | Notes |
|---|---|---|
| Activities (time, distance, avg pace, avg HR, laps, splits) | Garmin | Needed to compute efficiency, decoupling, and quality completion |
| Resting HR (daily) | Garmin | Keep 28 days of history for the baseline |
| HRV status / overnight HRV | Garmin | Use Garmin's status (balanced / unbalanced / low) |
| Sleep duration / score | Garmin | |
| Planned sessions | `CURRENT_PLAN` | Needed to calculate the completion rate and judge quality sessions |
| **Pain score (0–10) + next-morning pain** | **Manual log** | Garmin doesn't record pain. This is required while in the return-to-run phase |
| RPE (optional) | Manual / Garmin perceived effort | Improves the quality-session signal if available |

---

## 3. Metric definitions

**Easy run:** a run where avg HR ≤ the easy HR ceiling (top of zone 2), or one tagged easy in the plan.

**Efficiency Factor (EF)** = avg speed (m/min) ÷ avg HR (bpm), averaged over all easy runs in the block.
`efficiency_change = (EF_this_block − EF_last_block) / EF_last_block × 100`

**Decoupling** (only for long runs ≥ 60 min at steady easy effort):
`decoupling = (EF_first_half − EF_second_half) / EF_first_half × 100`
Use the median of the block's long runs.

**Benchmark:** run the same test in every deload week. Pick one and keep it fixed:
- 30-min time trial (gives distance and avg HR), or
- 5K time trial, or
- a fixed set such as 3 × 1 km at threshold effort.

Store the time and avg HR and compare with the previous block.

**Quality completion** = reps hit within ±3% of target pace ÷ reps prescribed, across all quality sessions in the block.

---

## 4. Daily readiness check (inside a block)

These are the recovery flags. Each is evaluated over the last 7 days:

| Flag | Condition |
|---|---|
| `RHR_HIGH` | RHR ≥ baseline + 5 bpm on ≥ 3 days |
| `HRV_LOW` | HRV status unbalanced or low on ≥ 3 days |
| `SLEEP_LOW` | Sleep < 6.5 h on ≥ 3 days |
| `MISSED` | > 20% of planned sessions missed or cut short so far this block |
| `PAIN` | Any pain score ≥ 4, or next-morning pain worse than the day before |

Daily actions:
- **PAIN** → replace the next run with rest or cross-training, remove intensity, and flag it for review.
- **≥ 2 flags** → swap the next quality session for an easy run and do not raise volume next week.
- **1 flag** → proceed as planned and mention the flag in the daily note.
- **0 flags** → proceed as planned.

---

## 5. End-of-block review

### 5a. Score progress

Score each of three signals as `+1` (better), `0` (flat), or `−1` (worse):

| Signal | +1 | −1 |
|---|---|---|
| Efficiency | change ≥ +2% | change ≤ −2% |
| Benchmark | time ≥ 1% faster, or same time with HR ≥ 3 bpm lower | time ≥ 1% slower |
| Quality | completion ≥ 85% and RPE same or lower | completion < 70% |

Garmin VO2max and the race predictor are not scored. They are recorded as context only.

```
PROGRESSED  if sum ≥ 2 and no signal == −1
DECLINED    if sum ≤ −2
FLAT        otherwise
```

### 5b. Score recovery

Count the recovery flags that were active in **any 2 of the 3 build weeks**:
- ≥ 2 flags → `FATIGUED`
- otherwise → `FRESH`

Any `PAIN` flag in the block sets `INJURY_WATCH`. This overrides both scores.

### 5c. Decide the next block

| Progress | Recovery | Next block action |
|---|---|---|
| any | INJURY_WATCH | **HOLD_OR_REDUCE**: same or lower volume, no intensity until 7 days pain-free, then resume at the previous level |
| PROGRESSED | FRESH | **PROGRESS**: update paces from the benchmark, add volume (5–10%/wk) **or** extend the long run, keep the structure |
| PROGRESSED | FATIGUED | **CONSOLIDATE**: update paces and keep the previous block's volume |
| FLAT | FRESH | **CHANGE_STIMULUS**: change exactly one thing (swap the quality type, e.g. tempo → cruise intervals; add hills; add a 2nd quality session if currently 1; or extend the long run). Volume +5% |
| FLAT | FATIGUED | **RECOVER**: one extra deload week, then rebuild at 85% of the previous peak week |
| DECLINED | FRESH | **CHANGE_STIMULUS**, and check the data quality (heat, illness, watch HR errors) before acting |
| DECLINED | FATIGUED | **RECOVER**: extra deload week, rebuild at 85%, and check sleep and the calorie deficit |

Additional rules:
- If the result is FLAT for 2 blocks in a row after a stimulus change, switch to a 3-week block structure and mark it for manual review.
- Never increase volume **and** intensity in the same week.
- Only change one variable per block. This keeps the next review interpretable.

---

## 6. Weekly progression (within a block)

- **Build weeks:** volume = previous week × (1 + 5–10%). Use 5% if 1 flag is active and 10% if none are.
- **Deload week:** volume = 75% of the last build week. Keep one short quality touch and run the benchmark test.
- **Long run:** at most 30% of weekly volume and at most +10 min on last week.
- **Intensity distribution:** at least 80% of time easy and at most 2 quality sessions per week.
- **Strength days:** schedule quality runs away from heavy leg days, with at least 24 h between them where possible.

---

## 7. Return-to-run phase (gates base training)

While in `phase = RETURN_TO_RUN`:
- Progress is measured by **time**, not distance. The steps are walk–run ladders, for example 1:1 → 2:1 → 4:1 → 8:1 → continuous 20 → 25 → 30 min.
- **Advance** one step when every session in the step had pain ≤ 3 during the run and next-morning pain was not worse.
- **Repeat** the step if any session hit pain 4, or next-morning pain was worse.
- **Regress** one step if pain reached ≥ 5, or there were 2 consecutive repeats.
- No quality sessions and no benchmark tests during this phase.
- **Exit to BASE** after 3 × 30 min continuous easy runs with pain ≤ 2 within one week.

---

## 8. Block library and selection

There is no race on the calendar yet, so training runs as a sequence of **general fitness blocks**. At the end of each block the engine recommends the next block type, and Dan confirms it or picks a different one. Race blocks only become available once a race goal is set.

### 8a. Block types

| Block type | Purpose | Weekly shape (3–4 runs) | Benchmark |
|---|---|---|---|
| `RETURN_TO_RUN` | Rebuild tolerance after the knee injury | Walk–run ladder per section 7 | None |
| `FITNESS_BASE` | Aerobic base. This is the **default** and the recovery block | All easy runs + strides 1–2×/wk, a long run, optional light fartlek or hills (from the 2nd base block on) | 30-min TT |
| `FITNESS_THRESHOLD` | Raise sustainable pace | 1 tempo or cruise-interval session, a long run, the rest easy | 30-min TT |
| `FITNESS_ENDURANCE` | Durability | Long run is the focus (time progression), 1 light quality session, the rest easy | 30-min TT + long-run decoupling |
| `FITNESS_SPEED` | Top-end speed and economy | 1 short-interval session (e.g. 6–10 × 400 m), strides, the rest easy. Volume is held flat | 30-min TT |
| `RACE_BUILD` / `RACE_SPECIFIC` / `TAPER` | Race preparation | Only unlocked once `race_goal` is set. Phase lengths come from weeks-to-race | Race-specific |

Keep the benchmark the same across all fitness blocks so results stay comparable from block to block.

### 8b. Starting sequence

`RETURN_TO_RUN` → `FITNESS_BASE` × 4 (~12 weeks at 3-week blocks) → `FITNESS_ENDURANCE` → then the engine selects the next block.

The early blocks are deliberately base-heavy. Capillary density and mitochondria adapt over weeks to months. Tendons, bone and other connective tissue adapt more slowly than the aerobic system does, so the engine prioritises easy volume and consistency over intensity.

**Tissue-readiness gate.** `FITNESS_THRESHOLD` and `FITNESS_SPEED` stay locked until both of these hold:
- 12 consecutive weeks of ≥ 90% session completion with no PAIN flag (masters default; younger athletes use 8), and
- the long run has reached 75 min, or weekly easy volume has reached the `base_target_minutes` config value (default 180 min/wk).

Until then, PROGRESS and CHANGE_STIMULUS can only choose between `FITNESS_BASE` and `FITNESS_ENDURANCE`.

**Base progression preference.** In base blocks, add volume by increasing **frequency first**: add a short easy run, up to 5 runs/wk. Only after that lengthen runs. More frequent, shorter loading is easier on the tissues while they catch up.

### 8c. Recommendation logic (after the section 5 decision)

| Decision | Recommended next block |
|---|---|
| INJURY_WATCH | `FITNESS_BASE` with no intensity. If pain ≥ 5 occurred, go back to `RETURN_TO_RUN` |
| RECOVER | `FITNESS_BASE` at 85% volume |
| CONSOLIDATE | Repeat the same block type at the same volume |
| PROGRESS | Next type in the rotation: `THRESHOLD` → `ENDURANCE` → `SPEED` → `BASE` → … |
| CHANGE_STIMULUS | Least-recently-used block type, excluding the last 2 blocks |

Additional rules:
- Never run 2 non-BASE blocks back-to-back if the previous block ended FATIGUED.
- Insert a `FITNESS_BASE` block at least every 4 blocks.
- When `race_goal` is set and there are 8 or more weeks to the race, switch to the race sequence. Use the most recent benchmark to set training paces.

### 8d. Selection flow

1. Last day of the deload week: the engine writes its review plus a `recommended_block` and up to 2 alternatives, each with a one-line reason.
2. The recommendation is shown on the dashboard, or in the daily message.
3. Dan picks one. If there's no answer within 48 h, the recommended block is used.
4. If Dan's choice breaks a guardrail (e.g. picking `FITNESS_SPEED` while INJURY_WATCH is active), the engine downgrades it and states why.

## 9. Cross-training (optional)

- An easy bike or row session (30–45 min, zone 2) is an optional extra in any block. The coach suggests it when Dan has spare capacity or a PAIN flag is active. It is never required.
- Log cross-training separately from running. It counts toward fatigue and recovery, but **not** toward running volume progression or the base exit gate.
- When a PAIN flag is active, swap the next run for an equal-time easy bike session.
- During base, cross-training stays easy. No hard intervals the day before a run.
- Review the details when they're needed.

## 10. Output schema (end of block)

```json
{
  "block_id": "2026-B07",
  "phase": "BASE|BUILD|SPECIFIC|TAPER|RETURN_TO_RUN",
  "signals": {
    "efficiency_change_pct": 2.8,
    "decoupling_pct": 4.1,
    "benchmark": {"time_change_pct": -1.4, "hr_change_bpm": -2},
    "quality_completion": 0.9
  },
  "scores": {"efficiency": 1, "benchmark": 1, "quality": 1, "sum": 3},
  "progress": "PROGRESSED",
  "recovery": "FRESH",
  "flags": [],
  "decision": "PROGRESS",
  "changes": ["Easy pace 5:45→5:38/km", "Long run 75→85 min"],
  "next_block": {"weeks": 4, "week_volumes_min": [260, 280, 300, 225]},
  "notes": "Free-text coaching summary from the LLM"
}
```

**Division of work:** sections 3–7 are deterministic code. The Anthropic API call receives this JSON and writes the human-readable coaching note and session-level detail. It does not make the decision itself.

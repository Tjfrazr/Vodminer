Analyze the Vodminer clip feedback data and tune detection thresholds.

## Steps

### 1. Read the data
Read both files:
- `clips/highlights-manifest.json` — all clips with scores, ratings, approved/disapproved flags
- `config.js` — current threshold values

### 2. Compute feedback stats

Filter to **audio_transient** clips only (skip viewer_clip entries — their score of 999+ is not comparable).

Categorize each clip:
- **Good**: `approved === true` OR `rating >= 7`
- **Bad**: `disapproved === true` OR `rating <= 3`
- **Neutral**: everything else (rated 4–6, or unrated and neither approved nor disapproved)

Print a stats table:

```
Category    Count   Avg auto-score   Min    Max
Good        N       X.XX             X.XX   X.XX
Neutral     N       X.XX             X.XX   X.XX
Bad         N       X.XX             X.XX   X.XX
```

Also list the top 5 disapprove reasons if any exist.

### 3. Find the optimal spikeStddevs

The `score` in the manifest IS in standard-deviation units — directly comparable to `spikeStddevs`.

Find the threshold that minimizes **false positives** (bad clips above threshold) + **false negatives** (good clips below threshold):
- Try every 0.1-step value between the min bad score and max good score
- Pick the value with the fewest total errors
- If there's no overlap between good and bad score ranges, the midpoint between max(bad scores) and min(good scores) is optimal

Only recommend changing `spikeStddevs` if there are at least 3 good clips AND 3 bad clips to draw from. Otherwise state the data is insufficient and describe what's needed.

### 4. Check maxHighlightsPerVod

Count how many clips per VOD were approved vs how many were generated. If the user consistently approves fewer than 5 clips per VOD, and the current cap is 20, suggest lowering it.

### 5. Present findings

Show:
- Current `spikeStddevs` vs recommended value (with confidence: how clean the separation is)
- Whether `maxHighlightsPerVod` should change
- Any other observations (e.g., all disapproved clips came from the first 2 minutes → lobby detection issue)

Then ask: **"Apply these changes to config.js?"**

Only edit `config.js` after explicit confirmation. Show the exact diff before applying.

### 6. After applying

Append a one-line entry to `runninglog.txt`:
```
[YYYY-MM-DD HH:MM] /tune: spikeStddevs N→M (N good clips, N bad clips analyzed)
```

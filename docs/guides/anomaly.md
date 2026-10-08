# Anomaly detection (6.6)

Spot abusive clients and prompt-injection attempts in live traffic.

```yaml
anomaly:
  action: quarantine          # alert (default): record only | quarantine: also refuse (-32015)
  quarantineSeconds: 300
  windowMinutes: 5
  burst: { factor: 5, min: 30 }            # calls this minute > max(factor × baseline, min)
  errors: { ratio: 0.5, min: 20 }          # error ratio over the window
  enumeration: { distinctTools: 25 }       # distinct tools over the window
  injection: { threshold: 0.6, scan: both } # arguments | results | both | off
  exempt: ["key:load-test*"]
```

## Signals

| Kind | Trigger |
|------|---------|
| `burst` | The client's calls in the current minute exceed `factor ×` its EWMA baseline (idle minutes count as zero) |
| `error-spike` | Error ratio over `windowMinutes` above `errors.ratio` |
| `enumeration` | More than `distinctTools` different tools in the window (tool scanning) |
| `prompt-injection` | Injection score ≥ `threshold` in arguments or results |

Each abuse kind alerts at most once per client per minute. With `action: quarantine`, an abuse alert refuses the
client's calls for `quarantineSeconds`, and arguments that score as injection are refused immediately. Injection in
**results** is recorded (use the output filter or 7.3's sanitization to change results).

## Injection score

The score adds weights of matched signals and is capped at 1: instruction override (0.6), role override (0.6),
tool hijacking (0.7), exfiltration URLs (0.7), prompt exfiltration (0.5), hidden Unicode (0.5), new instructions
(0.4), fake role tags (0.4), long base64 blobs (0.2). `POST /api/v1/admin/anomaly/score` scores any text or JSON.

## API

- `GET /api/v1/admin/anomaly` (`?kind=burst`) — alerts, quarantined clients, baselines.
- `POST /api/v1/admin/anomaly/release` `{ client }` — lift a quarantine.

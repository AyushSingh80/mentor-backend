# Deployment — free tier only

Written 2026-09-08. Free-tier terms change often; every number below marked
**verify** was true at time of writing and should be re-checked before you
commit to a host. The *decision criteria* do not go stale, so read those first.

## What "free" covers, and what it does not

Free hosting is achievable. **The model API is not free and this plan does not
make it so.** The server's own caps are the real budget:

```
MONTHLY_USD_CAP=30      of which  MCQ 8 | CA 5 | drills 4 | interview 2
                                  and a $10 floor reserved for evaluation
```

So the target is: **$0 of infrastructure, ~$30/month ceiling of model spend,
enforced by the server itself.** Everything below is about protecting that
second number as much as reaching the first — because the cheapest possible
hosting mistake here is one that quietly disables the spend cap.

## What the server actually needs

| Requirement | Value | Why it constrains the host |
|---|---|---|
| Runtime | Node ≥ 22, ESM, Express 5 | Rules out edge runtimes without a port |
| Response style | SSE, held open 30–90 s | Rules out hosts that buffer responses |
| Request body | 25 MB total, 8 MB/file, 12 files | Rules out Vercel Hobby (4.5 MB body cap) |
| Peak memory | ~150 MB RSS (body buffered in memory) | 512 MB tiers are comfortable |
| Durable state | One small JSON ledger, a few writes/day | **The hard part — see Blocker 1** |
| Concurrency | Exactly 1 instance | Ledger is read-modify-write |
| TLS | Valid HTTPS cert | App refuses plain http off-LAN (`lib/secure.ts:62`) |
| Traffic | A handful of requests a day, one user | Any free tier is oversized |

### The architectural break that makes free hosting viable

Only five endpoints need the server: `/evaluate`, `/mcq`, `/ca`, `/drills`,
`/interview`. Every one is **pulled, never pushed** — nothing is scheduled
server-side, nothing polls. The syllabus tracker, revision queue, MCQ practice,
drill writing, streaks and notifications all run entirely on the phone against
local SQLite.

That means a host which sleeps when idle costs nothing and breaks nothing. A
50-second cold start is annoying on the one tap that needs it and invisible the
rest of the day. Most apps cannot tolerate scale-to-zero; this one is unusually
well suited to it.

---

## Three blockers to clear before deploying anywhere

### Blocker 1 — the spend cap does not survive a restart

`server/src/usage.ts` persists the ledger to `USAGE_FILE=./data/usage.json`.
**Every free tier has an ephemeral filesystem.** On redeploy, on a scale-to-zero
wake, on any container recycle, that file is gone. `capStatus()` then reports
$0 spent, and the $30 ceiling never binds again.

This is the most serious item in this document. The cap is the only thing
standing between a retry loop and a real bill, and on a free host as the code
stands today it is decorative.

It is also the reason `usage.ts` says *"Revisit if this ever serves more than
one person."* The trigger turned out not to be a second user — it was leaving
one machine.

**Fix.** Extract a `LedgerStore` port with two adapters:

```
readLedger()  / writeLedger(ledger)      ← the only two calls to replace
  FileStore     dev + any host with a real disk   (today's code, unchanged)
  RemoteStore   production on an ephemeral host
```

About 60 lines plus a config switch. `tests/usage.test.ts` drives the store
through the port and carries over. Free durable backends, best fit first:

| Backend | Free tier (**verify**) | Fit |
|---|---|---|
| **Turso** (libSQL) | Multi-GB storage, HTTP driver | Closest to the project's existing SQLite grain; queryable ledger |
| **Upstash Redis** | Per-day command quota, HTTP API | Smallest possible diff — one `GET`/`SET` of the same JSON document |
| Neon / Supabase | Postgres, scales to zero | Fine, but a whole Postgres for one JSON blob |

Pick **Upstash** to ship fastest, **Turso** if you want to run queries against
your own spend history later. Either keeps today's "one JSON document" design
intact and only changes where the document lives.

### Blocker 2 — the health ping times out before a sleeping host wakes

`app/src/lib/api.ts:35` — `DEFAULT_TIMEOUT_MS = 8000`, used by `/health` and
`/usage`. Onboarding validates the server URL with that ping.

On a scale-to-zero host the first request after idle takes 30–60 s. Onboarding
will report *"Server did not respond within 8s"*, which reads as **"you typed
the URL wrong"** — the user re-types a correct URL repeatedly and concludes the
app is broken.

**Fix**, in order of preference:

1. Give `/health` its own longer budget (60 s) with a distinct UI phase —
   *"waking the server, this takes up to a minute the first time"*. The 8 s
   default stays correct for everything else.
2. Retry the ping once on timeout before showing an error.
3. Only if neither is enough: an external free uptime pinger every 10 minutes to
   keep the host warm. Note this burns the free tier's monthly instance-hours
   and on a 750 h/month allowance leaves no margin, so treat it as a last
   resort rather than the default.

### Blocker 3 — a second instance corrupts the ledger

`tryReserve` / `releaseReservation` are read-modify-write against one document
with no compare-and-swap. Two instances can each read $20 spent, each reserve
$8, and each write back $28 — $36 of real spend recorded as $28.

**Fix.** Pin **max instances = 1** on whichever host. Free tiers give one
instance by default, so this is a setting to confirm rather than to build. If
the ledger ever moves to Turso/Postgres, upgrade the reservation to a
conditional write and the constraint disappears.

---

## Host options

Verify current terms — this is the section most likely to have drifted.

| Host | Free basis (**verify**) | SSE | Body cap | Cold start | Billing account? |
|---|---|---|---|---|---|
| **Google Cloud Run** | Perpetual monthly free allowance, not a trial | Yes | 32 MB | ~2–5 s | **Required** (not charged within the allowance) |
| **Render** (web service) | Monthly instance-hours; sleeps after ~15 min idle | Yes | No hard cap | ~50 s | No |
| **Oracle Cloud Always Free** | Always-on ARM VM with a persistent disk | Yes | You control it | None | Card for identity |
| **Cloudflare Workers** | Large daily request allowance | Native | 100 MB | ~0 | No |
| Fly.io | Pay-as-you-go; small usage is cheap, not free | Yes | — | Fast | Yes |
| Vercel Hobby | — | Limited | **4.5 MB** | — | **Disqualified** by the body cap |

### Recommended — Render + Upstash

Chosen for one reason: **no billing account anywhere in the stack**, which is
what "only free resources" most often means in practice. You cannot be
surprised by an infrastructure bill because no payment method exists to charge.

The cost is Blocker 2 — 50-second cold starts — and this app is the rare one
that can absorb it.

```
Phone ──HTTPS──> Render web service (1 instance, sleeps when idle)
                        │
                        ├── Upstash Redis (usage ledger, survives restarts)
                        └── Model provider API  ← the only thing that costs money
```

### Alternative — Cloud Run + Turso

Better engineering: ~3 s cold starts instead of 50, a real container you can run
identically on your laptop, and generous limits. The tradeoff is that the free
allowance requires a billing account on file. It genuinely does not charge
within the allowance, but if the point of "free only" is *no card attached*,
this fails that test.

### Alternative — Oracle Always Free VM

The only option needing **zero code changes**: a persistent disk means Blocker 1
disappears and `USAGE_FILE` keeps working as designed. Always on, so Blocker 2
disappears too.

Against it: you own a Linux box — patching, TLS renewal, process supervision,
firewall. Account approval is unreliable and idle Always Free instances have
historically been reclaimed. Choose this only if running a VM sounds like
something you want to do, not as the path of least resistance.

---

## Steps

Ordered so nothing is wasted if you stop partway.

### 0 — Version control first

There is no git repository. Seven phases and 1,584 tests exist as untracked
files on one machine. Do this before touching deployment; every host below
deploys *from a repo*.

```bash
cd ~/Desktop/project
git init
git add -A          # .gitignore already excludes .env, data/, node_modules/
git status          # CONFIRM no .env and no data/usage.json are staged
git commit -m "UPSC mentor: phases 0-7, app + server"
```

Then a **private** remote. The repo contains no secrets — the key lives only in
the host's environment — but it contains your study history and DAF profile.

Two things were wrong in `app/.gitignore` and are now fixed, both of the same
kind — an ignore rule quietly discarding something that mattered:

- A bare `example` pattern would have excluded any file or directory named
  `example` anywhere in the app tree.
- `/android` was ignored as a regenerable folder. It is not purely regenerable
  here: `gradle-wrapper.properties` carries `networkTimeout=300000`, raised from
  the 10 s default because 10 s cannot fetch the 137 MB Gradle distribution. A
  fresh clone without it fails the build, and the failure presents as a network
  problem rather than a missing setting. The folder is tracked until that fix
  moves into a config plugin.

### 1 — Clear the blockers

- [ ] `LedgerStore` port + remote adapter (Blocker 1)
- [ ] Longer `/health` budget with a "waking the server" phase (Blocker 2)
- [ ] Confirm max-instances = 1 (Blocker 3)

### 2 — Make the server deployable

- [ ] `Dockerfile` (Cloud Run) **or** confirm Render's Node build runs
      `npm run build` — it copies `*.md` prompts and `sources.json` into `dist/`,
      and `index.ts` asserts they compiled, so a build that skips it fails the
      health check rather than the first paid request. That guard is already
      written; make sure the build script actually runs.
- [ ] Verify `PORT` is read from the environment — `config.ts:35` already does.
- [ ] Set `NODE_ENV=production`. This is load-bearing: `index.ts:32` refuses to
      start with `EVAL_RUNNER=fake` in production, so a fake runner can never
      serve invented marks to a real study session.

### 3 — Secrets, as host environment variables only

```
ANTHROPIC_API_KEY   ← never in the repo, never in the app, never in an image layer
APP_BEARER_TOKEN    ← openssl rand -hex 32
MODEL_EVALUATION    ← now required; the server refuses to boot without it
MODEL_BULK          ← same
USAGE_STORE=remote  + its credentials
MONTHLY_USD_CAP=30  and the sub-caps
```

### 4 — Smoke test before pointing the phone at it

```bash
curl https://<host>/health          # 200 + prompt versions + caps. No token needed.
curl https://<host>/usage           # 401 without a token — proves auth is on.
curl -H "Authorization: Bearer $TOKEN" https://<host>/usage   # 200
```

If `/health` returns 200 but omits `mcq`/`ca`/`drills`/`interview` versions, the
build did not copy the prompts. Fix that before spending anything.

### 5 — Point the app at it

Change the server URL in the app to `https://<host>`. Drop the `adb reverse`
bridges. First real (non-fake) run is the moment model spend begins — watch
`/usage` after the first evaluation and confirm the ledger persisted across a
deliberate restart. **Restart the host and re-read `/usage`.** If the number
resets to zero, Blocker 1 is not actually fixed and the cap is not real.

---

## Deliberately not done

- **No CI.** Free CI minutes exist, but with one developer and a local `npm test`
  that runs in 30 seconds it buys little. Revisit if a second machine appears.
- **No staging environment.** A second free instance doubles the cold-start
  surface and halves the instance-hour allowance for a single-user app.
- **`/health` stays unauthenticated.** It exposes rubric versions and spend
  totals to anyone with the URL. That is a deliberate trade so uptime probes and
  the app's wake-ping work without carrying the token. If the URL becomes
  public, move `caps` behind auth and leave liveness open.


---

## The Render config, and what is deliberately NOT in it

`render.yaml` at the repo root is minimal on purpose. A Blueprint that a parser
rejects is worse than a plain one — the failure is "An error occurred" with no
line number, and every explanatory comment is another thing that might be the
cause. The reasoning lives here instead.

### Fields left out, and why

- **`numInstances`** — the free plan rejects it and is fixed at one anyway. But
  one instance is a CORRECTNESS requirement, not a cost one: `tryReserve` and
  `releaseReservation` are read-modify-write against a single document with no
  compare-and-swap, so two instances can each read $20 spent, each reserve $8,
  and each write back $28 — recording $36 of real spend as $28. **If this ever
  moves to a paid plan, set `numInstances: 1` in the same change.**
- **`region`** — Render picks a default. Naming one that a plan does not offer
  is a Blueprint error with no useful message.
- **`GEMINI_API_KEY` / `MODEL_EVALUATION` / `GROQ_API_KEY` / `MODEL_BULK`** —
  added in the dashboard after the first deploy, not declared here. A `sync:
  false` var with nothing to sync is one more thing that can fail validation
  before anything has been built.

### Set in the dashboard after the first deploy

| Key | Value |
|---|---|
| `PROVIDER_BULK` | `groq` |
| `GROQ_API_KEY` | your Groq key |
| `MODEL_BULK` | `openai/gpt-oss-120b` |
| `PROVIDER_EVALUATION` | `gemini` — only once you have a key |
| `GEMINI_API_KEY` | from aistudio.google.com/apikey |
| `MODEL_EVALUATION` | `gemini-2.5-flash` |

A tier with NEITHER a key nor a model is a supported state: its routes answer
503 and everything else runs. A tier with one of the two refuses to boot, and
the message names the missing variable — see the per-tier assertion in
`config.ts`.

`NODE_ENV=production` is load-bearing rather than conventional: `index.ts`
refuses to start with `EVAL_RUNNER=fake` under it, so a scripted runner can
never serve invented marks to a real study session.

### If the Blueprint still errors

Use **New → Web Service** instead and set the same fields by hand:

- Repository: the private repo, branch `main`
- Root directory: `server`
- Build: `npm ci && npm run build`
- Start: `npm start`
- Health check path: `/health`
- Instance type: Free

The manual path validates each field as you type it, so a rejection names the
field rather than the file. `render.yaml` is a convenience, not a requirement.

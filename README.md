# AI QA Tester

AI-powered end-to-end testing for any web app, run through a real browser. You give it a URL and a goal in plain English, for example *"test the login flow with valid and invalid passwords"*. A local LLM (Ollama) acts as the QA engineer:

1. **Reads the page.** It builds a compact snapshot of the headings, messages, interactive elements and visible text.
2. **Plans test cases.** It writes a happy path plus negative cases, with concrete test data.
3. **Drives Chromium** (Playwright) turn by turn: fill, click, select, press, navigate, assert. It batches the actions of one form into a single turn.
4. **Verifies results.** A "pass" must quote evidence from the page, and the runner turns that quote into a real `assert_text` step.
5. **Explains failures** in plain language: application bug, test issue, or environment. A vision model can also look at the screenshot.

You watch the browser live in the dashboard while this happens. Every AI run is recorded as a deterministic script you can save, edit, replay without the AI, or export as a Playwright `.spec.ts`.

```
┌────────────── docker compose ──────────────────────────────────────────┐
│                                                                        │
│  app (Node.js, :8080)          browser (Playwright server)   ollama    │
│  ├─ dashboard (HTML/JS)  ws    ├─ headless Chromium           (:11434) │
│  ├─ REST + WebSocket  ───────► │  video, trace, CDP           LLM      │
│  ├─ AI agent loop  ───────────────────────────────────────────►        │
│  └─ runs/scripts on volume  ◄── CDP screencast frames (live view)      │
└────────────────────────────────────────────────────────────────────────┘
```

## Quick start

Requirements: Docker with Compose v2. That's all; nothing else is installed on the host.

```bash
cd ai-qa-tester
./start.sh
# → http://localhost:8080
```

`start.sh` does the following:

1. Checks that Docker and the daemon are available.
2. Detects your hardware (CPU cores/SIMD, RAM, NVIDIA GPU + VRAM) with `scripts/detect-hardware.sh` and picks a model (see below). The choice is written to `.env`.
3. Stops a standalone `ollama` container if one holds port 11434. Compose runs its own Ollama on the **same `ollama` volume**, so models you already downloaded are reused.
4. Runs `docker compose up -d --build`, adding the GPU override when an NVIDIA GPU and the Container Toolkit are present.
5. Pulls the chosen model, with progress shown in the terminal, then waits for the dashboard.

Other commands: `./start.sh --redetect` re-runs hardware detection; `./start.sh --down` stops everything. Without the script, use `cp .env.example .env && docker compose up -d --build`. The app pulls a missing model itself on startup.

## Model choice

The default family is **`qwen3-vl` (instruct variants)**:

- **Tool calling and strict JSON:** each agent turn is a JSON-schema constrained response (Ollama structured outputs), so even small models return valid actions.
- **Vision:** the same model can read a failure screenshot.
- **No hidden "thinking" tokens:** reasoning models spend minutes per turn on CPU.

| Hardware | Model | Vision for failure analysis |
|---|---|---|
| NVIDIA ≥ 22 GB VRAM | `qwen3-vl:30b-a3b-instruct` (MoE, ~3B active, fast) | yes |
| NVIDIA 9–21 GB VRAM | `qwen3-vl:8b-instruct` | yes |
| NVIDIA 5–8 GB VRAM | `qwen3-vl:4b-instruct` | yes |
| CPU, ≥ 16 cores and ≥ 30 GB RAM | `qwen3-vl:8b-instruct` | off (speed) |
| CPU, ≥ 7 GB RAM | `qwen3-vl:4b-instruct` | off (speed) |
| CPU, < 7 GB RAM | `qwen3-vl:2b-instruct` | off |

**What was chosen on the build machine, and why.** The machine has an Intel Xeon Platinum 8370C (4 vCPU, AVX-512), 15 GB RAM and no GPU, so it gets **`qwen3-vl:4b-instruct`**. Candidates were benchmarked on a real "decide the next browser actions" prompt:

| Model | Correct actions (refs + demo credentials) | Time per turn (cold / cached prefix) | Vision |
|---|---|---|---|
| `qwen2.5:3b` | inconsistent (wrong order, made-up credentials) | ~38 s / ~7 s | no |
| `llama3.2:3b` | no (missing refs) | ~72 s | no |
| `qwen2.5:7b` | yes | ~106 s (≈2× slower) | no |
| **`qwen3-vl:4b-instruct`** | **yes** | **~50 s / ~20 s** | **yes** |

### Changing the model

Any of these work:

- **Dashboard:** go to **Settings** and pick an installed model, or type any tag from [ollama.com/library](https://ollama.com/library) and click **Pull**. The change takes effect on the next run.
- **`.env`:** set `OLLAMA_MODEL=qwen3-vl:8b-instruct`, and optionally `VISION_MODEL=...` to send failure screenshots to a vision model. Then run `docker compose up -d`. A missing model is pulled automatically (`OLLAMA_AUTO_PULL=true`).
- **CLI:** `docker compose exec ollama ollama pull <model>`, then select it in Settings.

To use an Ollama you already run elsewhere (for example natively on a Mac for Metal acceleration), set `OLLAMA_URL` for the `app` service, for example `http://host.docker.internal:11434`, and remove the `ollama` service.

## Using the dashboard

The **Run** tab has three areas:

- **Input panel:** enter the target URL and test goal. Example chips fill in public demo sites.
  - Switch to **Saved script** to replay a script instead.
  - **Run / Pause / Stop:** Pause takes effect after the current action. Stop aborts the in-flight LLM call, marks the remaining tests as skipped, and still saves video, trace and report.
- **Live browser:** the test browser, streamed from Chromium's CDP screencast over WebSocket. The address bar follows navigation.
- **Step log:** every AI decision (💭 reasoning and verdict, with LLM time per turn) and every browser action with pass/fail and duration. Other tabs show:
  - **Failures:** AI explanation plus screenshot.
  - **Console:** JS errors and uncaught exceptions.
  - **Network:** failed requests and HTTP ≥ 400 responses.
- **Result:** passed, failed and skipped counts, plus duration. Downloads:
  - a self-contained **HTML report** with embedded screenshots
  - **video** (`.webm`)
  - **Playwright trace**: `npx playwright show-trace trace.zip`, or drop it on trace.playwright.dev

The result panel also has three buttons:

- **Re-run** asks the AI again.
- **Replay steps** runs the recorded actions deterministically, without the AI.
- **Save as script** stores the recorded actions as a script.

**History** lists every run. You can open it (step log, failures, video), re-run it, replay it, view its report, or delete it.

**Scripts** is a JSON editor for saved scripts, with **Run** and **Export .spec.ts**. Steps use the same actions as the agent:

```json
{ "action": "fill", "target": { "css": "#username", "role": "textbox", "name": "Username", "label": "Username" }, "value": "tomsmith" }
```

A `target` lists several locator strategies: `css`, `role`+`name`, `label`, `placeholder` and `text`. Replay uses the first one that matches a single element, which makes recorded scripts resilient to small DOM changes. Actions are `goto, click, fill, select, check, uncheck, press, hover, scroll, wait, back, assert_text, assert_no_text, assert_url, assert_title, assert_visible`.

## Example run against a public demo site

Target: <https://the-internet.herokuapp.com/login>
Goal: *Test the login flow with valid and invalid passwords*

Here is what the agent did on the CPU-only build machine (step log, abridged). The result was 4 passed, 0 failed in 8m 52s:

```
[  0s] Run started (AI agent) → https://the-internet.herokuapp.com/login
[ 89s] AI  Planned 4 test case(s): Valid login with demo credentials · Login with incorrect password ·
           Login with empty password · Login with empty username
[ 89s] ▶ Test 1/4: Valid login with demo credentials
[149s] AI  Fill in the username and password fields with demo credentials and submit the form. (60.6s)
[149s] ✓ fill Username "tomsmith"
[149s] ✓ fill Password "••••"
[152s] ✓ click Login
[180s] AI  The user has successfully logged in, as evidenced by the success message and the secure
           area page. → verdict: pass (28.7s)
[180s] ✓ assert_text "You logged into a secure area!"     [evidence for the pass verdict]
[181s] Test 1 passed
[181s] ▶ Test 2/4: Login with incorrect password
[217s] AI  Fill in the username and password fields with incorrect values and submit the form… (35.4s)
[217s] ✓ fill Username "tomsmith"
[217s] ✓ fill Password "••••"
[218s] ✓ click Login
[243s] AI  The page displays an error message indicating an invalid password… → verdict: pass (25.3s)
[243s] ✓ assert_text "Your password is invalid!"
[244s] Test 2 passed
  … tests 3 and 4 (empty password / empty username) pass the same way …
[532s] Finished: 4 passed, 0 failed, 0 skipped in 531.8s
```

The run also flagged real problems on the demo site itself:

- **Console:** `jQuery is not defined` and `$ is not defined` (uncaught exceptions).
- **Network:** HTTP 503 for `jquery-1.11.3.min.js` and `foundation.alerts.js`, plus blocked analytics calls.

These appear in the Console and Network tabs and in the report.

After the run, **Save as script** turns the recorded steps into a deterministic script, including the evidence assertions. **Export .spec.ts** then produces a normal Playwright test, which was verified to pass with `npx playwright test`.

The same flow is also preloaded as a saved script, **"Example: the-internet login (valid + invalid)"**. To try it, go to **Run → Saved script → Run**. It replays in about 10 seconds with no AI involved.

More goals to try (also available as chips in the UI):

- `https://www.saucedemo.com/`: *Log in as standard_user, add the Sauce Labs Backpack to the cart and verify the cart badge shows 1*
- `https://demo.playwright.dev/todomvc/`: *Add two todo items, mark the first one completed and verify that "1 item left" is shown*

## Configuration

Environment variables for the `app` service (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `qwen3-vl:4b-instruct` | Agent model (initial value; Settings tab overrides) |
| `VISION_MODEL` | *(empty)* | Model that receives failure screenshots |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama endpoint |
| `OLLAMA_AUTO_PULL` | `true` | Pull missing models automatically |
| `BROWSER_WS_ENDPOINT` | `ws://browser:3000/` | Playwright server; empty = launch Chromium inside the app container |
| `MAX_TESTS` / `MAX_STEPS_PER_TEST` | `4` / `8` | Agent budget (test cases per goal / AI turns per test) |
| `SNAPSHOT_MAX_ELEMENTS` / `SNAPSHOT_MAX_TEXT` | `40` / `700` | Page snapshot size; smaller = faster on CPU |
| `ACTION_TIMEOUT_MS` | `8000` | Per-action / assertion timeout |
| `APP_PORT` / `OLLAMA_HOST_PORT` | `8080` / `11434` | Host ports |

Data (runs, artifacts, scripts, settings) lives in the `qa-data` volume at `/data`.

## Running without Docker (development)

```bash
npm install && npx playwright install chromium
docker run -d -p 11434:11434 -v ollama:/root/.ollama --name ollama ollama/ollama
npm run dev        # http://localhost:8080, launches Chromium locally
```

## Performance notes (CPU-only)

- Each agent turn re-sends the page snapshot. Ollama caches the static system-prompt prefix, so turns after the first are about 2–3× faster.
- Batched actions (fill, fill, click in one turn) and the evidence-based verdict keep a typical test case to **2–3 LLM turns**.
- Only one run executes at a time, because one local model cannot serve parallel agents well.
- Failure analysis takes about 1 minute text-only. With a screenshot (`VISION_MODEL`), it took about 3.5 minutes per failure on the 4-vCPU build machine, which is why vision is off by default on CPU.
- On a GPU, the whole loop is much faster, and screenshots are used for failure analysis.

Measured on the build machine (4 vCPU, no GPU):

| Run | Result | Time |
|---|---|---|
| AI: the-internet login, valid + invalid passwords (4 planned tests) | 4 passed | 8m 52s |
| AI: saucedemo log in → add backpack → cart badge shows 1 | 1 passed | 3m 18s |
| Replay of the saucedemo AI run (recorded steps, no LLM) | 1 passed | 4s |
| Saved script: the-internet login example | 2 passed | ~10–40s (site speed varies) |

## Project layout

```
server/
  index.js     REST API + WebSocket fan-out, single active run
  runner.js    run lifecycle: browser, screencast, console/network capture, pause/stop, artifacts
  agent.js     planning, per-turn decisions, evidence verification, failure explanation (prompts + schemas)
  snapshot.js  in-page extraction of the LLM view + replayable locators
  actions.js   step executor shared by AI runs and script replays
  ollama.js    Ollama client: health, auto-pull with progress, structured chat
  report.js    self-contained HTML report
  codegen.js   script → Playwright Test spec
  store.js     runs/scripts on disk
public/        dashboard (plain HTML/CSS/JS)
scripts/detect-hardware.sh   hardware → model recommendation
examples/      scripts seeded on first start
```

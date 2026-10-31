# OpenBench - trusted sharing of underused spaces & equipment

> Hackathon problem statement: **Unlock Underused Equipment and Spaces**
> Focused use case: **one institution (a fictional engineering college) sharing its Fab Lab, computing lab, media centre, electronics bench and rooms with verified students, researchers, startups and community groups.**

OpenBench is not "a booking calendar". Every booking moves through **eligibility -> human approval -> check-in with condition -> return with condition -> incident handling -> auditable history**, with **explainable fair-allocation** so nobody can monopolise scarce equipment.

## Run it (30 seconds, zero dependencies)

Requires **Node.js 22.5+** only (uses the built-in `node:sqlite` and `node:http`; there is no `npm install`).

```bash
node server.js            # http://localhost:3000
node test/smoke.js        # 60 end-to-end API checks (starts its own server + temp DB)
```

Environment variables: `PORT` (3000), `DB_PATH` (data/openbench.db), `DEMO_MODE` (default `true`; lets judges check in before the slot starts and enables the *Reset demo data* button; set `false` for production), `INSTITUTION_TZ` (Asia/Kolkata).

Demo data is seeded automatically on first start. **All demo accounts use password `demo1234`** - or use the one-click buttons on the login page.

| Account | Role |
|---|---|
| ananya@openbench.demo | Student (laser + 3D-print certified) |
| vikram@openbench.demo | Startup founder (missing training) |
| tom@openbench.demo | Community member (**unverified**) |
| sara@openbench.demo | Researcher (heavy GPU use -> fairness example) |
| ishaan@openbench.demo | Student (1 strike, waitlisted request) |
| owner.fablab@openbench.demo | Owner - Fab Lab |
| owner.media@openbench.demo | Owner - Media, computing, rooms |
| manager@openbench.demo | Lab manager (supervised check-in, returns) |
| admin@openbench.demo | Administrator |

## Deploy a public link

**Render (free):** push this folder to GitHub -> *New > Web Service* -> pick the repo -> it reads `render.yaml` (Node 22, start command `node server.js`). Free instances sleep when idle and the disk is ephemeral, so data resets on restart - fine for judging (the app reseeds itself; admins also have a *Reset demo data* button).
**Railway / Fly.io / any Docker host:** a `Dockerfile` is included.
Open the deployed URL once before submitting and again just before judging to wake it up.

## Project layout
```
server.js   HTTP server, routing, all workflow rules (eligibility, fairness, conflicts, approvals, check-in/out, incidents, sweep job)
db.js       SQLite schema + hash-chained audit log
lib.js      time-zone maths, password hashing
seed.js     fictional demo data
public/     single-page front-end (index.html, app.js, style.css) - no build step
test/       end-to-end API test
docs/       project report (submission PDF source) and testing notes
```

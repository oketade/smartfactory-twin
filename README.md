# SmartFactory Twin 2.0

A browser-based industrial maintenance competition for the classroom. Each student runs Hall A (three machines) for one 6-minute shift. They keep the machines producing, prevent breakdowns and complete four missions. The host starts the shift for everyone at once, and a live leaderboard and a winner announcement follow.

It is plain HTML, CSS and JavaScript with **no build step**. It runs on GitHub Pages, with Supabase as the optional backend.

> This is a logic and design prototype for the group's Unreal Engine build. All temperatures come from a simple heat model, not from sensors.

---

## Run it locally

Any static file server works. From this folder, run one of these:

```bash
python -m http.server 8000        # then open http://localhost:8000
# or
npx serve .                        # then open the URL it prints
```

Opening `index.html` by double-clicking mostly works too, but a local server is recommended because some browsers restrict storage on `file://` pages.

With `js/config.js` left empty (the default), the app uses the **mock backend**. Everything runs inside your browser, and the top bar shows `MOCK BACKEND · SIMULATED DATA · THIS BROWSER ONLY`.

### Classroom demo with 25 players on one computer

1. Open the page and choose **Host a competition** (Individual or Teams).
2. In the lobby, press **Fill to 25** to add simulated players. They are labelled `SIM` everywhere and are played by a computer strategy with varied skill. They are **not** real students.
3. Optional: open the join link in **another browser window** (`?join=CODE`) and register as a real player. Every tab or window is a separate player.
4. In team mode, press **Assign teams automatically**. Start also does this if you forget.
5. Press **Start competition**. Everyone gets a 5-second countdown, then the same factory, the same scripted faults and the same random noise.
6. During the shift, the host can break a machine or cause a coolant fault for every student. The event lands 3 shift-seconds later, at the same moment for everyone.
7. At 6:00 results are submitted automatically. Press **Announce winners** to show the podium (3rd → 2nd → 1st).

Tip: if the host closes their tab by accident, they can open the page again in the same browser and press **Resume hosting CODE** on the home screen. This works for up to 12 hours. Keep the host tab open during the shift anyway, because it ends the shift at 6:00.

Tip: Chrome slows down timers in background **tabs**. For a multi-window test, put the windows side by side. The game follows the shared clock and catches up, but a hidden tab updates less smoothly.

### Practice mode

**Practice** on the home screen is the original 1.0 single-player shift. It is unchanged: pause, time ×4, restart, the instructor panel (`I`), and the class leaderboard with result codes stored on this device.

---

## Gameplay (unchanged from 1.0)

| | |
|---|---|
| Machines | Press A, Cutter B, Oven C (Oven C starts hot at 70 % health) |
| Heat model | heat = H × speed (× 2 with a coolant fault); cooling to 25 °C ambient |
| Breakdown | above 95 °C for 5 s, or health reaches 0 % |
| Repair | switch OFF, then hold Repair (button or `R`) for 3 s |
| Speed | 0.5× – 2.0×; output = 4 units/s per running machine × speed |
| Scripted events | 2:30 Cutter B coolant fault · 4:30 Oven C trip · 6:00 shift ends |
| Missions | 1 switch off the overheating machine · 2 all green for 60 s · 3 600 units in 60 s · 4 full production for 30 s |
| Score | output + 150 per mission − 200 per breakdown |

Keys: `1` `2` `3` select · `E` ON/OFF · hold `R` repair · `+` `−` speed · `Space` pause (practice only) · `I` instructor panel (practice only).

**Changes needed for a fair competition:**

- The simulation now uses a **seeded random generator** and **fixed 0.1 s ticks**. Every student in a competition gets identical noise, and the result no longer depends on frame rate. All other rules and numbers are unchanged.
- Pause, time ×4 and restart are only available in practice. In a competition they would break the shared clock.
- The 4:30 Oven C trip still counts as a breakdown (−200) for everyone, as in 1.0. It hits every student equally, so it does not change rankings.
- If a student reloads mid-shift, the shift resumes from where it was (state is saved every 2 s in the tab).

---

## Project structure

```
index.html            all screens: home/registration, lobby, control room, host console, winners
css/style.css         dark navy + cyan control-room theme, responsive layout, podium + animations
js/config.js          Supabase URL + anon key (empty = mock backend)
js/sim.js             simulation engine (no DOM) — heat, wear, faults, missions, scoring preview
js/bot.js             simulated players (mock only)
js/rules.js           mock-server rules: validation, team assignment, ranking (mirrors schema.sql)
js/net-mock.js        mock backend (localStorage + BroadcastChannel, this browser only)
js/net-supabase.js    real backend adapter (Supabase RPC + Realtime + anonymous auth)
js/floor.js           SVG plant floor
js/board.js           roster, live leaderboard, podium, winner announcement, confetti
js/game.js            control room UI (practice + competition)
js/app.js             screens, registration, lobby, host console, backend selection
supabase/schema.sql   tables, row-level security, Realtime, server-side functions
```

Both backends implement the same interface (`createCompetition`, `joinCompetition`, `startCompetition`, `submitResult`, `watch`, …), so the UI does not know which one it is talking to.

---

## Connect the real backend (Supabase)

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Sign In / Providers → enable "Anonymous sign-ins".** Students get an identity without an account or e-mail.
3. **SQL Editor →** paste and run `supabase/schema.sql`. It is safe to run again after changes.
4. **Project Settings → API:** copy the **Project URL** and the **anon public** key into `js/config.js`:

   ```js
   SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...',
   ```
5. Reload. The top bar now shows `LIVE · SUPABASE`. Add `?backend=mock` to the URL to demo with the mock backend even when Supabase is configured.

### Security model

- **Only the anon key is in the frontend.** It is designed to be public. **Never** put the `service_role` key in this repository.
- Row-level security: a user can only **read** competitions they host or joined. There are **no** insert/update/delete policies. Every change goes through `SECURITY DEFINER` functions (`sf_join`, `sf_start`, `sf_submit`, …), which check who is calling.
- Only the host (the creator of the competition) can start or end it, assign teams, remove players, send host events and announce winners.
- **Scores are calculated on the server** (`sf_score`). The browser sends only raw statistics: output, breakdowns and missions.
- `sf_submit` runs **plausibility checks**:
  - the submission arrives within the shift window, plus 60 s grace
  - output is no more than 24 units/s × elapsed time (max 8,640)
  - missions are 0–4
  - there is one final result per player
  - values never go backwards
  - progress reports are throttled to one every 2 s
- **Known limit:** the server does not replay the simulation. A student with developer tools could submit an inflated result that is still plausible. Full replay validation, where the client sends its input log and the server re-runs the deterministic engine, is possible because the engine is now seeded and fixed-step, but it is not implemented.
- Simulated players exist only in the mock backend. The Supabase version only ever shows real, connected students.

### What has and hasn't been tested

- **Tested:** the full mock flow in Chrome. This covered a host with 25 simulated players plus 2 real player tabs in team mode, a host event, automatic submission, the winner announcement, the phone layout and practice mode.
- **Not yet tested against a live Supabase project:** `schema.sql` and `net-supabase.js` are written to the Supabase v2 APIs but have not been run against a real database. Do a dry run with a few devices before the first class.

---

## Deploy to GitHub Pages

1. Create a GitHub repository and push this folder. `index.html` must be at the root.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`. Share that URL, or the `?join=CODE` link the host console shows.

`.nojekyll` is included so GitHub serves the files as-is. Supabase works from any origin, so no extra CORS setup is needed.

# Agent Room: live view of your Hermes agents

A normal website that shows your Hermes agents working in real time: who talks to whom,
handoffs between stages, the 3 parallel developers, approval gates, commits, PRs, CI and merges.

```
Website (order box) ──► Supabase ──► bridge on the VM ──► Hermes API server (127.0.0.1) ──► agents work
Hermes plugin ──(events, HTTPS out)──► Supabase ◄──(every 2 s)── Website (live board)
```

You give orders on the website ("Create a calculator"), answer the agents' questions there, and press
Approve on the BRD (gate G1). After that the agents finish on their own: the bridge approves G2 and
G3, tells them to use their best judgment on any other question, and approves commands Hermes asks
about, until the release is live. Stop the run takes back control. To approve every gate yourself
instead, add `"auto_after_brd": false` to `~/.hermes/agent-room/config.json` and run
`systemctl --user restart agent-room-bridge`. Telegram keeps working too, as a separate conversation.

- No open port on your server. The plugin only sends data out.
- The plugin only watches. It never blocks or changes what the agent does. Secrets are removed
  and file contents are never sent.
- Three keys: the **write key** stays on your server, the **read key** lets a link watch, and the
  **send key** lets a link give orders. Share a link with only `#read=` to let someone watch
  without being able to command the agents.
- The Hermes API server listens on 127.0.0.1 only. Nothing new is opened to the internet: the
  bridge only makes HTTPS requests out to Supabase.

## Folder

| Path | What it is |
|---|---|
| `web/index.html` | The website. Upload this to GitHub Pages. |
| `plugin/agent-room/` | The Hermes plugin (goes to `~/.hermes/plugins/agent-room/`). |
| `install.sh` | Installs the plugin on the server. |
| `tools/simulate_run.py` | Plays a fake pipeline run through the real plugin, for testing. |
| `bridge/agent_room_bridge.py` | Takes website orders from Supabase and runs them in Hermes (systemd user service `agent-room-bridge`). |
| `supabase/setup.sql` | Database setup. Already done on your project `hermes-agent-room`. Only needed for a new project. |
| `server/` | Optional local server (old way, needs port 8787). Not needed with Supabase. |

## 1. The website (done)

Hosted on Vercel (project `hermes-agent-room`):
`https://hermes-agent-room.vercel.app/#read=<READ_KEY>`

Without the `#read=` part, the page still opens and shows the example run.
To host it somewhere else instead, upload `web/index.html` to any static host (GitHub Pages works too).

## 2. Install the plugin on the server

One command on the VM, nothing to copy over (it downloads the files from the website and checks
their SHA-1 sums first):

```bash
curl -fsSL https://hermes-agent-room.vercel.app/get.sh | bash -s -- --write-key <WRITE_KEY>
```

Or from a copy of this folder:

```bash
cd agent-room
bash install.sh --write-key <WRITE_KEY>
```

It installs and enables the plugin, saves the Supabase settings in
`~/.hermes/agent-room/config.json` (private, mode 600), checks that the key works, and
restarts the Hermes gateway.

## 3. Test

```bash
python3 ~/agent-room/simulate_run.py
```

It should print `Sent to Supabase: 120 events`, and your dashboard shows a full run. Then send
`/sdlc-project ...` to the bot in Telegram and watch the real agents.

## Keys

To see them: Supabase → project `hermes-agent-room` → SQL Editor:
```sql
select name, value from agent_room.keys;
```
To change one (for example if a link leaked):
```sql
update agent_room.keys set value = md5(random()::text) || md5(random()::text) where name = 'read';
```
For a new write key, run `bash install.sh --write-key <NEW_KEY>` on the server again.

## Useful commands (on the server)

| What | Command |
|---|---|
| Is the plugin on? | `hermes plugins list` |
| Sending errors | `journalctl --user -u hermes-gateway -n 100 \| grep agent-room` |
| Local copy of events | `tail -f ~/.hermes/agent-room/events.jsonl` |
| Uninstall | `bash install.sh --uninstall` |

## How the page reads the events

- The main Hermes agent loads one SDLC skill after another, so its messages show under the stage
  that is running. Orchestrator covers kickoff and development.
- Each sub-agent from `delegate_task` gets a lane (Dev-1, Dev-2, Dev-3). A fix-up sub-agent for an
  existing branch or PR reuses that lane.
- Commits, pushes, PRs, CI, reviews and merges come from the `git` and `gh` commands the agents
  run, and show as messages to the GitHub node.
- A gate (G1, G2, G3) turns amber when the agent asks for approval in Telegram, and green when the
  approval is written to `approvals.md`.
- The board starts fresh on each `/sdlc-project`. Reloading the page rebuilds the current run.

## Notes

- Supabase free projects pause after about a week with no use. Open the Supabase dashboard and
  press **Restore** if the page says "Reconnecting".
- Events older than 30 days are deleted on their own.
- Works with Hermes v0.21.5 and the Claude subscription provider.

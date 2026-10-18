# Devin for Hermes Platform

Devin is coder number 3. It gets one task per project, through the Devin MCP server. Two small parts live here:

| File | What it does |
| --- | --- |
| `config.yaml.snippet` | The `mcp_servers` block for `~/.hermes/config.yaml`. |
| `devin_poller.py` | Watches the Devin sessions of running projects and emits `devin_status` events. Python standard library only. |

## 1. Get a Devin key

1. In Devin, open **Settings**, then **Devin API**.
2. Create a service user and copy its key. It starts with `cog_`. Copy it at once, it is shown one time.
3. Old keys that start with `apk_` do **not** work with the Devin MCP server. Make a new `cog_` key.
4. On an Enterprise plan, or with a personal access token, the requests also need the header `X-Org-Id: <your organization id>`.
   Add it under `headers:` in the snippet. The poller uses `--org-id` or `DEVIN_ORG_ID` for the same reason (see below).
5. Put the key in `~/.hermes/.env` as `DEVIN_API_KEY=cog_...`. Do not put it in `config.yaml` or in git.

## 2. Turn the MCP server on

Merge `config.yaml.snippet` into `~/.hermes/config.yaml` and restart the Hermes gateway.
The allow-list gives the agents only `devin_session_*`, `ask_question` and `read_wiki_*`.
If your Hermes version does not accept `*` in `include`, list the tool names one by one.

## 3. How the `sdlc-development` skill uses it

For a task marked `assignee: devin`:

1. Call `devin_session_create` with:
   - `prompt`: the repository (`https://github.com/<owner>/<repo>`), the branch name, the task text, the files it may change,
     the contract sections to follow, the test and lint commands, and the rule "open a pull request, do not merge it",
   - `max_acu_limit`: the number from the order or the settings. If there is none, use `5`. Never leave it out.
   - `title`: the task title.
2. Write the session down, so the platform can watch it. Append one line (the file may not exist yet):

   ```text
   mkdir -p ~/.hermes/platform
   printf '%s\n' '{"session_id":"<id from the answer>","project_id":"<project id>","task":"Task 3","branch":"feature/x"}' >> ~/.hermes/platform/devin_sessions.json
   ```

   The project id is the one in the project state folder name (`~/.hermes/platform/workspaces/<project id>/`).
3. Check the session with `devin_session_interact`: send a short message such as "Status? Give me the pull request link when it exists."
   Read the answer for the status and the pull request address. Do this every few minutes of other work, not in a tight loop.
4. When the pull request exists, review it like any other coder's (`sdlc-review`). Answer Devin's questions from the contract.
5. If the tools are missing, the session fails, or the ACU limit is reached before the pull request exists,
   build the task yourself (the fallback in the skill).

The exact argument names of the tools come from the tool list Hermes shows after connecting. If a name differs from the ones above, trust the tool list.

## 4. The poller

`devin_poller.py` reads `~/.hermes/platform/devin_sessions.json`, asks the Devin API about each session, and
emits an event when the status or the pull request changes. It stops asking about a session when it has finished or failed.

```text
DEVIN_API_KEY=cog_... python3 devin_poller.py --bridge-state ~/.hermes/platform/bridge_state.json
```

| Option | Meaning |
| --- | --- |
| `--once` | Poll one time and exit. |
| `--bridge-state FILE` | Only poll sessions of projects that are running in the bridge state. Sessions without a project id are always polled. |
| `--events-file FILE` | Append the events to this file as JSON lines. Without it they print on stdout. |
| `--sessions-file FILE` | Default `~/.hermes/platform/devin_sessions.json`. |
| `--org-id ID` | Organization id. With a `cog_` key this switches to the v3 API (`/v3/organizations/<id>/sessions/<session>`). |
| `--interval SECONDS` | Time between rounds. Default 20. |

The key is read from the environment only. The program never prints it and never follows a redirect with it.

The event, one line of JSON:

```text
{"v":1,"ts":1760000000,"type":"devin_status","project":"<project id>","sid":"devin-abc123","session_id":"devin-abc123",
 "status":"working","raw_status":"working","pr":null,"pr_url":null,"finished":false,"text":"Task 3: Devin is working"}
```

`status` is one of `working`, `blocked`, `finished`, `failed`, `suspended`, `unknown`. `pr` is the pull request address once Devin has one.

The bridge runs this poller by itself when `DEVIN_API_KEY` is in `~/.hermes/.env` (and `DEVIN_ORG_ID`, if you have one).
It polls at most every 30 seconds (setting `devin_poll_seconds` in `~/.hermes/platform/config.json`), maps each Devin session to its
project with `platform_map_session`, and sends the `devin_status` events to the website. If Devin cannot be reached the bridge
keeps working and waits longer between tries (up to 5 minutes). `devin_poller.py` must sit next to `platform_bridge.py`
(the installer does this). Without a key the bridge does nothing about Devin.

Tests: `python3 -m unittest hermes.tests.test_devin_poller` (a mock server on 127.0.0.1; no real Devin calls).

# Hermes Platform v2: cut-over runbook

This is the list of things to do, in order, to move from the old Agent Room to Hermes Platform v2.
It is written for Mohammad. You use Windows. Every command is ready to copy.

How long: about 1 to 2 hours the first time. Nothing is deleted. The old Agent Room keeps working
until **Part 4**. Every part says how to go back.

## The big picture

| Part | What happens | Does it touch the old Agent Room? |
| --- | --- | --- |
| 1. Database | Add the new tables to Supabase | No. The old tables are not touched. |
| 2. Website | Put the new website on Vercel as a new project | No. The old site keeps its address. |
| 3. Practice run | Run the VM installer with `--dry-run` (changes nothing) | No. |
| 4. Cut-over | Run the VM installer for real | **Yes. The old bridge stops here.** |
| 5. Test | Build the calculator demo with one click on Approve | No. |
| 6. Team | Invite people | No. |

If anything looks wrong, stop and read **Going back** at the end. Going back is one command.

## What you need

- Windows PowerShell. Press the Windows key, type `PowerShell`, press Enter.
- The SSH key file: `C:\Users\Admin\Downloads\ssh-key-2026-09-30.key`
- Your Supabase account (the same one the old Agent Room uses) and your Vercel account.
- The repository on GitHub, with the branch that has Milestone 2 merged.
- A place to keep secrets (a password manager). **Never** paste a key into a chat, an email or a file in the repository.

## Words used here

- **Write key**: a long secret that only the VM knows. It lets the bridge and plugin write to the database.
- **Public key** (also "publishable key" or "anon key"): the key the website uses. It is safe in the browser. Rules in the database keep data private.
- **Bridge**: the small program on the VM that takes orders from the website and gives them to Hermes.

## Part 1. Database (Supabase)

Why this is safe: the new tables have new names. The old Agent Room lives in its own part (`agent_room`) and is not touched.

1. Open the Supabase dashboard and choose your project.
2. Click **SQL Editor** on the left, then **New query**.
3. Open the five files in the repository folder `supabase/migrations/`, one at a time, in this order. Copy the whole text, paste it in the editor, click **Run**:
   1. `0001_platform.sql`
   2. `0002_rls.sql`
   3. `0003_rpcs.sql`
   4. `0004_seed_owner_invite.sql`
   5. `0005_member_removal.sql`

   After each one you should see **Success. No rows returned**. If you see a red error, stop and send the error text to me.
   Running a file twice is fine, but always keep this order.

4. Make the write key. In PowerShell, copy and run this. It prints one long line. That line is your write key:

   ```powershell
   $b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')
   ```

   Save it in your password manager now. Call it "Hermes v2 write key".

5. Back in the SQL Editor, store the key in the database. Replace `PASTE-THE-KEY-HERE` with your key. Keep the quotes.

   ```sql
   insert into platform_private.keys (name, value)
   values ('write', 'PASTE-THE-KEY-HERE')
   on conflict (name) do update set value = excluded.value;
   ```

6. Find your project address and public key: **Project Settings**, then **API**. You need two things:
   - **Project URL**, like `https://abcdxyz.supabase.co`
   - **Publishable key**, starts with `sb_publishable_`. (If you only see an old "anon" key that starts with `eyJ`, that works too.)

   Do **not** use the `service_role` or `secret` key anywhere in this runbook.

7. Check that the database answers and that a wrong key is refused. In PowerShell (replace the two values):

   ```powershell
   $url = "https://abcdxyz.supabase.co"
   $pub = "sb_publishable_xxxxxxxx"
   $h = @{ apikey = $pub; "Content-Type" = "application/json" }
   # 1. a WRONG key must be refused
   try { Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/platform_ingest" -Headers $h -Body '{"write_key":"wrong","events":[]}' } catch { $_.ErrorDetails.Message }
   # 2. the RIGHT key must work (it stores nothing)
   $key = Read-Host "Paste the write key"
   Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/platform_ingest" -Headers $h -Body (@{ write_key = $key; events = @() } | ConvertTo-Json)
   ```

   You should see: first a message with `platform: wrong write key`, then `0`.

8. Check that strangers see nothing. Still in PowerShell:

   ```powershell
   try { Invoke-RestMethod -Uri "$url/rest/v1/projects?select=id" -Headers $h } catch { $_.ErrorDetails.Message }
   ```

   You should see `permission denied for table projects`. If you see `[]` or data, stop and tell me.

9. Go through the Supabase settings list in `docs/M2_DEPLOY_CHECKLIST.md`, section "Supabase Auth settings" and section "Database checks". It takes 10 minutes.

**Going back from Part 1:** nothing to undo. The new tables do not disturb the old Agent Room. Leave them.

## Part 2. Website (Vercel)

Why this is safe: this is a **new** Vercel project. The old site keeps its address.

1. Open Vercel, click **Add New**, then **Project**, and pick the repository.
2. Set these (details are in `docs/M2_DEPLOY_CHECKLIST.md`, section "Vercel project settings"):
   - **Framework Preset**: Next.js
   - **Root Directory**: `apps/web`
   - **Include source files outside of the Root Directory in the Build Step**: ON. (The website copies the installer files from the folder `hermes/` while it builds. If this is off, the build stops with a clear error.)
   - **Node.js Version**: 22.x
   - Leave the install and build commands alone. They come from `apps/web/vercel.json`.
3. Open **Environment Variables** and add these two for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | the Project URL from Part 1, step 6 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key from Part 1, step 6 |

   Do **not** add `HERMES_TEST_MODE`. Do **not** add any secret key.
4. Click **Deploy**. Wait for the green check.
5. Open the address Vercel shows (we call it `<YOUR-SITE>` below, for example `hermes-platform.vercel.app`).
   You should see the **Sign in** page.
6. Tell Supabase where the site lives. In Supabase: **Authentication**, then **URL Configuration**:
   - **Site URL**: `https://<YOUR-SITE>`
   - **Redirect URLs**: add `https://<YOUR-SITE>/auth/callback`
7. Create your own account. Open `https://<YOUR-SITE>/signup` and sign up with `mhmdhoumani04@gmail.com`.
   Open the email, click the link, then sign in. You should land on **Projects** and see a **Team** link at the top.
   (Your email was added as the first owner by `0004_seed_owner_invite.sql`.)
8. Check the installer files are online. In PowerShell:

   ```powershell
   curl.exe -sI https://<YOUR-SITE>/pkg/get_v2.sh | Select-String "HTTP"
   curl.exe -s https://<YOUR-SITE>/pkg/SHA256SUMS
   ```

   You should see `HTTP/2 200` and a list of 13 lines, each with a long code and a file name.

**Going back from Part 2:** delete the new Vercel project, or just do not share its link. Nothing else changed.

## Part 3. Practice run on the VM (changes nothing)

1. Connect to the VM. In PowerShell:

   ```powershell
   ssh -i "C:\Users\Admin\Downloads\ssh-key-2026-09-30.key" ubuntu@84.235.244.195
   ```

   If Windows says `UNPROTECTED PRIVATE KEY FILE`, run this once on your PC, then try again:

   ```powershell
   icacls "C:\Users\Admin\Downloads\ssh-key-2026-09-30.key" /inheritance:r /grant:r "$($env:USERNAME):R"
   ```

   From here on, the commands run **on the VM** (the prompt starts with `ubuntu@`).

2. Check that the old setup is healthy and nothing is running:

   ```bash
   hermes --version
   gh auth status
   systemctl --user status agent-room-bridge --no-pager | head -5
   ```

   - `hermes --version` prints a version.
   - `gh auth status` says you are logged in to github.com.
   - The old bridge says `active (running)`. That is right: it is still the live one.

   Before you go on, make sure no job is running in the old Agent Room.

3. Put the settings in the shell. The write key is typed without showing on screen: paste it and press Enter.

   ```bash
   export HERMES_PLATFORM_SUPABASE_URL='https://abcdxyz.supabase.co'
   export HERMES_PLATFORM_SUPABASE_KEY='sb_publishable_xxxxxxxx'
   read -rs HERMES_PLATFORM_WRITE_KEY; export HERMES_PLATFORM_WRITE_KEY
   export HERMES_PLATFORM_BASE='https://<YOUR-SITE>/pkg'
   ```

   Also set your GitHub user or organisation, where the new project repositories will be created
   (optional, but recommended). Replace `my-github-name`:

   ```bash
   export HERMES_PLATFORM_GITHUB_OWNER='my-github-name'
   ```

4. Download the installer and read the plan:

   ```bash
   curl -fsSL "$HERMES_PLATFORM_BASE/get_v2.sh" -o get_v2.sh
   bash get_v2.sh --dry-run
   ```

   You should see `DRY RUN: nothing will be changed` and a list of steps. Read it. It shows:
   - the 8 skills it would put in `~/.hermes/skills/`,
   - which Telegram lines it would switch off (names only, never the values),
   - the old bridge it would stop,
   - the new `hermes-platform-bridge` service.

   A dry run does not call Supabase and does not change a single file.

**Going back from Part 3:** nothing to undo.

## Part 4. Cut-over (the old Agent Room stops here)

Do this when nobody is using the old Agent Room.

1. Run the installer for real. It uses the settings from Part 3:

   ```bash
   bash get_v2.sh
   ```

   What it does, in order: checks the write key with an empty test call (if the key is wrong it stops
   **before** changing anything), saves a backup of every file it will change in
   `~/.hermes/backups/<date-and-time>/`, installs the skills, the plugin and the bridge, switches Telegram off,
   makes sure the Hermes API server is on, writes `~/.hermes/platform/config.json`, stops the old bridge,
   restarts Hermes, starts `hermes-platform-bridge`, and runs a self check.

2. Read the summary at the end. You should see:
   - `ok   Supabase accepted the write key`
   - `ok   the Hermes API server answers`
   - a line `Old files saved in: /home/ubuntu/.hermes/backups/...`
   - a line `Undo everything: bash /home/ubuntu/.hermes/platform/install_v2.sh --rollback`

   Copy those two lines somewhere. If the self check says `FAIL`, read **If something goes wrong** below.

3. Make sure the bridge keeps running after you close the window:

   ```bash
   sudo loginctl enable-linger ubuntu
   ```

4. Check each piece:

   ```bash
   systemctl --user status hermes-platform-bridge --no-pager | head -5
   hermes plugins list
   ls ~/.hermes/skills | grep sdlc
   ```

   - The bridge says `active (running)`.
   - The plugin list shows `hermes-platform` as enabled.
   - You see the 8 `sdlc-...` skills.

5. Watch the bridge log in a second PowerShell window (connect with the same `ssh` command). Press `Ctrl+C` to stop watching:

   ```bash
   journalctl --user -u hermes-platform-bridge -f
   ```

**Going back from Part 4:** one command on the VM. See **Going back** at the end.

## Part 5. Test with the calculator demo

1. Open `https://<YOUR-SITE>` and sign in.
2. Click **New project**. Write this idea:

   > A calculator web page. Big buttons for 0 to 9, plus, minus, times, divide, equals and clear. It must work well on a phone.

3. Click **Start project**. Within a minute the status should change from **Queued** to **Discovery**.
   In the VM log you should see the order being taken.
4. The analyst may ask you questions in the conversation. Answer them in the box.
5. When the BRD (the requirements document) appears, read it. Click **Approve BRD**. This is the only approval you give.
6. Wait. The progress bar moves through Architecture, Development, Review, QA and Release.
   - If you see **Paused**, the Claude usage limit was reached. Do nothing. The bridge waits and continues by itself.
   - To stop the work at any time, click **Stop** in the project.
7. At the end the status is **Released** and the project shows its links.

What counts as a pass:

- [ ] The status moved by itself from Queued to Released after one click on Approve BRD.
- [ ] The BRD text is shown on the website.
- [ ] The activity feed shows the agents working, with no secret (no keys, no tokens) visible.
- [ ] Sending a message to the agents works, and so does Stop and then Resume.
- [ ] Telegram does not answer any more.

Be aware: the staging and live links need the project template with its deploy workflow. That template is
part of Milestone 3. Until then the run can reach QA and stop at the release step with a clear note in the
conversation. That still proves the cut-over (orders, phases, BRD, approval, usage pause).

**Going back from Part 5:** nothing to undo. You can delete the demo project later.

## Part 6. Invite the team

1. Open **Team**.
2. Type each person's email, choose **Start their own projects** (or **Owner** for people who should see everything), click **Send invite**.
3. Tell them to open `https://<YOUR-SITE>/signup` with exactly that email.
4. To take someone's access away, open **Team**, click **Remove access** next to their name and confirm.
   They are signed out and can see nothing. Their projects are kept and running work is stopped.
   You can click **Give access back** at any time.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| The website says "This site is not set up yet" | The two settings from Part 2, step 3 are missing or wrong. Fix them in Vercel, then **Redeploy**. |
| Sign-up says "This email is not on the invite list" | Add the email under **Team** first, with the same spelling. |
| The sign-up email does not arrive | Look in spam. Supabase's built-in email sender allows only a few emails per hour. Set up your own email sender in Supabase, under **Authentication** and **SMTP Settings**. |
| The installer says "write key check failed" | The key does not match the one in the database. Check Part 1, step 5, and type the key again. Nothing was changed. |
| The installer self check says `FAIL the Hermes API server` | Run `hermes gateway restart`, wait 20 seconds, then run `HERMES_HOME=$HOME/.hermes python3 ~/.hermes/platform/platform_bridge.py --check`. |
| A project stays on **Queued** | Run `systemctl --user status hermes-platform-bridge`. If it is not running: `systemctl --user restart hermes-platform-bridge`, then read `journalctl --user -u hermes-platform-bridge -n 50`. |
| Telegram still answers | Run `hermes gateway restart`. If it still answers, run the Going back steps, then ask me. |
| You think the write key leaked | In the SQL Editor run `update platform_private.keys set value = 'NEW-KEY' where name = 'write';`, then on the VM run the installer again with `--write-key NEW-KEY`. |

## Going back

On the VM, one command puts back everything the installer changed. It restores the files from the backup,
removes the new plugin and bridge, starts the old bridge again, re-enables the old plugin and restarts Hermes.
Telegram works again too.

```bash
bash ~/.hermes/platform/install_v2.sh --rollback
```

- To see what it would do first, add `--dry-run`.
- Use the backup list `ls ~/.hermes/backups` to see the backups. `--rollback --backup <name>` picks a different one.
- Running `--rollback` again goes back one more step, if you ran the installer more than once.
- The website and the database can stay. They do not disturb the old Agent Room.

If the file `~/.hermes/platform/install_v2.sh` is gone, do it by hand: copy the files from the newest folder in
`~/.hermes/backups/` back (each file sits under `files/` with its full path), then run
`systemctl --user disable --now hermes-platform-bridge`, `systemctl --user enable --now agent-room-bridge`,
`hermes plugins disable hermes-platform`, `hermes plugins enable agent-room` and `hermes gateway restart`.

## Quick stop (emergency)

To stop the agents taking new orders right now, on the VM:

```bash
systemctl --user stop hermes-platform-bridge
```

To also stop a run that is in progress, click **Stop** on the project page, or run `hermes gateway restart`.

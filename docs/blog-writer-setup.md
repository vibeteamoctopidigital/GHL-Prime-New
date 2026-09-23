# Blog writer — server setup

How to set up the automatic blog writer on the production server. Once it is
running, an admin can add a topic in the dashboard, press a button, and get a
finished blog post back without anyone opening a terminal.

This guide is for whoever manages the server. It takes about an hour.

For the full technical reference (tables, file paths, every edge case), see
[BLOG_WRITER.md](BLOG_WRITER.md).

---

## How it works

The feature has two parts, and they talk to each other through the database.

**1. The admin screens** (part of the frontend, `ghlprime-updated`)

- `/admin/blog-writer`: the list of topics, plus the **Write next post** button
- `/admin/blog-schedules`: daily automatic runs

Pressing the button only saves a request in the database. The website cannot
write the post by itself.

**2. The watcher** (`npm run blog:watch` in this backend repo)

This is the part you set up here. It checks the database every 30 seconds. When
it finds a request, it starts Claude Code, which researches the topic, writes
the post, adds images, and saves it under **Blog**.

**Why a watcher and not an API key?** The writing runs on a **Claude
subscription**, so there is no charge per post. A subscription has to be logged
in on a real machine, and this server is that machine.

**Posts are saved as drafts** unless auto-publish is turned on in the writer's
settings. Even with it on, a post only goes live if it passes the quality
check. If it fails, it stays a draft and the screen shows the reason.

---

## Before you start

- SSH access to the production server
- A Claude subscription account to log in with
- The backend already deployed and running
- `DATABASE_URL` and the `CLOUDINARY_*` keys already in the server's `.env`
- A `PEXELS_API_KEY` for post images (without it, posts are written with no
  images)

---

## 1. Deploy the code

```bash
cd /path/to/GHL-Prime-New
git pull
npm install
npx prisma migrate deploy
npm run build
```

Use `npm install`. Do not use `npm ci --omit=dev`, because the watcher needs the
full set of packages.

`prisma migrate deploy` creates the blog writer tables. Deploy the frontend
(`ghlprime-updated`) too, so the admin screens are available.

Restart the backend.

---

## 2. Add the settings

Add these to the server's `.env`:

```env
PEXELS_API_KEY=your-key
BLOG_WRITER_MODEL=sonnet
```

Your existing `DATABASE_URL` and `CLOUDINARY_*` settings are used as they are.

---

## 3. Install Claude Code

Claude Code is the program that actually writes the posts. Install it globally
on the server:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

If `claude --version` prints a version number, it is installed.

---

## 4. Log in to Claude (over SSH)

This step is the one most likely to need a second try, so do it before
anything else depends on it.

**Log in as the same server user that will run the watcher.** The login is
stored in that user's home folder, so a login made by a different user is not
visible to the watcher.

```bash
claude auth login
```

It prints a link. Open it in any browser, sign in with the Claude subscription
account, and paste the code back into the terminal. Follow whatever the command
prints on screen.

If `claude auth login` does not work on the server, use this instead:

```bash
claude setup-token
```

This gives you a long-lived token. If it tells you to set the token as
`CLAUDE_CODE_OAUTH_TOKEN`, add it to the service file in step 6 as an extra
line: `Environment=CLAUDE_CODE_OAUTH_TOKEN=the-token`.

Then check that it works:

```bash
cd /path/to/GHL-Prime-New
claude auth status
claude -p "Reply with exactly: OK"
```

You should see `OK`. **If you don't, stop here.** None of the later steps will
work until this one does.

### Optional: log in from the dashboard (not tested yet)

The admin panel has a page at `/admin/claude-auth` that is meant to do the same
login from the browser, without SSH. **This page has not been tested yet**, so
use the SSH login above as the main method.

If you want to try it:

- The page needs the `node-pty` package to be working on the server. It is
  installed by `npm install`, but it contains native code, so on some servers
  the install fails unless build tools are present
  (`sudo apt install -y build-essential python3`, then `npm install` again). If
  `node-pty` is missing, the page shows an error and tells you to use SSH.
- The backend must run as the **same server user as the watcher**. Otherwise
  the login goes to the wrong user.
- After logging in from the page, still run `claude auth status` and the `OK`
  test above over SSH to confirm the watcher can use the login.

---

## 5. Test the watcher

```bash
npm run blog:watch
```

You should see:

```
blog writer watching
  claude:   (the path to the claude program)
  model:    sonnet
  polling every 30s. Ctrl-C to stop.
  schedules: none set up
```

Leave it running and open `/admin/blog-writer` in the browser. The banner should
say **Writer online**. Then press `Ctrl-C` to stop the watcher. The next step
keeps it running permanently.

---

## 6. Keep it running (systemd)

If you start the watcher in an SSH session, it stops when you disconnect. Run it
as a service instead.

Create `/etc/systemd/system/ghlprime-blog-writer.service`:

```ini
[Unit]
Description=GHL Prime AI blog writer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/path/to/GHL-Prime-New
ExecStart=/usr/bin/npm run blog:watch
Restart=always
RestartSec=15
Environment=HOME=/home/YOUR_APP_USER
StandardOutput=append:/var/log/ghlprime-blog-writer.log
StandardError=append:/var/log/ghlprime-blog-writer.log

[Install]
WantedBy=multi-user.target
```

Replace `YOUR_APP_USER` and the path with your own values. Use the **same user
that logged in to Claude** in step 4.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ghlprime-blog-writer
sudo systemctl status ghlprime-blog-writer
```

With this in place, the watcher restarts on its own after a crash or a server
reboot.

---

## 7. Check it works end to end

1. Open `/admin/blog-writer`. The banner should say **Writer online**.
2. Add a topic, for example `crm automation for small business`.
3. Press **Write next post**.
4. The screen shows progress: research, writing, checking, images, saving.
5. You can watch the log too:

```bash
tail -f /var/log/ghlprime-blog-writer.log
```

A post takes about **5 minutes**. When it is done, the log says
`request ... done`.

6. Open `/admin/blog`. The new post is at the top as a draft. Read it, and
   publish it if it is good.

---

## Scheduled runs

On `/admin/blog-schedules` you can create daily runs, for example "every day at
9:00". Each schedule has its own settings and works in one of two modes:

| Mode | What it writes |
|---|---|
| **Keywords** | The next keywords from that schedule's list, in order. Each keyword is removed from the list once it has been written. |
| **News sites** | Reads the sites you list, picks the best recent story, and writes a post about it. |

Things to know:

- **Schedules only run while the watcher is running.** This is why the watcher
  belongs on the server and not on a laptop.
- **Each schedule runs once a day at most.** Restarting the server does not make
  it run twice.
- **If the server was off at the scheduled time,** the run still happens as long
  as the server comes back within 6 hours. After that, the watcher skips that
  day.
- **Posts are written one at a time,** even when several are due.
- **Keep the volume sensible.** Every post counts against the Claude
  subscription's usage limit. One or two posts a day is a normal pace.

---

## Safety

The watcher only lets Claude use a short list of tools: reading and writing
files, web search, and four of the project's own scripts (`blog:queue`,
`blog:rules`, `blog:audit` and `blog:import`). It cannot run any other
commands, use git, or delete anything. The worst thing a bad run can do is
produce a bad draft, and a person reads every draft before it goes live.

Do **not** change this to `--dangerously-skip-permissions`. That would give an
unattended process full access to a server that holds the database and
Cloudinary credentials.

---

## Cost

- **Writing:** nothing per post. It uses the Claude subscription.
- **Images:** Pexels, which is free.
- **Storage:** Cloudinary, which is already paid for.

The only limit is the subscription's usage allowance.

---

## Troubleshooting

**The banner says "Writer offline"**

```bash
sudo systemctl status ghlprime-blog-writer
tail -50 /var/log/ghlprime-blog-writer.log
```

The screen shows the writer as offline when the watcher hasn't checked in for
2 minutes. While it is offline, the button is disabled.

**A post shows "failed"**

The reason appears on the screen, and the log has the full details. The most
common cause is that the Claude login has expired. To fix it, log in again (as
in step 4) and then run:

```bash
sudo systemctl restart ghlprime-blog-writer
```

**The screen says "Paused, will continue on its own"**

The Claude usage limit has been reached. The watcher waits and then tries again
by itself. You don't need to do anything.

**A post seems stuck**

A run that takes longer than 25 minutes is stopped and tried again later. If
the watcher was restarted in the middle of a post, it picks that post up again
when it starts.

**Always restart the service; don't stop it and start it again.** Only run
**one** watcher per database.

---

## Tested so far

Tested on the development database:

- A full post from topic to saved draft (about 4 minutes, with a cover image)
- A batch of 2 posts written one after the other
- A news-site schedule reading 8 sites and picking a story
- A junk keyword skipped correctly, with no duplicate post

Not tested yet: auto-publish turned on, logging in from the `/admin/claude-auth`
page, and the automatic retry after the usage limit is reached.

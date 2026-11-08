#!/usr/bin/env python3
"""`connectd init` in a real terminal (a pty), answered the way a person would: each question is
read off the screen, then typed, the providers checklist with the arrow keys and space.

    python3 init-tty.py <dir> <command...>      e.g. init-tty.py app npx --package <tgz> connectd init

Exits 1 when a question doesn't come, or the setup fails. Prints what the terminal showed."""
import os, pty, re, select, sys, time

dir, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(dir)
    os.execvp(cmd[0], cmd)

screen = b""


def read_until(pattern, timeout=240):
    global screen
    end = time.time() + timeout
    while time.time() < end:
        if re.search(pattern.encode(), screen):
            return
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            screen += chunk
    sys.stdout.write(screen.decode(errors="replace"))
    sys.exit(f"\nFAIL init-tty: no {pattern!r} on the screen")


def send(keys):
    time.sleep(0.3)
    os.write(fd, keys.encode())


DOWN, SPACE, ENTER = "\x1b[B", " ", "\r"
read_until(r"1\. Your app's origin in dev")
send(ENTER)  # the default
read_until(r"2\. Port for connectd dev")
send("8795" + ENTER)
read_until(r"Install @kavishkagaya/connectd")
send("y" + ENTER)
read_until(r"Where will connectd run when you deploy\?[\s\S]*Choose \[1\]")
send("1" + ENTER)  # Cloudflare: installs its package and wrangler
# Signed in to Cloudflare already, or asked to log in (no, here: deploy asks again).
read_until(r"logged in as|Log in now|connectd deploy asks again")
if re.search(rb"Log in now", screen):
    send("n" + ENTER)
read_until(r"Providers to add[\s\S]*Add later")
send(SPACE)  # github, the first (popular first)
send(DOWN + DOWN + SPACE)  # the third: slack in the default catalog order (github, google, slack)
send(ENTER)
read_until(r"Next:[\s\S]*connectd dev")
_, status = os.waitpid(pid, 0)
sys.stdout.write(screen.decode(errors="replace"))
sys.exit(0 if os.waitstatus_to_exitcode(status) == 0 else 1)

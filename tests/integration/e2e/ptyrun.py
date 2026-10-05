# Runs a command in a pty, as a person at a terminal would, answering Enter (the
# default) whenever it waits for input: no output for three seconds. Prints what it saw.
import os, pty, select, sys, time
cmd = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-lc", cmd])
quiet, answered = time.time(), 0
while True:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data); sys.stdout.flush(); quiet = time.time()
    elif time.time() - quiet > 3:
        answered += 1
        if answered > 40:
            os.kill(pid, 9); break
        os.write(fd, b"\r"); quiet = time.time()
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
print(f"\n[ptyrun] exit {code}")
sys.exit(code)

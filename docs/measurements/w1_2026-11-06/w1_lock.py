"""The machine's busy lock for W1's timed batches (other agents on this PC share the same file).

    python w1_lock.py acquire "W1 measuring"   wait until no one holds the lock (every 30 s, at most 60 min), then take
                                              it atomically (O_CREAT | O_EXCL) with a token of its own; the token is
                                              the only line on stdout, the rest goes to stderr. Exit 0: taken.
                                              Exit 3: still held after 60 min: nothing written, nothing taken; stdout
                                              is empty and stderr names the holder, so the caller notes "measured
                                              while <holder> held the lock".
    python w1_lock.py release <token>         delete the lock only when it holds exactly that token
The lock's path is LOCK below, or the env SCUMBLE_BUSY_LOCK.
"""
import os
import sys
import time

LOCK = os.environ.get("SCUMBLE_BUSY_LOCK") or (
    r"C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\machine_busy.lock")
WAIT_S = 3600
STEP_S = 30


def holder():
    try:
        with open(LOCK, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return None


def acquire(text):
    token = f"{text} {os.getpid()} {time.strftime('%Y-%m-%dT%H:%M:%S')}"
    t0 = time.time()
    said = False
    while True:
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.time() - t0 > WAIT_S:
                print(f"lock: still held after {WAIT_S // 60} min by {holder()!r}; not taken", file=sys.stderr)
                return 3
            if not said:
                print(f"lock: held by {holder()!r}, waiting", file=sys.stderr)
                said = True
            time.sleep(STEP_S)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token)
        print(f"lock: taken after {time.time() - t0:.0f} s", file=sys.stderr)
        print(token)
        return 0


def release(token):
    body = holder()
    if body is None:
        print("lock: not there", file=sys.stderr)
    elif token and body == token:
        os.remove(LOCK)
        print("lock: released", file=sys.stderr)
    else:
        print(f"lock: held by {body!r}, not ours, left alone", file=sys.stderr)
    return 0


def main():
    what = sys.argv[1]
    if what == "acquire":
        return acquire(sys.argv[2] if len(sys.argv) > 2 else "W1 measuring")
    if what == "release":
        return release(sys.argv[2] if len(sys.argv) > 2 else "")
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

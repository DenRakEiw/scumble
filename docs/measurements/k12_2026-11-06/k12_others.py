"""Wait until no other agent's gate run or timing instance is going on this PC (K12's chain, before each timed batch).

    python k12_others.py wait      poll every 30 s, at most 60 min; exit 0 when clear, 3 when still busy at the limit
    python k12_others.py show      print what matches now, exit 0

A match is a process whose command line matches run_gates|_test\\.py|--remote-debugging-port=957[2-9] (the other agents'
gate runs and their instances; the idle key instance on 9571 is not one and is noted when it is there). The caller's own
runs are never going while it waits. Every line goes to stdout, for the chain's log.
"""
import json
import re
import subprocess
import sys
import time

BUSY = re.compile(r"run_gates|_test\.py|--remote-debugging-port=957[2-9]")
IDLE_KEY = re.compile(r"--remote-debugging-port=9571\b")
WAIT_S = 3600
STEP_S = 30


def processes():
    ps = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | "
          "Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=120)
    try:
        rows = json.loads(r.stdout or "[]")
    except json.JSONDecodeError:
        return []
    return rows if isinstance(rows, list) else [rows]


def busy_now():
    rows = processes()
    busy = [p for p in rows if BUSY.search(p.get("CommandLine") or "") and "k12_others.py" not in (p.get("CommandLine") or "")]
    idle = [p for p in rows if IDLE_KEY.search(p.get("CommandLine") or "") and p.get("Name") == "electron.exe"]
    return busy, idle


def short(p):
    return f"{p.get('ProcessId')} {p.get('Name')}: {(p.get('CommandLine') or '')[:140]}"


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "show"
    t0 = time.time()
    said = False
    while True:
        busy, idle = busy_now()
        if what == "show" or not busy:
            stamp = time.strftime("%H:%M:%S")
            print(f"[{stamp}] others: {len(busy)} busy" + (f" ({'; '.join(short(p) for p in busy[:4])})" if busy else "")
                  + (f"; the idle key instance on 9571 is there ({len(idle)} main process)" if idle else "; no instance on 9571")
                  + (f"; waited {time.time() - t0:.0f} s" if said else ""))
            return 0
        if time.time() - t0 > WAIT_S:
            print(f"others: still busy after {WAIT_S // 60} min: {'; '.join(short(p) for p in busy[:4])}")
            return 3
        if not said:
            print(f"others: busy, waiting: {'; '.join(short(p) for p in busy[:4])}")
            said = True
        time.sleep(STEP_S)


if __name__ == "__main__":
    sys.exit(main())

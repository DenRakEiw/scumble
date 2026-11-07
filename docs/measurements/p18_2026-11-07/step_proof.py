"""The proof that editor_test.py's step settings_open_does_not_wait_for_the_card fails without P18: renderer/shell.js as
committed (green) and three mutants (each must be red), each on a fresh instance (tools/run_gates.sh, tiles, offline,
port 9603, SCUMBLE_EDITOR_ONLY=the step); shell.js is restored after every run. The busy lock is held for the whole proof.

    python docs/measurements/p18_2026-11-07/step_proof.py [out.txt]
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
SHELL = os.path.join(ROOT, "renderer", "shell.js")
LOCK = os.path.join(ROOT, "docs", "measurements", "w1_2026-11-06", "w1_lock.py")
STEP = "settings_open_does_not_wait_for_the_card"
OLD_OPEN = """    try {
        const mb = await gpuMemoryMB();
        const card = await cardMemory();
        const cardText = card ? (card.totalMB ? ` The card holds ${card.usedMB} of ${card.totalMB} MB (everything on it, read through ${card.source}).` : ` The card holds ${card.usedMB} MB in all (read through ${card.source}; its size is not reported).`) : " The card's own memory cannot be read here (no nvidia-smi, no counters).";
        ui.setGpuMem.textContent = `The GPU process is using ${mb} MB right now.${cardText} A background tab keeps its filtered copies, its display pyramids and the compositor's textures until they are released here.`;
    } catch (_) { ui.setGpuMem.textContent = ""; }
"""
CALL = "    refreshGpuMemory();   // not awaited (P18): the card's read starts nvidia-smi or a PowerShell counter\n"
VARIANTS = [
    ("as committed", None, None, True),
    ("P18 reverted: openSettings reads the line itself, as at e9ab0d3", CALL, OLD_OPEN, False),
    ("openSettings awaits refreshGpuMemory", CALL, "    await refreshGpuMemory();\n", False),
    ("no seq guard", "        if (seq !== gpuMemSeq) return;\n", "", False),
]


def gate(label):
    env = dict(os.environ, SCUMBLE_CDP_PORT="9603", SCUMBLE_EDITOR_ONLY=STEP,
               SCUMBLE_GATES=os.path.join(ROOT, "dist", "gates"))
    subprocess.run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", "on", "editor"], cwd=ROOT, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log = os.path.join(ROOT, "dist", "gates", "gates", label, "editor.log")
    with open(log, encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip() for l in f if STEP in l or l.startswith(("PASS", "FAIL"))]
    return lines


def main():
    out = []
    token = subprocess.run([sys.executable, LOCK, "acquire", "P18 step proof (agent a24fab29)"], capture_output=True, text=True).stdout.strip()
    out.append(f"lock: {token or 'NOT TAKEN'}")
    with open(SHELL, "rb") as f:
        orig = f.read()
    text = orig.decode("utf-8")
    ok_all = True
    try:
        for i, (name, old, new, want_green) in enumerate(VARIANTS):
            if old is not None:
                assert text.count(old) == 1, f"{name}: {text.count(old)} matches"
                with open(SHELL, "wb") as f:
                    f.write(text.replace(old, new).encode("utf-8"))
            try:
                lines = gate(f"p18proof{i}")
            finally:
                with open(SHELL, "wb") as f:
                    f.write(orig)
            green = any(l.startswith("PASS") for l in lines)
            fine = green == want_green
            ok_all &= fine
            out.append(f"{'as expected' if fine else 'WRONG'}: {name}: {'green' if green else 'red'}")
            out.extend("    " + l[:300] for l in lines)
    finally:
        with open(SHELL, "wb") as f:
            f.write(orig)
        if token:
            subprocess.run([sys.executable, LOCK, "release", token], capture_output=True)
    out.append("RESULT " + ("PASS" if ok_all else "FAIL"))
    text_out = "\n".join(out)
    print(text_out)
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
            f.write(text_out + "\n")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())

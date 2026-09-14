#!/usr/bin/env python3
"""One line per family report, for the end of run.sh and for the docs."""
import json, sys
for path in sys.argv[1:]:
    r = json.load(open(path))
    verdict = lambda gate: "pass" if r[gate].get("ok") else "FAIL"
    missing = " ".join(r["G2"].get("lddMissing") or [])
    print(f'{r["family"]:9} {r["os"]:34} glibc {r["glibc"].split()[-1]:5} G2 {verdict("G2")}{" (" + missing + ")" if missing else ""}  G1 {verdict("G1")} via {r["G1"].get("compositor")}  G5 {verdict("G5")}  G29 {r["G29"].get("verdict")} ({r["G29"].get("shape")})')

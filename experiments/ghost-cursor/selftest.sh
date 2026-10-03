#!/usr/bin/env bash
# Prove the harness can fail: a no-op agent must pass, and each deliberate violation must be caught
# by the criteria it targets. The cases after the first five come from the adversarial review of
# 3 October 2026, which found each of them passing the earlier harness. Usage: selftest.sh LAB
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LAB=$1
run() { "$HERE/lab.py" run "$LAB" -- "$@"; }
run hyprctl clients -j | grep -q org.gnome.Calculator || "$HERE/lab.py" spawn "$LAB" -- gnome-calculator >/dev/null
/usr/bin/python3 -c 'import time; time.sleep(2)'
CALC=$(run hyprctl clients -j | /usr/bin/python3 -c "import json,sys; print([c['address'] for c in json.load(sys.stdin) if 'Calculator' in c['class']][0])")
fail=0
check() { # name, criteria that must fail (or "none"), agent command
  local name=$1 expect=$2 agent=$3 got ok=yes
  got=$(run /usr/bin/python3 "$HERE/harness.py" --agent "$agent" --repeat 1 --settle 3 2>/dev/null |
    /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); a=r["agent"]; print(("AGENT-FAILED " if a["exit"] or a["timed_out"] else "") + (" ".join(k.split("_")[0] for k,v in r.items() if k.startswith("B") and not v["pass"]) or "none"))' 2>/dev/null)
  [[ -z $got || $got == AGENT-FAILED* ]] && ok=no
  for c in $expect; do
    if [[ $c == none ]]; then [[ $got == none ]] || ok=no; else [[ " $got " == *" $c "* ]] || ok=no; fi
  done
  printf '%-24s must fail: %-10s got: %-22s %s\n' "$name" "$expect" "$got" "$([ $ok = yes ] && echo CAUGHT || echo MISSED)"
  [ $ok = yes ] || fail=1
}
check baseline none "sleep 1"
check focus-steal "B2 B4" "hyprctl dispatch focuswindow address:$CALC; sleep 0.3; hyprctl dispatch focuswindow class:lab.person.standin"
check pointer-move "B1" "hyprctl dispatch movecursor 5 5; sleep 0.2; hyprctl dispatch movecursor 6 6"
check stray-key "B3" "wtype Z"
check sendshortcut "B2" "hyprctl dispatch sendshortcut SHIFT, G, address:$CALC | grep -qx ok"
check normal-spawn "B4" "setsid gnome-calculator >/dev/null 2>&1 & sleep 2.5"
check select-all "B3" "sleep 1; /usr/bin/python3 $HERE/a11y_select_all.py"
check clipboard "B2" "printf 'agent text' | timeout 2 wl-copy; true"
check layout-switch "B4" "hyprctl switchxkblayout all next >/dev/null"
check bind-trap "B4" "hyprctl keyword bind ',m,exec,true' >/dev/null"
check delayed-focus "B4" "setsid sh -c 'sleep 1.5; hyprctl dispatch focuswindow address:$CALC' >/dev/null 2>&1 </dev/null &"
check leftover-process "B12" "setsid sleep 30 >/dev/null 2>&1 </dev/null & disown; true"
check screen-off "B4" "hyprctl dispatch dpms off >/dev/null; sleep 0.5; hyprctl dispatch dpms on >/dev/null; hyprctl dispatch dpms off >/dev/null"
check pinned-overlay "B4" "hyprctl dispatch exec '[float on; no_initial_focus on; pin on; move 0 0; size 900 900] gnome-calculator' >/dev/null; sleep 2.5"
check screen-shader "B4" "printf 'void main(){}' > /tmp/gl-shader.frag; hyprctl keyword decoration:screen_shader /tmp/gl-shader.frag >/dev/null"
# Restore what the cases changed, so the next run starts clean.
run hyprctl reload >/dev/null; run hyprctl dispatch dpms on >/dev/null
for a in $(run hyprctl clients -j | /usr/bin/python3 -c "import json,sys; c=[x['address'] for x in json.load(sys.stdin) if 'Calculator' in x['class']]; print(' '.join(c[1:]))"); do
  run hyprctl dispatch closewindow address:$a >/dev/null
done
exit $fail

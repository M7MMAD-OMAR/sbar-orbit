#!/usr/bin/env bash
# B7 toolkit matrix through accessibility only. Each task launches the app hidden, acts on it, and
# verifies the result by reading it back, all inside harness.py while the person keeps typing.
# Usage: matrix.sh LAB [toolkit...]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LAB=$1; shift
G="/usr/bin/python3 $HERE/ghost.py"
run() { "$HERE/lab.py" run "$LAB" -- "$@"; }
pid_of() { echo "$1" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])'; }
# ref NAME ROLE: the first ref in the snapshot whose line has ROLE and NAME.
ref() { run $G snapshot "$P" | /usr/bin/python3 -c "
import re,sys
for l in sys.stdin:
    if '$2' in l and \"'$1'\" in l:
        print(re.search(r'\[(e\d+)\]', l).group(1)); break"; }
measure() { # name, task
  local out
  out=$(run /usr/bin/python3 "$HERE/harness.py" --agent "$2" --repeat 1 2>/dev/null)
  echo "$out" | /usr/bin/python3 -c "import json,sys; r=json.load(sys.stdin); f=[k[:2] for k,v in r.items() if k.startswith('B') and not v['pass']]; print(f'$1: task={\"ok\" if r[\"agent\"][\"exit\"]==0 else \"FAILED \"+r[\"agent\"][\"stderr\"].strip()[-160:]} disturbance={\" \".join(f) or \"none\"}')"
}
want=${*:-gtk4 gtk3 qt libreoffice}
for tk in $want; do
  case $tk in
    gtk4)
      P=$(pid_of "$(run $G launch -- gnome-text-editor --standalone)"); sleep 2
      E=$(run $G snapshot $P | grep -m1 'editable' | grep -o 'e[0-9]*' | head -1)
      measure gtk4-text-editor "$G set $P $E 'مرحبا from the agent' && $G wait $P $E 'مرحبا from the agent'" ;;
    gtk3)
      P=$(pid_of "$(run $G launch -- gtk3-demo)"); sleep 2
      R=$(ref Clipboard 'table cell')
      measure gtk3-demo "$G select $P $R && $G read $P $R | grep -q selected" ;;
    qt)
      P=$(pid_of "$(run $G launch -- dolphin --new-window /usr/share)"); sleep 3
      R=$(ref applications 'list item')
      measure qt-dolphin "$G select $P $R && $G read $P $R | grep -q selected" ;;
    libreoffice)
      P=$(pid_of "$(run $G launch -- soffice --writer --norestore --nologo -env:UserInstallation=file://$LAB/home/lo)"); sleep 8
      E=$(run $G snapshot $P | grep -m1 -E "paragraph.*editable|editable.*paragraph" | grep -o 'e[0-9]*' | head -1)
      measure libreoffice-writer "$G type $P $E 'written by the agent' && $G wait $P $E 'written by the agent'" ;;
  esac
done

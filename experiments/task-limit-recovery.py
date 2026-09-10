"""Exercise kernel task admission with three sleeping children, never a load loop."""
import errno
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/native'))
from budget import require_budget

require_budget()
entry = next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
root = Path('/sys/fs/cgroup') / entry.lstrip('/')
assert (root / 'pids.max').read_text().strip() == '4', 'Dedicated four-task scope required'
assert int((root / 'memory.max').read_text()) <= 67108864
assert (root / 'memory.swap.max').read_text().strip() == '0'

def events():
    return dict((key, int(value)) for key, value in
                (line.split() for line in (root / 'pids.events').read_text().splitlines()))

children = []
before = events()
try:
    for _ in range(3):
        children.append(subprocess.Popen(['/usr/bin/sleep', '5']))
    try:
        extra = subprocess.Popen(['/usr/bin/true'])
    except OSError as error:
        assert error.errno == errno.EAGAIN, error
        denied_errno = error.errno
    else:
        extra.wait(timeout=2)
        raise AssertionError('Kernel admitted a fifth task')
    after = events()
    assert after['max'] > before['max'], 'Missing kernel denial event'
    released = children[-1]
    released.terminate()
    # Reap the terminated child before requesting the released task slot.
    released.wait(timeout=2)
    children.pop()
    recovered = subprocess.run(['/usr/bin/true'], timeout=2, check=True)
    print(json.dumps({
        'status': 'passed', 'taskLimit': 4, 'sleepingChildren': 3,
        'deniedErrno': denied_errno, 'taskLimitEventsDelta': after['max'] - before['max'],
        'recoveryExitCode': recovered.returncode,
        'peakMemoryBytes': int((root / 'memory.peak').read_text()),
        'swapBytes': int((root / 'memory.swap.current').read_text()),
        'limitations': ['Kernel admission and recovery only; browser/session recovery and OOM attribution remain unverified.']
    }))
finally:
    for child in children:
        child.terminate()
        child.wait(timeout=2)

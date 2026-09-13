"""Refuse native children outside the shared, kernel-enforced Orbit budget."""
from pathlib import Path

def require_budget():
    entries = Path('/proc/self/cgroup').read_text().splitlines()
    path = next((entry[3:] for entry in entries if entry.startswith('0::')), '')
    parts = path.split('/')
    if 'sbarorbit.slice' not in parts:
        raise RuntimeError('Run through bun run scripts/limited.ts; Orbit resource budget required')
    root = Path('/sys/fs/cgroup').joinpath(*parts[:parts.index('sbarorbit.slice') + 1][1:])
    quota, period = (root / 'cpu.max').read_text().split()
    memory = (root / 'memory.max').read_text().strip()
    tasks = (root / 'pids.max').read_text().strip()
    if quota == 'max' or int(quota) > 4 * int(period) or memory == 'max' or int(memory) > 8589934592 or tasks == 'max' or int(tasks) > 1536 or (root / 'memory.swap.max').read_text().strip() != '0':
        raise RuntimeError('Orbit resource limits are not enforced')

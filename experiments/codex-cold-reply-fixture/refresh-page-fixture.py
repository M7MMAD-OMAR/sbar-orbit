import shutil
import sqlite3
import sys
from pathlib import Path

owner = Path(sys.argv[1]).resolve()
fixture = Path(sys.argv[2]).resolve()
thread_id = sys.argv[3]
assert owner.parent == fixture.parent
assert owner.name.startswith('owner-codex-orbit-')
assert fixture.name.startswith('page-fixture-')
assert owner.name.rsplit('-', 1)[-1] == fixture.name.rsplit('-', 1)[-1]
assert (fixture / 'sessions').is_dir()
for name in ('state_5.sqlite', 'thread_history_1.sqlite'):
    source = sqlite3.connect(f'file:{owner / name}?mode=ro', uri=True)
    target = sqlite3.connect(fixture / name)
    source.backup(target)
    source.close()
    if name == 'state_5.sqlite':
        row = target.execute('SELECT rollout_path FROM threads WHERE id=?', (thread_id,)).fetchone()
        assert row and row[0]
        selected = Path(row[0]).relative_to(owner / 'sessions')
        target.execute('UPDATE threads SET rollout_path=? WHERE id=?',
                       (str(Path('/fixture/sessions') / selected), thread_id))
        target.commit()
    target.execute('PRAGMA journal_mode=DELETE')
    target.close()
shutil.rmtree(fixture / 'sessions')
shutil.copytree(owner / 'sessions', fixture / 'sessions')

"""Experimental two-key GSettings endpoint, restricted to an owned Orbit runtime."""
import json
import os
import stat
import sys
from pathlib import Path
from gi.repository import Gio, GLib

runtime = Path(os.environ.get('XDG_RUNTIME_DIR', ''))
config = Path(os.environ.get('XDG_CONFIG_HOME', ''))
info = runtime.lstat()
if (not str(runtime).startswith('/tmp/orbit-native-') or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid() or info.st_mode & 0o077
        or config != runtime / 'config'
        or os.environ.get('DBUS_SESSION_BUS_ADDRESS') != 'unix:path=' + str(runtime / 'bus')):
    raise RuntimeError('Owned Orbit runtime and private bus required')
settings = Gio.Settings.new('org.gnome.Ptyxis')
keys = ('font-name', 'use-system-font')
loop = GLib.MainLoop()

def emit(value):
    print(json.dumps(value), flush=True)

def changed(_settings, key):
    if key in keys:
        emit({'event': 'changed', 'key': key, 'value': settings.get_value(key).unpack()})

settings.connect('changed', changed)
# Read after signal registration, as required for GSettings changed notifications.
emit({'event': 'ready', 'values': {key: settings.get_value(key).unpack() for key in keys}})

def input_ready(_source, condition):
    if condition & GLib.IO_HUP:
        loop.quit()
        return False
    line = sys.stdin.readline(4097)
    if not line:
        loop.quit()
        return False
    try:
        if len(line) > 4096 or not line.endswith('\n'):
            raise ValueError('Invalid message length')
        request = json.loads(line)
        if not isinstance(request, dict) or set(request) != {'id', 'key', 'value'}:
            raise ValueError('Invalid message fields')
        key, value = request['key'], request['value']
        if type(request['id']) is not int or request['id'] < 1 or key not in keys:
            raise ValueError('Invalid request identity or key')
        if key == 'font-name':
            if value not in ('Monospace 18', 'Monospace 30', 'Monospace 36'):
                raise ValueError('Fixture font required')
            variant = GLib.Variant('s', value)
        else:
            if type(value) is not bool:
                raise ValueError('Boolean value required')
            variant = GLib.Variant('b', value)
        if not settings.set_value(key, variant):
            raise RuntimeError('Setting is not writable')
        Gio.Settings.sync()
        emit({'event': 'ack', 'id': request['id']})
    except Exception:
        emit({'event': 'rejected'})
        loop.quit()
        return False
    return True

GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, input_ready)
loop.run()

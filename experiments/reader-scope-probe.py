"""Unavailable legacy live probe. Historical acceptance is not current qualification.

Atomic child identity and cgroup placement have not been established. No legacy
spawn/resume/kill helpers are retained here. Only fixed read-only help is supported.
"""
import sys

_MESSAGE = "UNAVAILABLE: reader scope live probe requires qualified atomic child creation and admission; --help only"


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    if type(arguments) in (list, tuple) and len(arguments) == 1 and arguments[0] == "--help":
        print(_MESSAGE + ". No desktop/app operations.")
        return 0
    print(_MESSAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Unavailable legacy reader bootstrap. No provider is started.

Atomic child creation and cgroup admission have not been qualified. This
entrypoint refuses before inspecting arguments, environment or resources.
"""

FAILURE = 70


def main(argv=None):
    return FAILURE


if __name__ == "__main__":
    raise SystemExit(main())

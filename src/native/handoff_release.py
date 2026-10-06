"""Release hold after the owner compositor crash, with no runtime override."""


def require_owner_handoff():
    raise RuntimeError("Owner display handoff is disabled after a compositor crash; isolated validation is required")

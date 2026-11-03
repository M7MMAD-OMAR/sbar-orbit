"""Pure, provisional identity comparison for a trusted retained-reference validator.

Not provider discovery, an authenticity check, or permission for native actions. No
production caller imports this module. A trusted caller must independently verify
live bus/owner credentials, PID/start, exact compositor binding, source/build and
actual per-object exporter/route, and invalidate on loss. Application toolkit
strings, object-path syntax, proxy equality/hash, labels and coordinates are not
that proof. Identical stale assertions cannot establish liveness here.

The only described path policy is the reviewed GTK 4.22.5 source's per-realization
random UUID, with an explicit trusted-provider/noncollision assumption. It is not
an absolute collision-free remote reservation or proof against custom exporters.
Widget/context identity does not prove a virtualized business row is unchanged.
Root membership and freshness/TTL remain mandatory independent registry gates;
comparison is not atomic with a later action. No built-in GI, bus, OS or clock calls.
Evidence is a CALLER ASSERTION ONLY, minted by a mandatory trusted verifier callback,
not proof established by source review or a public/provider enablement capability.
"""
from dataclasses import InitVar, dataclass, field
import re

from .a11y_refs import RefError, TargetBinding

GTK_SOURCE_REVISION = "bd25f1e2dc2c2fbf3b8864e61afe642910ba359c"
_HEX32 = re.compile(r"[0-9a-f]{32}", re.ASCII)
_HEX64 = re.compile(r"[0-9a-f]{64}", re.ASCII)
_UNIQUE_OWNER = re.compile(r":[0-9]+\.[0-9]+", re.ASCII)
_BASE = re.compile(r"(?:/[A-Za-z0-9_]+)+/a11y", re.ASCII)
_UUID_CONTEXT = re.compile(r"[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}", re.ASCII)
_ATTESTED = object()


class IdentityError(ValueError):
    def __init__(self):
        super().__init__("Accessibility identity proof is missing or unsupported")


def _matches(pattern, value, limit):
    return type(value) is str and len(value) <= limit and pattern.fullmatch(value) is not None


def _binding_valid(binding):
    if type(binding) is not TargetBinding:
        return False
    try:
        # Recheck even frozen containers: trusted Python code can bypass dataclass construction.
        TargetBinding.__post_init__(binding)
    except (RefError, AttributeError, TypeError, ValueError):
        return False
    return True


@dataclass(frozen=True, slots=True)
class ProviderEvidence:
    """Trusted caller assertions, not values inferred from application responses.

    The mandatory verify callback must return exactly True after corroborating
    this object's actual GTK exporter, the matching running artifact/source, and
    the same managed accessibility-bus endpoint/instance. It receives this immutable
    assertion, not native objects; trust belongs to the caller supplying that callback.
    An application root's toolkit/version alone cannot qualify custom children.
    A libatspi private client connection to that same managed bus is not a proven
    app-private peer endpoint. Unknown/peer routes are intentionally unsupported.
    CALLER ASSERTION ONLY: neither this type nor an always-True callback
    authenticates a malicious caller or establishes native runtime proof.
    """
    toolkit: str
    toolkit_version: str
    source_revision: str
    artifact_sha256: str
    route: str
    path_base: str
    lifetime_policy: str
    qualification: str
    verify: InitVar[object]
    _attested: object = field(init=False, default=None, repr=False, compare=False)

    def __post_init__(self, verify):
        self._validate_shape()
        if not callable(verify):
            raise IdentityError()
        try:
            accepted = verify(self)
        except Exception:
            raise IdentityError() from None
        if accepted is not True:
            raise IdentityError()
        object.__setattr__(self, "_attested", _ATTESTED)

    def _validate_shape(self):
        if (type(self.toolkit) is not str or self.toolkit != "GTK"
                or type(self.toolkit_version) is not str or self.toolkit_version != "4.22.5"
                or type(self.source_revision) is not str or self.source_revision != GTK_SOURCE_REVISION
                or not _matches(_HEX64, self.artifact_sha256, 64)
                or type(self.route) is not str or self.route != "managed-accessibility-bus"
                or not _matches(_BASE, self.path_base, 512)
                or type(self.lifetime_policy) is not str or self.lifetime_policy != "gtk4-per-realization-random-uuid"
                or type(self.qualification) is not str or self.qualification != "trusted-provider-uuid-noncollision"):
            raise IdentityError()


@dataclass(frozen=True, slots=True)
class AccessibleIdentity:
    """One asserted remote context identity, bound to the exact registry authority.

    process_start is the expected Linux start-generation integer, not a PID-only
    check; binding.process_generation must be its canonical decimal string. The
    caller obtains fresh tokens for retained handles, never by selector lookup.
    window_root_path identifies the actual GTK context for the compositor window,
    not the fixed application root. The registry adapter must separately require
    its retained root token.object_path == each node token.window_root_path.
    """
    binding: TargetBinding
    helper_generation: str
    bus_id: str
    unique_owner: str
    process_start: int
    object_path: str
    window_root_path: str
    evidence: ProviderEvidence

    def __post_init__(self):
        if type(self.evidence) is not ProviderEvidence or not _binding_valid(self.binding):
            raise IdentityError()
        try:
            ProviderEvidence._validate_shape(self.evidence)
            if self.evidence._attested is not _ATTESTED:
                raise IdentityError()
        except (IdentityError, AttributeError, TypeError, ValueError):
            raise IdentityError() from None
        if (not _matches(_HEX32, self.helper_generation, 32) or not _matches(_HEX32, self.bus_id, 32)
                or not _matches(_UNIQUE_OWNER, self.unique_owner, 255)
                or type(self.process_start) is not int or not 0 < self.process_start <= 2 ** 64 - 1
                or not 0 < self.binding.process_id <= 2 ** 31 - 1
                or self.binding.process_generation != str(self.process_start)
                or type(self.object_path) is not str or len(self.object_path) > 550
                or type(self.window_root_path) is not str or len(self.window_root_path) > 550):
            raise IdentityError()
        prefix = self.evidence.path_base + "/"
        for path in (self.object_path, self.window_root_path):
            if not path.startswith(prefix) or not _matches(_UUID_CONTEXT, path[len(prefix):], 36):
                raise IdentityError()


def identity_matches(expected, current, binding):
    """False unless all qualified tokens and the exact TargetBinding agree.

    Intended as one predicate inside RetainedRegistry.validate(binding,root,node),
    alongside independently proven root membership, live/fresh owner credentials
    and authority. This function does not validate a native object or reserve it.
    """
    if type(expected) is not AccessibleIdentity or type(current) is not AccessibleIdentity or not _binding_valid(binding):
        return False
    try:
        AccessibleIdentity.__post_init__(expected)
        AccessibleIdentity.__post_init__(current)
        return expected.binding == binding and current.binding == binding and expected == current
    except (IdentityError, AttributeError, TypeError, ValueError):
        return False

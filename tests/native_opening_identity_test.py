"""Request correlation must not guess from unrelated protocol traffic or windows."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.opening_identity import opening_identity
from src.native.session import SessionError


class OpeningIdentityTests(unittest.TestCase):
    def test_context_forgets_token_after_operation_failure(self):
        requests = []
        class Transport:
            def _exchange(self, request):
                requests.append(request)
                return "ok"
        with self.assertRaisesRegex(RuntimeError, "original failure"):
            with opening_identity(Transport(), "a" * 32):
                raise RuntimeError("original failure")
        self.assertEqual([request.split()[1] for request in requests], ["register", "forget"])

    def test_response_must_match_exact_token_and_not_multiple_surfaces(self):
        class Transport:
            reply = {"schema": 1, "token": "a" * 32, "ambiguous": False, "windows": []}
            def _exchange(self, request):
                return json.dumps(self.reply) if " info " in request else "ok"
        transport = Transport()
        with opening_identity(transport, "a" * 32) as identity:
            transport.reply["token"] = "b" * 32
            with self.assertRaises(SessionError): identity.windows()
            transport.reply.update(token="a" * 32, ambiguous=True)
            with self.assertRaisesRegex(SessionError, "different surfaces"): identity.windows()

    def test_missing_plugin_keeps_opening_available_without_guessing_a_token(self):
        requests = []
        class Transport:
            def _exchange(self, request):
                requests.append(request)
                return "unknown request"
        with opening_identity(Transport(), "a" * 32) as identity:
            self.assertFalse(identity.supported)
            self.assertEqual(identity.windows(), set())
        self.assertEqual(len(requests), 1)

    def test_plugin_refusal_is_not_treated_as_missing_capability(self):
        class Transport:
            def _exchange(self, request): return "refused: opening ticket is unavailable"
        with self.assertRaises(SessionError):
            with opening_identity(Transport(), "a" * 32): self.fail("Refusal was bypassed")

    def test_actual_protocol_observer_requires_matching_token_client_and_live_ticket(self):
        source = Path(os.environ.get("ORBIT_OPENING_IDENTITY_SOURCE", str(Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp"))).read_text()
        operation = source[source.index("struct SOpeningTicket {"):source.index("static std::string openingRequest(")]
        fixture = r'''
#include <memory>
#include <map>
#include <string>
#include <chrono>
#include <cstring>
#include <stdexcept>
template<typename T>using WP=std::weak_ptr<T>;
struct CWLSurfaceResource;
struct wl_resource{void* owner;std::shared_ptr<CWLSurfaceResource>surface;};
static bool unsafeNull=false;
struct CWLSurfaceResource{void* owner;void*client(){return owner;}
 static auto fromResource(wl_resource*r){if(!r){unsafeNull=true;return std::shared_ptr<CWLSurfaceResource>{};}return r->surface;}};
static const char* wl_resource_get_class(wl_resource*){return "xdg_activation_v1";}
static void*wl_resource_get_client(wl_resource*r){return r->owner;}
enum wl_protocol_logger_type{WL_PROTOCOL_LOGGER_REQUEST,WL_PROTOCOL_LOGGER_EVENT};
union wl_argument{const char*s;void*o;};struct wl_message{const char*name;};
struct wl_protocol_logger_message{wl_resource*resource;int opcode;const wl_message*message;int arguments_count;wl_argument*arguments;};
'''
        main = r'''
int main(){int owner,other;const std::string token(32,'a');auto a=std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{&owner}),b=std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{&owner});
 wl_resource manager{&owner,{}},surface{&owner,a};wl_argument args[2];args[0].s=token.c_str();args[1].o=&surface;
 wl_message activate{"activate"};wl_protocol_logger_message m{&manager,0,&activate,2,args};
 openingTickets.emplace(token,SOpeningTicket{std::chrono::steady_clock::now()-std::chrono::seconds{1}});
 openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(openingTickets.at(token).observed)return 1;
 auto&t=openingTickets.at(token);t.expires=std::chrono::steady_clock::now()+std::chrono::seconds{5};
 a->owner=&other;openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(t.observed)return 2;
 a->owner=&owner;openingProtocolRequest(WL_PROTOCOL_LOGGER_EVENT,&m);if(t.observed)return 3;
 args[1].o=nullptr;openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(t.observed||unsafeNull)return 8;args[1].o=&surface;
 args[0].s="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(t.observed||openingTickets.size()!=1)return 4;
 args[0].s=token.c_str();openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(!t.observed||t.surface.lock()!=a||t.ambiguous)return 5;
 openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(t.ambiguous)return 6;
 surface.surface=b;openingProtocolRequest(WL_PROTOCOL_LOGGER_REQUEST,&m);if(!t.ambiguous)return 7;
}
'''
        with tempfile.TemporaryDirectory(prefix="orbit-opening-identity-") as directory:
            root = Path(directory); cpp = root / "probe.cpp"; binary = root / "probe"
            cpp.write_text(fixture + operation + main)
            subprocess.run(["g++", "-std=c++23", str(cpp), "-o", str(binary)], check=True, timeout=30)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == "__main__": unittest.main()

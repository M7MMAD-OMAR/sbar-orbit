"""Real owned D-Bus service fixtures for the extracted production semantic wire core."""
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import transport

try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError):
    Gio = GLib = None

ROOT = Path(__file__).resolve().parents[1]
DRIVER = r"""#include <chrono>
#include <algorithm>
#include <sstream>
#include <string>
#include <format>
#include <vector>
#include <map>
#include <cmath>
#include <functional>
#include <optional>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <cstddef>
#include <poll.h>
#include <unistd.h>
#include <cerrno>
#include <regex>
#include <memory>
#include <cstdio>
#include <iostream>
#include <thread>
#include <dbus/dbus.h>
struct FixtureClock {
 using time_point = std::chrono::steady_clock::time_point;
 static inline std::chrono::seconds offset{0};
 static time_point now(){return std::chrono::steady_clock::now()+offset;}
};
#include "core.inc"
int main(int argc,char**argv){
 if(argc!=9)return 2;
 const std::string mode=argv[8];
 int dispatched=0;
 semantic_wire::Dispatcher dispatcher([&](const semantic_wire::Request&,bool send){if(send){++dispatched;if(mode=="pause")return std::string("owner-input");}return std::string();},
  [&](int fd,const void*data,size_t size,int flags)->ssize_t {if(mode=="partial")return ::send(fd,data,1,flags);if(mode=="backpressure"){errno=EAGAIN;return -1;}return ::send(fd,data,size,flags);});
 const std::string target="0x1@1@lease-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
 const std::string id(32,'a');
 std::string request="ghost-semantic-prepare "+target+" "+id+" "+argv[2]+" "+argv[5]+" "+argv[1]+" "+argv[3]+" "+argv[4]+" "+argv[6]+" "+argv[7]+" 10 20";
 try{
  if(mode=="ttl"){
   for(unsigned i=0;i<64;++i){const auto local=std::format("{:032x}",i);auto item=request;item.replace(item.find(" "+id+" ")+1,32,local);dispatcher.prepare(item);dispatcher.cancel(target,local);}
   FixtureClock::offset=std::chrono::seconds(61);
   std::cout<<dispatcher.prepare(request)<<"\n";
   dispatcher.cancel(target,id);
   std::cout<<"{\"pending\":"<<dispatcher.pending()<<",\"admissions\":"<<dispatched<<"}\n";
   return 0;
  }
  dispatcher.prepare(request);
  bool sent=false; auto start=semantic_wire::Clock::now();
  while(semantic_wire::Clock::now()-start<std::chrono::seconds(5)){
   dispatcher.tick();const auto status=dispatcher.status(target,id);
   if(status.find("\"state\":\"ready\"")!=std::string::npos&&!sent){
    if(mode=="prepare-only"){std::this_thread::sleep_for(std::chrono::milliseconds(150));std::cout<<dispatcher.status(target,id)<<"\n";dispatcher.cancel(target,id);break;}
    if(mode=="cancel"){std::cout<<dispatcher.cancel(target,id)<<"\n";break;}
    dispatcher.send(target,id);sent=true;
    if(mode=="dedup"){dispatcher.prepare(request);dispatcher.send(target,id);}
   }
   const auto current=dispatcher.status(target,id);
   if(current.find("\"state\":\"settled\"")!=std::string::npos){std::cout<<current<<"\n";break;}
   std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  std::cout<<"{\"pending\":"<<dispatcher.pending()<<",\"admissions\":"<<dispatched<<"}\n";
 }catch(const std::exception&e){std::cerr<<e.what();return 1;}
}
"""

XML = """<node>
<interface name="org.a11y.atspi.Accessible"><method name="GetState"><arg type="au" direction="out"/></method></interface>
<interface name="org.a11y.atspi.Action"><method name="DoAction"><arg type="i" direction="in"/><arg type="b" direction="out"/></method></interface>
<interface name="org.a11y.atspi.EditableText"><method name="SetTextContents"><arg type="s" direction="in"/><arg type="b" direction="out"/></method></interface>
<interface name="org.a11y.atspi.Value"><property name="CurrentValue" type="d" access="readwrite"/></interface>
</node>"""


@unittest.skipUnless(Gio is not None and shutil.which("dbus-daemon") and shutil.which("g++"), "requires Linux owned D-Bus/Gio/compiler fixtures")
class SemanticWireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="orbit-semantic-wire-")
        folder = Path(cls.build.name)
        source = (ROOT / "experiments/ghost-cursor/plugin/ghostinput.cpp").read_text()
        core = source.split("// BEGIN semantic-wire", 1)[1].split("// END semantic-wire", 1)[0]
        # Replace only the clock adapter to advance retention deterministically.
        core = core.replace("using Clock = std::chrono::steady_clock;", "using Clock = FixtureClock;")
        (folder / "core.inc").write_text(core)
        (folder / "driver.cpp").write_text(DRIVER)
        flags = subprocess.run(["pkg-config", "--cflags", "--libs", "dbus-1"], capture_output=True, text=True, timeout=5, check=True).stdout
        cls.binary = str(folder / "driver")
        built = subprocess.run(["g++", "-std=c++23", "-O0", str(folder / "driver.cpp"), "-o", cls.binary, *shlex.split(flags)],
                               capture_output=True, text=True, timeout=60)
        if built.returncode:
            raise RuntimeError(built.stderr[-4096:])

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="orbit-semantic-bus-")
        self.bus = subprocess.Popen(["/usr/bin/dbus-daemon", "--session", "--nofork", "--print-address=1",
                                     "--address=unix:path=" + str(Path(self.work.name) / "bus")],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.addCleanup(self.cleanup_bus)
        if not select.select([self.bus.stdout], [], [], 2)[0]:
            self.fail("owned fixture bus did not report an address")
        self.address = self.bus.stdout.readline(1024).decode().strip()
        self.connection = Gio.DBusConnection.new_for_address_sync(self.address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        self.connection.set_exit_on_close(False)
        self.owner = self.connection.get_unique_name()
        self.busid = self.connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", None,
            GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
        self.effects, self.invocations, self.behavior = [], [], "normal"
        info = Gio.DBusNodeInfo.new_for_xml(XML)
        self.registrations = [self.connection.register_object("/org/orbit/Test", interface, self.method, self.get_property, self.set_property)
                              for interface in info.interfaces]

    def cleanup_bus(self):
        if hasattr(self, "connection"):
            for registration in getattr(self, "registrations", []):
                self.connection.unregister_object(registration)
            self.connection.close_sync(None)
        if self.bus.poll() is None:
            self.bus.terminate()
        self.bus.wait(timeout=2)
        self.bus.stdout.close()
        self.work.cleanup()

    def method(self, connection, sender, path, interface, method, args, invocation):
        if method == "GetState":
            invocation.return_value(GLib.Variant("(au)", ([64 if self.behavior == "defunct" else 0, 0],)))
            return
        self.effects.append((method, args.unpack()))
        if self.behavior == "timeout":
            self.invocations.append(invocation)
        elif self.behavior == "error":
            invocation.return_dbus_error("org.orbit.Private", "PRIVATE_PROVIDER_ERROR")
        else:
            invocation.return_value(GLib.Variant("(b)", (True,)))

    def get_property(self, connection, sender, path, interface, name):
        return GLib.Variant("d", 0)

    def set_property(self, connection, sender, path, interface, name, value):
        self.effects.append((name, value.unpack()))
        return True

    def run_wire(self, mode="normal", verb="invoke", payload="0", pid=None, busid=None):
        self.behavior = mode
        child = subprocess.Popen([self.binary, self.address.encode().hex(), self.owner, busid or self.busid,
            str(os.getpid() if pid is None else pid), "/org/orbit/Test", verb, payload.encode().hex() or "-", mode],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 6
        context = GLib.MainContext.default()
        while child.poll() is None and time.monotonic() < deadline:
            for _ in range(16):
                if not context.pending():
                    break
                context.iteration(False)
            time.sleep(0.002)
        if child.poll() is None:
            child.kill()
        out, err = child.communicate(timeout=1)
        self.assertEqual(child.returncode, 0, err[-1024:])
        self.assertNotIn("PRIVATE_PROVIDER_ERROR", out + err)
        rows = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(rows[-1]["pending"], 0)
        return rows[0], rows[-1]

    def test_idle_terminal_receipt_ttl_frees_capacity_before_next_prepare(self):
        receipt, summary = self.run_wire("ttl")
        self.assertEqual(receipt["state"], "preparing")
        self.assertEqual(summary["admissions"], 0)
        self.assertEqual(self.effects, [])

    def test_invoke_once_and_duplicate_prepare_send_never_replays(self):
        receipt, summary = self.run_wire("dedup")
        self.assertEqual((receipt["delivery"], receipt["accepted"]), ("delivered", True))
        self.assertEqual(self.effects, [("DoAction", (0,))])
        self.assertEqual(summary["admissions"], 1)

    def test_edit_delivers_exact_utf8_payload_without_pointer_input(self):
        receipt, _ = self.run_wire(verb="edit", payload="owned \u00e9 text")
        self.assertTrue(receipt["accepted"])
        self.assertEqual(self.effects, [("SetTextContents", ("owned \u00e9 text",))])

    def test_value_uses_only_fixed_current_value_property(self):
        receipt, _ = self.run_wire(verb="value", payload="2.5")
        self.assertTrue(receipt["accepted"])
        self.assertEqual(self.effects, [("CurrentValue", 2.5)])

    def test_prepare_never_dispatches_a_mutation_without_final_send(self):
        receipt, summary = self.run_wire("prepare-only")
        self.assertEqual(receipt["state"], "ready")
        self.assertEqual(summary["admissions"], 0)
        self.assertEqual(self.effects, [])

    def test_changed_admission_at_actual_send_refuses_without_effect(self):
        receipt, _ = self.run_wire("pause")
        self.assertEqual((receipt["delivery"], receipt["reason"]), ("not-delivered", "admission-refused"))
        self.assertEqual(self.effects, [])

    def test_real_partial_frame_is_unknown_and_never_completes_or_retries(self):
        receipt, summary = self.run_wire("partial")
        self.assertEqual((receipt["delivery"], receipt["reason"]), ("unknown", "partial-send"))
        self.assertEqual(summary["admissions"], 1)
        self.assertEqual(self.effects, [])

    def test_backpressure_does_not_queue_a_later_mutation(self):
        receipt, summary = self.run_wire("backpressure")
        self.assertEqual(receipt["delivery"], "not-delivered")
        self.assertEqual(summary["admissions"], 1)
        self.assertEqual(self.effects, [])

    def test_wrong_bus_instance_or_owner_pid_cannot_prepare(self):
        for options, reason in [({"busid": "0" * 32}, "bus-changed"), ({"pid": os.getpid() + 1}, "provider-changed")]:
            receipt, summary = self.run_wire(**options)
            self.assertEqual((receipt["delivery"], receipt["reason"]), ("not-delivered", reason))
            self.assertEqual(summary["admissions"], 0)
            self.assertEqual(self.effects, [])

    def test_defunct_handle_is_refused_before_dispatch(self):
        receipt, _ = self.run_wire("defunct")
        self.assertEqual(receipt["reason"], "stale-object")
        self.assertEqual(self.effects, [])

    def test_application_error_after_effect_stays_unknown_and_private(self):
        receipt, _ = self.run_wire("error")
        self.assertEqual((receipt["delivery"], receipt["reason"]), ("unknown", "method-error"))
        self.assertEqual(len(self.effects), 1)

    def test_application_effect_without_reply_times_out_unknown_once(self):
        receipt, _ = self.run_wire("timeout")
        self.assertEqual((receipt["delivery"], receipt["reason"]), ("unknown", "deadline"))
        self.assertEqual(len(self.effects), 1)

    def test_cancelled_preparation_sends_no_mutation(self):
        receipt, _ = self.run_wire("cancel")
        self.assertEqual((receipt["delivery"], receipt["reason"]), ("not-delivered", "cancelled"))
        self.assertEqual(self.effects, [])


class SemanticTransportTests(unittest.TestCase):
    def receipt(self, **changes):
        return {"schema": 1, "requestId": "a" * 32, "state": "settled", "delivery": "unknown", "accepted": None,
                "reason": "deadline"} | changes

    def test_semantic_receipt_shape_and_fixed_error_privacy(self):
        good = json.dumps(self.receipt())
        self.assertEqual(transport.action_response("ghost-semantic-send", good), good)
        for changes in ({"reason": []}, {"state": {}}, {"delivery": []}, {"schema": True}, {"accepted": True},
                        {"state": "ready"}, {"private": "PRIVATE_PROVIDER_ERROR"}):
            with self.assertRaises(transport.HostError) as caught:
                transport.action_response("ghost-semantic-send", json.dumps(self.receipt(**changes)))
            self.assertNotIn("PRIVATE_PROVIDER_ERROR", str(caught.exception))
        with self.assertRaises(transport.HostError):
            transport.action_response("ghost-semantic-send", good[:-1] + ',"state":"settled"}')

    def test_unknown_is_returned_once_and_wrong_request_id_is_refused(self):
        instance = object.__new__(transport.NativeTransport)
        calls = []
        instance._exchange = lambda request: calls.append(request) or json.dumps(self.receipt())
        command = "ghost-semantic-send TARGET " + "a" * 32
        with patch.object(transport, "require_budget"):
            self.assertEqual(json.loads(instance._perform(command))["delivery"], "unknown")
            instance._exchange = lambda request: calls.append(request) or json.dumps(self.receipt(requestId="b" * 32))
            with self.assertRaises(transport.HostError):
                instance._perform(command)
        self.assertEqual(calls, [command, command])


if __name__ == "__main__":
    unittest.main()

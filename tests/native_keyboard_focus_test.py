"""Compile the actual keyboard resource preparation against focus lifetimes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class KeyboardFocusTests(unittest.TestCase):
    def test_same_surface_retains_keyboard_focus_and_selection(self):
        source = Path(os.environ.get("ORBIT_KEYBOARD_SOURCE", str(Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp"))).read_text()
        signature = "static void prepareKeyboardResource("
        if signature in source:
            start = source.index(signature); end = source.index("\nstatic bool preparationMatches(", start)
            implementation = source[start:end]
        else:
            # Compile the original producer's actual loop body for red/green.
            start = source.index("    for (const auto& keyboard : keyboards) {\n        keyboard->sendKeymap(agentKeyboard);", source.index("static std::string cmdKeyboardPreparation("))
            end = source.index("    wl_array_release(&keys);", start)
            loop = source[start:end].replace("&keys", "keys")
            implementation = "static void prepareKeyboardResource(const SP<Keyboard>& selected,const Target& target,wl_array*keys){std::vector<SP<Keyboard>>keyboards{selected};" + loop + "}"
        fixture = r'''
#include <memory>
#include <map>
#include <vector>
template<typename T>using SP=std::shared_ptr<T>;
struct wl_array{};struct Surface{};
struct Keyboard{std::weak_ptr<Surface>m_currentSurface;int enters=0,keymaps=0;bool selection=false;
 void sendKeymap(int){++keymaps;selection=false;}
 void sendEnter(SP<Surface>surface,wl_array*){++enters;selection=false;m_currentSurface=surface;}
 void sendMods(int,int,int,int){}
};
using CWLKeyboardResource=Keyboard;
struct Target{SP<Surface>surface;};using STarget=Target;
static int agentKeyboard=0;
static std::map<Keyboard*,std::weak_ptr<Keyboard>>agentKeyboards;
'''
        main = r'''
int main(){auto k=std::make_shared<Keyboard>();Target t{std::make_shared<Surface>()};wl_array keys;
 prepareKeyboardResource(k,t,&keys);k->selection=true;prepareKeyboardResource(k,t,&keys);
 if(!k->selection||k->enters!=1||k->keymaps!=1)return 1;
 Target other{std::make_shared<Surface>()};prepareKeyboardResource(k,other,&keys);
 if(k->enters!=2||k->keymaps!=1||k->selection)return 2;
 agentKeyboards.clear();prepareKeyboardResource(k,other,&keys);
 if(k->enters!=3||k->keymaps!=2)return 3;
}
'''
        ack_start = source.index("value->ack = xdg->m_events.ack.listen([raw](uint32_t serial) {")
        ack_start = source.index("{", ack_start) + 1
        ack_end = source.index("    });", ack_start)
        ack = source[ack_start:ack_end]
        fixture += "\nstruct Preparation{unsigned serial=17;bool acknowledged=false,invalid=false;};static bool checkAck(){Preparation p;auto raw=&p;auto callback=[raw](unsigned serial){" + ack + "};callback(16);callback(17);callback(18);return p.acknowledged&&!p.invalid;}\n"
        main = main.replace("int main(){", "int main(){if(!checkAck())return 4;")
        with tempfile.TemporaryDirectory(prefix="orbit-keyboard-focus-") as directory:
            root=Path(directory);cpp=root/"probe.cpp";binary=root/"probe"
            cpp.write_text(fixture+implementation+main)
            subprocess.run(["g++","-std=c++23",str(cpp),"-o",str(binary)],check=True,timeout=30)
            subprocess.run([str(binary)],check=True,timeout=5)


if __name__ == "__main__": unittest.main()

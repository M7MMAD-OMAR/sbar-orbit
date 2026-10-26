"""Compile the actual keyboard resource preparation against focus lifetimes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class KeyboardFocusTests(unittest.TestCase):
    def test_actual_key_handler_normalizes_modifiers_and_consumes_rejected_operations(self):
        source = Path(os.environ.get("ORBIT_KEYBOARD_SOURCE", str(Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp"))).read_text()
        start = source.index("static std::string cmdKey(")
        end = source.index("\n}\n", start) + 3
        fixture = r'''
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <format>
#include <sstream>
#include <string>
#include <vector>
using eHyprCtlOutputFormat=int;using xkb_keysym_t=unsigned;using xkb_mod_index_t=unsigned;
struct xkb_keymap{};struct STarget{std::string error;};struct SStroke{unsigned evdev=0,mods=0,group=0;};
#define XKB_MOD_NAME_CTRL "Control"
#define XKB_MOD_NAME_SHIFT "Shift"
#define XKB_MOD_NAME_ALT "Mod1"
#define XKB_MOD_NAME_LOGO "Mod4"
#define XKB_MOD_INVALID 99
#define XKB_KEY_NoSymbol 0
#define XKB_KEYSYM_CASE_INSENSITIVE 1
#define XKB_KEY_Return 10
#define XKB_KEY_Tab 9
static bool pending=true;static unsigned sends=0,lastMods=0;
static STarget resolve(const std::string&,bool){return {};}
static xkb_keymap* seatKeymap(){static xkb_keymap k;return &k;}
static unsigned xkb_keymap_mod_get_index(xkb_keymap*,const char*n){std::string s=n;return s=="Control"?0:s=="Shift"?1:s=="Mod1"?2:3;}
static unsigned xkb_keysym_from_name(const char*n,int){return std::string(n)=="l"?1:0;}
static unsigned xkb_utf32_to_keysym(unsigned n){return n;}
static bool findKeysym(xkb_keymap*,unsigned,SStroke& s){s={38,0,0};return true;}
static bool consumeKeyboardPreparation(const STarget&,const std::string&,const std::string& token){
 if(token!="mine"||!pending)return false;pending=false;return true;
}
static bool sendStrokes(const STarget&,const std::vector<SStroke>& strokes){++sends;lastMods=strokes.at(0).mods;return true;}
'''
        main = r'''
int main(int argc,char**argv){std::string mode=argv[1];
 if(mode=="aliases"){
 for(auto alias:{"ctrl","CTRL","Ctrl","control","Control_L","Control_R"}){
  pending=true;sends=0;
  if(cmdKey(0,std::string("ghost-key-prepared target mine ")+alias+"+l")!="ok"||pending||sends!=1||lastMods!=1)return 1;
 }
 for(auto entry:std::vector<std::pair<std::string,unsigned>>{{"SHIFT+l",2},{"Alt_L+l",4},{"Super_R+l",8},{"CTRL+Shift_L+l",3}}){
  pending=true;sends=0;
  if(cmdKey(0,"ghost-key-prepared target mine "+entry.first)!="ok"||pending||sends!=1||lastMods!=entry.second)return 2;
 }
 }
 if(mode=="key-rejection"){
 for(auto combo:{"invalid+l","ctrl+unknown"}){
  pending=true;sends=0;
  if(cmdKey(0,std::string("ghost-key-prepared target mine ")+combo)=="ok"||pending||sends)return 3;
 }
 pending=true;sends=0;
 if(cmdKey(0,"ghost-key-prepared target other ctrl+l")=="ok"||!pending||sends)return 4;
 }
 if(mode=="text-rejection"){
 for(auto hex:{"gg","0","c0af","f4908080","eda080"}){
  pending=true;sends=0;
  if(cmdType(0,std::string("ghost-texthex-prepared target mine ")+hex).starts_with("ok")||pending||sends)return 5;
 }
 }
}
'''
        type_start = source.index("static std::string cmdType(")
        type_end = source.index("\n}\n", type_start) + 3
        with tempfile.TemporaryDirectory(prefix="orbit-key-handler-") as directory:
            root=Path(directory);cpp=root/"probe.cpp";binary=root/"probe"
            cpp.write_text(fixture+source[start:end]+source[type_start:type_end]+main)
            subprocess.run(["g++","-std=c++23",str(cpp),"-o",str(binary)],check=True,timeout=30)
            for case in ["aliases", "key-rejection", "text-rejection"]:
                with self.subTest(case=case):
                    subprocess.run([str(binary),case],check=True,timeout=5)

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

"""Compile actual window routing and geometry preservation operations."""
from pathlib import Path
import subprocess
import tempfile
import unittest
import os


def definition(source, signature):
    start=source.index(signature);opening=source.index("{",start);depth=1;end=opening+1
    while depth:
        depth+=(source[end]=="{")-(source[end]=="}");end+=1
    return source[start:end]


class WindowLifecycleTests(unittest.TestCase):
    def test_workspace_presentation_never_dispatches_owner_focus_or_pointer_changes(self):
        source=Path(os.environ.get("ORBIT_PRESENTATION_SOURCE", Path(__file__).resolve().parents[1]/"experiments/ghost-cursor/plugin/ghostinput.cpp"))
        fixture=r'''
#include <memory>
#include <stdexcept>
struct Monitor;
struct Workspace {long m_id=7; bool m_isSpecialWorkspace=false; std::weak_ptr<Monitor> m_monitor;};
using PHLWORKSPACE=std::shared_ptr<Workspace>;
using PHLMONITOR=std::shared_ptr<Monitor>;
#include <optional>
#include <cstdint>
static std::optional<int64_t> workspaceNumber(const PHLWORKSPACE& w){if(!w||w->m_isSpecialWorkspace)return std::nullopt;return w->m_id;}
struct Monitor {
 PHLWORKSPACE m_activeWorkspace,m_activeSpecialWorkspace;
 bool internal=false,noMouse=false,noFocus=false;int changes=0;
 void changeWorkspace(PHLWORKSPACE w,bool i,bool m,bool f){m_activeWorkspace=w;internal=i;noMouse=m;noFocus=f;++changes;}
};
struct Focus {
 PHLMONITOR mon;std::shared_ptr<int> win;
 auto monitor(){return mon;}auto window(){return win;}
};
namespace Desktop {static auto state=std::make_shared<Focus>();auto focusState(){return state;}}
struct Seat {struct {std::weak_ptr<int> keyboardFocus,pointerFocus;}m_state;};
static auto g_pSeatManager=std::make_shared<Seat>();
struct Point {double x=100,y=100;bool operator==(const Point&)const=default;};
namespace Pointer {struct Manager {Point point;auto position(){return point;}};static auto manager=std::make_shared<Manager>();auto mgr(){return manager;}}
namespace State {
 struct Placement {int moves=0;bool noWarp=false;void moveWorkspaceToMonitor(PHLWORKSPACE w,PHLMONITOR m,bool n){++moves;noWarp=n;w->m_monitor=m;}};
 static auto placement=std::make_shared<Placement>();auto workspacePlacementController(){return placement;}
}
struct Layout {bool breakFocus=false;void recalculateMonitor(PHLMONITOR){if(breakFocus)Desktop::state->win.reset();}};
static auto g_layoutManager=std::make_shared<Layout>();
namespace Animation::Workspace {
 enum Type {ANIMATION_TYPE_IN,ANIMATION_TYPE_OUT};
 static int resets=0;static bool allInstant=true;
 void startAnimation(PHLWORKSPACE,Type,bool,bool instant){++resets;allInstant&=instant;}
}
'''
        main=r'''
int main(){
 auto owner=std::make_shared<Monitor>(),target=std::make_shared<Monitor>();
 auto workspace=std::make_shared<Workspace>(),old=std::make_shared<Workspace>();old->m_id=1;
 owner->m_activeWorkspace=old;workspace->m_monitor=owner;
 Desktop::state->mon=owner;Desktop::state->win=std::make_shared<int>(1);
 auto keyboard=std::make_shared<int>(2),pointer=std::make_shared<int>(3);
 g_pSeatManager->m_state.keyboardFocus=keyboard;g_pSeatManager->m_state.pointerFocus=pointer;
 auto rejected=[&](PHLMONITOR m){try{presentWorkspace(workspace,m);return 0;}catch(const PresentationNotReady&){return 1;}catch(const std::runtime_error&){return 2;}};
 if(rejected(owner)!=1||State::placement->moves)return 1;
 target->m_activeSpecialWorkspace=old;
 if(rejected(target)!=1||State::placement->moves)return 2;
 target->m_activeSpecialWorkspace.reset();owner->m_activeWorkspace=workspace;
 if(rejected(target)!=1||State::placement->moves)return 3;
 owner->m_activeWorkspace=old;target->m_activeWorkspace=old;
 presentWorkspace(workspace,target);
 if(State::placement->moves!=1||!State::placement->noWarp||target->changes!=1)return 4;
 if(!target->internal||!target->noMouse||!target->noFocus)return 5;
 if(Animation::Workspace::resets!=2||!Animation::Workspace::allInstant)return 10;
 if(Desktop::state->mon!=owner||!Desktop::state->win||Pointer::manager->point!=Point{})return 6;
 if(g_pSeatManager->m_state.keyboardFocus.lock()!=keyboard||g_pSeatManager->m_state.pointerFocus.lock()!=pointer)return 7;
 presentWorkspace(workspace,target);if(target->changes!=1)return 8;
 target->m_activeWorkspace=old;g_layoutManager->breakFocus=true;
 if(rejected(target)!=2)return 9;
}
'''
        text = source.read_text()
        # The fallback lets injected pre-fix code compile so RED measures its wrong error type.
        error = (definition(text, "struct PresentationNotReady ") + ";" if "struct PresentationNotReady " in text
                 else "struct PresentationNotReady : std::runtime_error { using std::runtime_error::runtime_error; };")
        self.compile_probe(fixture+error+definition(text,"static void presentWorkspace(")+main)

    def test_screen_bounds_and_click_pulse_expiry(self):
        source=Path(os.environ.get("ORBIT_OVERLAY_SOURCE", Path(__file__).resolve().parents[1]/"experiments/ghost-cursor/plugin/ghostinput.cpp")).read_text()
        fixture=r'''
#include <array>
#include <algorithm>
#include <chrono>
#include <cmath>
struct Vector2D {double x,y;};
struct CBox {double x,y,w,h;};
'''
        main=r'''
int main(){
 const auto edges=screenFrame({2560,1600},1.25);
 if(edges[0].x!=0||edges[0].y!=0||edges[0].w!=2560||edges[0].h!=150)return 1;
 if(edges[1].y+edges[1].h!=1600||edges[3].x+edges[3].w!=2560)return 2;
 const auto start=std::chrono::steady_clock::now();
 if(clickProgress({},start)!=-1||clickProgress(start,start)!=0)return 3;
 if(std::abs(clickProgress(start,start+std::chrono::milliseconds(325))-.5)>.0001)return 4;
 if(clickProgress(start,start+std::chrono::milliseconds(650))!=-1)return 5;
 if(clickProgress(start,start-std::chrono::milliseconds(1))!=-1)return 6;
}
'''
        self.compile_probe(fixture+definition(source,"static std::array<CBox, 4> screenFrame(")+definition(source,"static double clickProgress(")+main)

    def test_only_new_causally_parented_dialogs_inherit_workspace_without_an_input_grant(self):
        source=Path(os.environ.get("ORBIT_OVERLAY_SOURCE", Path(__file__).resolve().parents[1]/"experiments/ghost-cursor/plugin/ghostinput.cpp")).read_text()
        fixture=r'''
#include <optional>
#include <string>
#include <memory>
#include <map>
#include <set>
#include <algorithm>
#include <cstdint>
#include <stdexcept>
struct W;using PHLWINDOW=std::shared_ptr<W>;
namespace Math{struct SExpressionVec2{std::string x,y;bool operator==(const SExpressionVec2&)const=default;};}
namespace Desktop::Rule{struct CWindowRuleApplicator{std::weak_ptr<W>m_window;struct{std::optional<bool>floating,center,noInitialFocus;std::optional<Math::SExpressionVec2>size;std::string workspace;}static_;};}
struct Surface{void* owner;void* client(){return owner;}};
template<class T>using SP=std::shared_ptr<T>;using CWLSurfaceResource=Surface;
using wl_client=void;
struct Workspace{std::string m_name;const std::string&addressableName()const{return m_name;}};
struct W{uint64_t m_stableID;bool m_isMapped=true;std::shared_ptr<Workspace>m_workspace;PHLWINDOW ancestor;std::shared_ptr<Surface>surface;
 std::shared_ptr<Desktop::Rule::CWindowRuleApplicator>m_ruleApplicator=std::make_shared<Desktop::Rule::CWindowRuleApplicator>();
 PHLWINDOW parent(){return ancestor;}std::shared_ptr<Surface>resource(){return surface;}
 struct Meta{uint64_t v;uint64_t stableID()const{return v;}};struct Back{PHLWINDOW p;PHLWINDOW parent()const{return p;}bool isX11()const{return false;}};
 Meta metadata()const{return Meta{m_stableID};}Back backend()const{return Back{ancestor};}bool mapped()const{return m_isMapped;}};
struct SLeasedWindow{std::weak_ptr<W>window;bool createdWhileLeased=false;std::optional<bool>noInitialFocus,originalFloating,originalCenter;std::optional<Math::SExpressionVec2>originalSize;std::string originalWorkspace;};
struct SApplicationLease{bool paused=false,ownerInput=false,windowBound=false;std::weak_ptr<W>windowRoot;std::string homeWorkspace="2",homeWorkspaceRule="2 silent";std::optional<Math::SExpressionVec2>newWindowSize=Math::SExpressionVec2{"900","650"};std::map<uint64_t,SLeasedWindow>windows,relatedWindows;std::set<uint64_t>baselineWindows;};
static SApplicationLease lease;
static bool ownerInputActive(const SApplicationLease& target){return target.ownerInput;}
static SApplicationLease* applicationLeaseForClient(void* client){return client==reinterpret_cast<void*>(1)?&lease:nullptr;}
static int enrollments=0,configurations=0;
static void retainApplicationWindow(SApplicationLease& target,PHLWINDOW window,bool created){if(target.windows.contains(window->m_stableID))return;++enrollments;auto&saved=target.windows[window->m_stableID];saved.window=window;saved.createdWhileLeased=created;}
static void applyApplicationWindow(PHLWINDOW){++configurations;}
static void recordApplicationFailure(void*,const char*){}
'''
        main=r'''
int main(){
 auto parent=std::make_shared<W>();parent->m_stableID=1;parent->m_workspace=std::make_shared<Workspace>("2");parent->surface=std::make_shared<Surface>(reinterpret_cast<void*>(1));lease.windows[1]={};
 auto dialog=std::make_shared<W>();dialog->m_stableID=2;dialog->m_isMapped=false;dialog->ancestor=parent;dialog->surface=std::make_shared<Surface>(reinterpret_cast<void*>(2));
 Desktop::Rule::CWindowRuleApplicator rules;rules.m_window=dialog;rules.static_.workspace="1";rules.static_.floating=false;
 rules.static_.center=false;rules.static_.size=Math::SExpressionVec2{"420","310"};rules.static_.noInitialFocus=false;
 auto sameClient=std::make_shared<W>();sameClient->m_stableID=41;sameClient->m_isMapped=false;sameClient->surface=parent->surface;
 // Owner-created windows and portal dialogs stay untouched throughout pause or physical input.
 for(int mode=0;mode<2;++mode){
  lease.paused=mode==0;lease.ownerInput=mode==1;
  for(auto target:{dialog,sameClient}){
   rules.m_window=target;enforceApplicationRules(&rules);
   if(rules.static_.workspace!="1"||rules.static_.floating!=false||rules.static_.center!=false||rules.static_.size!=Math::SExpressionVec2{"420","310"}||rules.static_.noInitialFocus!=false)return 17;
   if(lease.windows.size()!=1||!lease.relatedWindows.empty()||enrollments||configurations)return 18;
  }
 }
 lease.paused=false;lease.ownerInput=false;rules.m_window=dialog;
 enforceApplicationRules(&rules);
 if(rules.static_.workspace!="2 silent"||rules.static_.floating!=false||rules.static_.noInitialFocus!=true)return 1;
 if(lease.windows.size()!=1||lease.windows.contains(2)||lease.relatedWindows.size()!=1||enrollments||configurations)return 2;
 if(lease.relatedWindows.at(2).originalWorkspace!="1")return 3;
 dialog->m_isMapped=true;rules.static_.workspace="5";rules.static_.floating=false;rules.static_.center=false;
 rules.static_.size=Math::SExpressionVec2{"420","310"};enforceApplicationRules(&rules);
 if(lease.relatedWindows.at(2).originalWorkspace!="1"||rules.static_.workspace!="5"||rules.static_.floating!=false||rules.static_.center!=false||rules.static_.size!=Math::SExpressionVec2{"420","310"})return 4;
 lease.paused=true;if(relatedApplicationLease(dialog))return 5;lease.paused=false;
 lease.baselineWindows.insert(2);if(relatedApplicationLease(dialog))return 6;lease.baselineWindows.clear();
 parent->m_workspace->m_name="3";if(relatedApplicationLease(dialog))return 7;parent->m_workspace->m_name="2";
 parent->m_isMapped=false;if(relatedApplicationLease(dialog))return 8;parent->m_isMapped=true;
 dialog->ancestor.reset();if(relatedApplicationLease(dialog))return 9;
 dialog->ancestor=dialog;if(relatedApplicationLease(dialog))return 10;dialog->ancestor.reset();
 // A leased shared service may map another owner's unrelated dialog later.
 lease.windowBound=true;lease.windowRoot=parent;
 auto ownerParent=std::make_shared<W>();ownerParent->m_stableID=10;ownerParent->surface=std::make_shared<Surface>(reinterpret_cast<void*>(3));
 auto ownerDialog=std::make_shared<W>();ownerDialog->m_stableID=11;ownerDialog->surface=parent->surface;ownerDialog->ancestor=ownerParent;
 rules.m_window=ownerDialog;rules.static_.workspace="4";rules.static_.noInitialFocus=false;rules.static_.floating=false;
 enforceApplicationRules(&rules);
 if(rules.static_.workspace!="4"||rules.static_.noInitialFocus!=false||rules.static_.floating!=false||lease.windows.contains(11)||enrollments||configurations)return 11;
 // The selected dialog's own transient children still belong to its family.
 ownerDialog->ancestor=parent;ownerDialog->m_isMapped=false;enforceApplicationRules(&rules);
 if(rules.static_.workspace!="2 silent"||!lease.windows.contains(11)||enrollments!=1||configurations!=1||rules.static_.floating!=false)return 12;
 // Rechecking a mapped new sibling preserves later toolkit and owner geometry/workspace.
 ownerDialog->m_isMapped=true;rules.static_.workspace="special:owner";rules.static_.floating=false;
 rules.static_.center=false;rules.static_.size=Math::SExpressionVec2{"510","390"};enforceApplicationRules(&rules);
 if(rules.static_.workspace!="special:owner"||rules.static_.floating!=false||rules.static_.center!=false||rules.static_.size!=Math::SExpressionVec2{"510","390"})return 14;
 // A late-observed already mapped sibling is enrolled without changing its workspace rule.
 auto late=std::make_shared<W>();late->m_stableID=31;late->surface=parent->surface;late->ancestor=parent;
 rules.m_window=late;rules.static_.workspace="special:late";enforceApplicationRules(&rules);
 if(rules.static_.workspace!="special:late"||lease.windows.at(31).createdWhileLeased)return 15;
 // Taking one dialog must not restore another parent's placement in that service.
 auto otherDialog=std::make_shared<W>();otherDialog->m_stableID=21;otherDialog->surface=dialog->surface;
 otherDialog->m_ruleApplicator->static_.workspace="6 silent";
 SLeasedWindow saved;saved.window=otherDialog;saved.createdWhileLeased=true;saved.originalWorkspace="4";
 lease.relatedWindows[21]=saved;
 SApplicationLease selected;selected.windowBound=true;selected.windowRoot=dialog;
 dialog->m_ruleApplicator->static_.workspace="special:owner";
 dialog->m_ruleApplicator->static_.floating=false;dialog->m_ruleApplicator->static_.size=Math::SExpressionVec2{"360","270"};
 restoreRelatedWindows(lease,reinterpret_cast<void*>(2),&selected);
 if(lease.relatedWindows.contains(2)||!lease.relatedWindows.contains(21)||otherDialog->m_ruleApplicator->static_.workspace!="6 silent")return 13;
 if(dialog->m_ruleApplicator->static_.workspace!="special:owner"||dialog->m_ruleApplicator->static_.floating!=false||dialog->m_ruleApplicator->static_.size!=Math::SExpressionVec2{"360","270"})return 16;
 // A delayed owner-created top-level sibling has no causal parent after idle.
 lease.windowBound=false;lease.paused=false;lease.ownerInput=false;
 rules.m_window=sameClient;rules.static_.workspace="special:owner-idle";
 rules.static_.floating=false;rules.static_.center=false;rules.static_.size=Math::SExpressionVec2{"470","330"};
 enforceApplicationRules(&rules);
 if(rules.static_.workspace!="special:owner-idle"||rules.static_.floating!=false||rules.static_.center!=false||rules.static_.size!=Math::SExpressionVec2{"470","330"}||lease.windows.at(41).createdWhileLeased)return 19;
}
'''
        related=(definition(source,"static SApplicationLease* relatedApplicationLease(")+definition(source,"static void routeRelatedApplicationWindow(")) if "static SApplicationLease* relatedApplicationLease(" in source else "static SApplicationLease* relatedApplicationLease(PHLWINDOW){return nullptr;}"
        allowed=definition(source,"static bool applicationWindowAllowed(") if "static bool applicationWindowAllowed(" in source else ""
        restoration=(definition(source,"static void restoreApplicationGeometry(") if "static void restoreApplicationGeometry(" in source else "")+definition(source,"static void restoreRelatedWindows(")
        self.compile_probe(fixture+allowed+restoration+(definition(source,"static void applyNewApplicationGeometry(") if "static void applyNewApplicationGeometry(" in source else "")+related+definition(source,"static void enforceApplicationRules(")+main)

    def compile_probe(self, source):
        with tempfile.TemporaryDirectory(prefix="orbit-window-lifecycle-")as directory:
            root=Path(directory);cpp=root/"probe.cpp";binary=root/"probe"
            cpp.write_text(source)
            subprocess.run(["g++","-std=c++23",str(cpp),"-o",str(binary)],check=True,timeout=30)
            subprocess.run([str(binary)],check=True,timeout=5)

    def test_lease_never_infers_or_restores_geometry_from_selected_parent(self):
        source=(Path(__file__).resolve().parents[1]/"experiments/ghost-cursor/plugin/ghostinput.cpp").read_text()
        for signature in ("static std::string claimApplication(", "static void handbackApplication(",
                          "static void restoreRelatedWindows(", "static void enforceApplicationRules(",
                          "static void routeRelatedApplicationWindow("):
            body=definition(source,signature)
            self.assertNotIn("newWindowSize",body)
            self.assertNotIn("applyNewApplicationGeometry",body)
            self.assertNotIn("restoreApplicationGeometry",body)
        self.assertNotIn("newWindowSize",source)
        self.assertNotIn("originalFloating",source)
        self.assertNotIn("originalCenter",source)
        self.assertNotIn("originalSize",source)


if __name__=="__main__":unittest.main()

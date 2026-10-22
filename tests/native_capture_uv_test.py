"""Compile the actual export UV callback with geometry and lease fixtures."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class CaptureUVTests(unittest.TestCase):
    def test_leased_main_surface_crops_csd_in_desktop_and_capture(self):
        source = (Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp").read_text()
        start = source.index("static void applicationSurfaceUV(")
        end = source.index("\nstatic CFunctionHook* applicationHook(", start)
        fixture = r'''
#include <memory>
#include <cmath>
struct Vector2D {
 double x=0,y=0;
 Vector2D operator+(Vector2D v)const{return{x+v.x,y+v.y};}
 Vector2D operator-(Vector2D v)const{return{x-v.x,y-v.y};}
 Vector2D operator*(Vector2D v)const{return{x*v.x,y*v.y};}
 bool operator==(const Vector2D&)const=default;
};
template<typename T>using SP=std::shared_ptr<T>;
struct Box{double x,y,w,h;};
struct XDG{struct{Box geometry;}m_current;};
struct Window{std::weak_ptr<XDG>m_xdgSurface;};using PHLWINDOW=SP<Window>;
struct CWLSurfaceResource{struct{Vector2D size,bufferSize;struct{bool hasSource=false;Box source;}viewport;}m_current;};
struct Monitor{};using PHLMONITOR=SP<Monitor>;
namespace Render{class IElementRenderer{};enum{RPT_MONITOR,RPT_EXPORT};}
struct Renderer{struct{int projectionType=Render::RPT_EXPORT;Vector2D primarySurfaceUVTopLeft,primarySurfaceUVBottomRight;}m_renderData;};
static Renderer renderer;static auto g_pHyprRenderer=&renderer;
static bool leased=true;static bool leasedWindow(PHLWINDOW){return leased;}
static void original(Render::IElementRenderer*,PHLWINDOW&,SP<CWLSurfaceResource>&,PHLMONITOR&,bool,const Vector2D&,const Vector2D&,bool){
 renderer.m_renderData.primarySurfaceUVTopLeft={-1,-1};renderer.m_renderData.primarySurfaceUVBottomRight={-1,-1};
}
struct Hook{void*m_original;};static Hook hook{reinterpret_cast<void*>(original)};static auto surfaceUVHook=&hook;
'''
        main = r'''
int main(){
 auto xdg=std::make_shared<XDG>();auto w=std::make_shared<Window>();w->m_xdgSurface=xdg;
 auto s=std::make_shared<CWLSurfaceResource>();s->m_current.size={890,690};PHLMONITOR m;
 xdg->m_current.geometry={25,25,840,640};
 auto run=[&]{applicationSurfaceUV(nullptr,w,s,m,true,{},{},false);};
 auto equal=[](double a,double b){return std::abs(a-b)<0.00000001;};
 run();auto&d=renderer.m_renderData;
 if(!equal(d.primarySurfaceUVTopLeft.x,25.0/890)||!equal(d.primarySurfaceUVTopLeft.y,25.0/690)||
    !equal(d.primarySurfaceUVBottomRight.x,865.0/890)||!equal(d.primarySurfaceUVBottomRight.y,665.0/690))return 1;
 s->m_current.bufferSize={2000,1800};s->m_current.viewport.hasSource=true;
 s->m_current.viewport.source={100,200,1780,1380};run();
 if(!equal(d.primarySurfaceUVTopLeft.x,0.05+(25.0/890)*0.89)||
    !equal(d.primarySurfaceUVBottomRight.y,200.0/1800+(665.0/690)*(1380.0/1800)))return 6;
 leased=false;run();if(!(d.primarySurfaceUVTopLeft==Vector2D{-1,-1}))return 2;
 leased=true;d.projectionType=Render::RPT_MONITOR;run();if(!equal(d.primarySurfaceUVTopLeft.x,0.05+(25.0/890)*0.89))return 3;
 d.projectionType=Render::RPT_EXPORT;xdg->m_current.geometry={0,0,840,640};run();if(!(d.primarySurfaceUVTopLeft==Vector2D{-1,-1}))return 4;
 xdg->m_current.geometry={25,25,900,640};run();if(!(d.primarySurfaceUVTopLeft==Vector2D{-1,-1}))return 5;
}
'''
        with tempfile.TemporaryDirectory(prefix="orbit-capture-uv-") as directory:
            root = Path(directory); cpp = root / "probe.cpp"; binary = root / "probe"
            cpp.write_text(fixture + source[start:end] + main)
            subprocess.run(["g++", "-std=c++23", str(cpp), "-o", str(binary)], check=True, timeout=30)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == "__main__":
    unittest.main()

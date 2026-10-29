"""Compile actual window-to-surface input coordinates, including client shadows."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class PointerGeometryTests(unittest.TestCase):
    def test_input_uses_xdg_geometry_and_window_coordinates(self):
        source=Path(os.environ.get("ORBIT_POINTER_SOURCE",str(Path(__file__).resolve().parents[1]/"experiments/ghost-cursor/plugin/ghostinput.cpp"))).read_text()
        if "static std::optional<Vector2D> surfaceInputPoint(" in source:
            start=source.index("static std::optional<Vector2D> surfaceInputPoint(");end=source.index("\n// BEGIN pointer-hold",start);operation=source[start:end]
        else:
            body=source[source.index("static std::string pointerCmd("):]
            assignment=re.search(r"const Vector2D local\{x, y\};",body).group()
            operation="static std::optional<Vector2D> surfaceInputPoint(Vector2D goal,Vector2D size,CBox geometry,Vector2D point){double x=point.x,y=point.y;"+assignment+"return local;}"
        fixture=r'''
#include <cmath>
#include <optional>
struct Vector2D{double x=0,y=0;};struct CBox{double x=0,y=0,w=0,h=0;};
'''
        main=r'''
int main(){auto p=surfaceInputPoint({840,640},{890,690},{25,25,840,640},{10,20});
 if(!p||p->x!=35||p->y!=45)return 1;
 p=surfaceInputPoint({1000,750},{800,600},{},{500,375});if(!p||p->x!=400||p->y!=300)return 2;
 if(surfaceInputPoint({840,640},{890,690},{25,25,840,640},{-1,20}))return 3;
 if(surfaceInputPoint({840,640},{890,690},{25,25,840,640},{840,20}))return 4;
 if(surfaceInputPoint({0,640},{890,690},{25,25,840,640},{0,20}))return 5;
 p=surfaceInputPoint({840,640},{890,690},{-2,0,840,640},{0,20});if(!p||p->x!=-2||p->y!=20)return 6;
}
'''
        with tempfile.TemporaryDirectory(prefix="orbit-pointer-geometry-")as directory:
            root=Path(directory);cpp=root/"probe.cpp";binary=root/"probe";cpp.write_text(fixture+operation+main)
            subprocess.run(["g++","-std=c++23",str(cpp),"-o",str(binary)],check=True,timeout=30)
            subprocess.run([str(binary)],check=True,timeout=5)


if __name__=="__main__":unittest.main()

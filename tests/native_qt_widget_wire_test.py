"""Real owned Qt helper wire fixture, separate from original application acceptance."""
import os,subprocess,json,sys,time,select
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from gi.repository import Gio,GLib
from src.native.a11y_qt_identity import BASE,INTERFACE,mapped_bridge
p=subprocess.Popen([sys.argv[1]],env=dict(os.environ,QT_QPA_PLATFORM='offscreen',LD_PRELOAD=os.path.abspath('src/native/qt/liborbit-qt-widget.so')),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 assert select.select([p.stdout],[],[],5)[0], 'fixture did not initialize'
 info=json.loads(p.stdout.readline());pid=info['pid']
 session=Gio.bus_get_sync(Gio.BusType.SESSION,None)
 addr=session.call_sync('org.a11y.Bus','/org/a11y/bus','org.a11y.Bus','GetAddress',None,GLib.VariantType.new('(s)'),Gio.DBusCallFlags.NONE,1000,None).unpack()[0]
 bus=Gio.DBusConnection.new_for_address_sync(addr,Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
 owner='org.sbar.Orbit.QtWidget.p'+str(pid)
 def call(path,interface,method,args,out): return bus.call_sync(owner,path,interface,method,args,GLib.VariantType.new(out),Gio.DBusCallFlags.NONE,1000,None).unpack()
 assert mapped_bridge(pid)
 assert call(BASE,INTERFACE,'Version',None,'(ss)')==('orbit-qt-widget-1','6.11.2')
 routes=call(BASE,INTERFACE,'Bind',GLib.Variant('(sas)',(info['root'],[info[k] for k in ['root','button','check','edit','outsider','modal','value','dialogButton']])),'(a{ss})')[0]
 assert info['outsider'] not in routes
 assert info['dialogButton'] not in routes
 assert call(BASE,INTERFACE,'Verify',GLib.Variant('(a{ss})',(routes,)),'(b)')==(True,)
 call(routes[info['button']],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)')
 call(routes[info['check']],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)')
 call(routes[info['edit']],'org.a11y.atspi.EditableText','SetTextContents',GLib.Variant('(s)',('after',)),'(b)')
 call(routes[info['value']],'org.freedesktop.DBus.Properties','Set',GLib.Variant('(ssv)',('org.a11y.atspi.Value','CurrentValue',GLib.Variant('d',3.5))),'()')
 service='org.sbar.Orbit.QtFixture.p'+str(pid)
 def fc(method,out): return session.call_sync(service,'/fixture','org.sbar.Orbit.QtFixture1',method,None,GLib.VariantType.new(out),Gio.DBusCallFlags.NONE,1000,None).unpack()
 deadline=time.monotonic()+2
 while (state:=fc('State','(ibsd)'))[0]!=1 and time.monotonic()<deadline: time.sleep(0.02)
 assert state==(1,True,'after',3.5)
 # A modal tool-button callback must not withhold the acceptance reply or
 # block additional helper calls on the same managed-bus connection.
 call(routes[info['modal']],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)')
 deadline=time.monotonic()+2
 while not fc('ModalOpen','(b)')[0] and time.monotonic()<deadline: time.sleep(0.02)
 assert fc('ModalOpen','(b)')[0]
 call(routes[info['check']],'org.a11y.atspi.Accessible','GetState',None,'(au)')
 fc('CloseModal','()')
 fc('ReadOnlyValue','()')
 try: call(routes[info['value']],'org.freedesktop.DBus.Properties','Set',GLib.Variant('(ssv)',('org.a11y.atspi.Value','CurrentValue',GLib.Variant('d',9.5))),'()');raise AssertionError('readonly value changed')
 except GLib.Error as e: assert Gio.DBusError.get_remote_error(e)=='org.sbar.Orbit.UnsupportedInterface'
 # A primary interface can be invalidated while its QWidget stays alive.
 # QPointer alone is insufficient: the original numeric path must still pair.
 changed=fc('InvalidateInterface','(s)')[0]
 assert call(BASE,INTERFACE,'Verify',GLib.Variant('(a{ss})',(routes,)),'(b)')==(False,)
 try: call(routes[info['button']],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)');raise AssertionError('unregistered interface accepted')
 except GLib.Error as e: assert Gio.DBusError.get_remote_error(e)=='org.sbar.Orbit.StaleRef'
 fresh=call(BASE,INTERFACE,'Bind',GLib.Variant('(sas)',(info['root'],[changed])),'(a{ss})')[0]
 call(fresh[changed],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)')
 deadline=time.monotonic()+2
 while (state:=fc('State','(ibsd)'))[0]!=2 and time.monotonic()<deadline: time.sleep(0.02)
 assert state==(2,True,'after',3.5)
 replacement=fc('Delete','(s)')[0]
 try: call(fresh[changed],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)');raise AssertionError('deleted replacement accepted')
 except GLib.Error as e: assert Gio.DBusError.get_remote_error(e)=='org.sbar.Orbit.StaleRef'
 assert call(BASE,INTERFACE,'Verify',GLib.Variant('(a{ss})',(routes,)),'(b)')==(False,)
 try: call(routes[info['button']],'org.a11y.atspi.Action','DoAction',GLib.Variant('(i)',(0,)),'(b)');raise AssertionError('stale route accepted')
 except GLib.Error as e: assert Gio.DBusError.get_remote_error(e)=='org.sbar.Orbit.StaleRef'
 assert fc('State','(ibsd)')==(2,True,'after',3.5)
 call(BASE,INTERFACE,'Release',GLib.Variant('(as)',(list(routes.values()),)),'()')
 fc('Quit','()')
 assert p.wait(timeout=5)==0
 print('OK',file=sys.stderr,flush=True)
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=5)
 print(p.stderr.read(),file=sys.stderr)

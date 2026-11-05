"""Private semantic orchestration, real validation and owner admission, owned transport."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.semantic_actions import SemanticActions, SemanticError, control_request
from src.native.session import NativeSession, NativeRefError
from src.native.transport import OWNER_PAUSED
from src.native.control import ActionControl, ControlError

ACTION = dict(type='invoke-ref', appId='a'*32, windowId='b'*32, ref='@'+'c'*32+':e1')

class Fixture:
    closed = False
    plan = None
    parse = staticmethod(NativeSession.parse)
    def __init__(self, control):
        self.control = control
        self.transport = self
        self.commands = []
        self.accepted = True
        self.unknown = False
        self.proof = dict(owner=':1.2', path='/org/a11y/atspi/accessible/one', address='unix:path=/tmp/owned', busId='d'*32, pid=123)
        self.interfaces = ['Action', 'EditableText', 'Value']
        self.size, self.geometry = [800,600], None
    def _app(self, _): return SimpleNamespace(unit='lease-'+'e'*32)
    def _target(self, *_): return dict(address='0x1', key=(123,'1'), size=list(self.size))
    def _geometry(self, *_): return self.geometry
    def _reference_point(self, *args, **kwargs): return dict(point=(20,30),surface=tuple(self.size),geometry=self.geometry)
    def _await_drag(self, guarded): pass
    def _perform(self, command):
        self.commands.append(command)
        if self.unknown: raise TimeoutError('Owned pointer reply lost after effect')
        return 'ok'
    def _tree(self, *_args, **_kwargs):
        return dict(status='ok', mutationIdentity=True, semanticTarget=copy.deepcopy(self.proof), interfaces=self.interfaces, actionCount=1, node=dict(box=[1,2,30,40]))
    def _exchange(self, command, **_):
        if command.startswith('ghost-click '):
            return self._perform(command)
        self.commands.append(command)
        parts=command.split(); kind=parts[0]; token=parts[2]
        state, delivery, accepted, reason='ready','not-delivered',None,'prepared'
        if kind.endswith('send'):
            state='settled'; delivery='unknown' if self.unknown else 'delivered'
            accepted=None if self.unknown else self.accepted
            reason='deadline' if self.unknown else 'replied'
        if kind.endswith('cancel'): state,reason='settled','cancelled'
        return json.dumps(dict(schema=1,requestId=token,state=state,delivery=delivery,accepted=accepted,reason=reason))
    def sends(self): return sum(c.startswith('ghost-semantic-send ') for c in self.commands)

class Tests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.control=ActionControl(self.directory.name)
        self.control.configure(mode='full')
        self.session=Fixture(self.control)
        self.manager=SemanticActions(self.session)
        self.patches=[patch('src.native.semantic_actions.require_budget'),patch('src.native.semantic_actions.verify_host')]
        for p in self.patches:p.start()
    def tearDown(self):
        self.manager.close()
        for p in reversed(self.patches):p.stop()
        self.control.close();self.directory.cleanup()
    def prepare(self, action=ACTION): return self.manager.prepare(action)['token']
    def test_prepare_and_cancel_never_send_and_hide_provider_routing(self):
        prepared=self.manager.prepare(ACTION)
        self.assertEqual(set(prepared),{'token'})
        self.assertEqual(self.session.sends(),0)
        self.manager.cancel(prepared['token'])
        with self.assertRaises(SemanticError):self.manager.send(prepared['token'],ACTION)
        self.assertEqual(self.session.sends(),0)
    def test_pointer_ref_prepares_without_input_and_delivers_corrected_point_once(self):
        action=dict(ACTION,type='ref-click')
        self.session.interfaces=[]
        token=self.prepare(action)
        self.assertEqual(self.session.commands,[])
        self.assertEqual(self.manager.send(token,action),{'response':'ok'})
        self.assertEqual(self.manager.send(token,action),{'response':'ok'})
        self.assertEqual(self.session.commands,['ghost-click 0x1@1@lease-'+'e'*32+' 20 30 1'])
    def test_pointer_ref_revocation_and_unknown_never_replay_input(self):
        action=dict(ACTION,type='ref-click')
        token=self.prepare(action)
        self.manager.cancel(token)
        with self.assertRaises(SemanticError): self.manager.send(token,action)
        self.assertEqual(self.session.commands,[])
        token=self.prepare(action)
        self.session.unknown=True
        for _ in range(2):
            with self.assertRaises(SemanticError) as error: self.manager.send(token,action)
            self.assertEqual(error.exception.delivery,'unknown')
        self.assertEqual(len(self.session.commands),1)
    def test_pointer_ref_owner_pause_refusal_never_retries_stale_coordinates(self):
        action=dict(ACTION,type='ref-click')
        token=self.prepare(action)
        calls=[]
        def once(command, **kwargs):
            calls.append((command,kwargs))
            if len(calls)==1:
                # The owner changes the UI after the first compositor refusal.
                self.session.proof['path']='/org/a11y/atspi/accessible/replaced'
                return OWNER_PAUSED+' types or clicks in this client'
            return 'ok'
        self.session.transport._exchange=once
        self.session.transport._perform=lambda command: self.fail('A ref click must not enter the retrying transport')
        for _ in range(2):
            with self.assertRaises(SemanticError):self.manager.send(token,action)
        self.assertEqual(len(calls),1)
        self.assertIn('deadline',calls[0][1])
    def test_pointer_ref_resize_or_recrop_between_prepare_and_send_never_clicks(self):
        action=dict(ACTION,type='ref-click')
        for change in ('size','geometry'):
            token=self.prepare(action)
            if change=='size': self.session.size=[900,600]
            else: self.session.geometry=(8,9,780,580)
            with self.assertRaises(SemanticError) as error:self.manager.send(token,action)
            self.assertEqual(error.exception.delivery,'not-delivered')
            self.assertEqual(self.session.commands,[])
            self.session.size,self.session.geometry=[800,600],None
    def test_wrong_token_or_modified_content_never_send(self):
        action=dict(ACTION,type='edit-ref',text='private')
        token=self.prepare(action)
        for t,a in [('f'*32,action),(token,dict(action,text='changed'))]:
            with self.assertRaises(SemanticError):self.manager.send(t,a)
        self.assertEqual(self.session.sends(),0)
    def test_fresh_identity_change_prevents_send(self):
        token=self.prepare(); self.session.proof['owner']=':1.3'
        with self.assertRaises(SemanticError):self.manager.send(token,ACTION)
        self.assertEqual(self.session.sends(),0)
    def test_interface_or_action_index_must_exist(self):
        self.session.interfaces=[]
        with self.assertRaises(SemanticError):self.prepare()
        self.session.interfaces=['Action']
        with self.assertRaises(SemanticError):self.prepare(dict(ACTION,index=1))
        self.assertEqual(self.session.commands,[])
    def test_refusal_is_delivered_and_deduplicated_without_fallback(self):
        self.session.accepted=False; token=self.prepare()
        result=self.manager.send(token,ACTION)
        self.assertEqual(result,dict(semantic=dict(delivery='delivered',accepted=False,outcome='refused')))
        self.assertEqual(self.manager.send(token,ACTION),result)
        self.assertEqual(self.session.sends(),1)
    def test_unknown_is_cached_and_never_replayed(self):
        self.session.unknown=True;token=self.prepare()
        for _ in range(2):
            with self.assertRaises(SemanticError) as error:self.manager.send(token,ACTION)
            self.assertEqual(error.exception.delivery,'unknown')
        self.assertEqual(self.session.sends(),1)
    def test_status_timeout_after_send_is_typed_unknown_on_first_and_cached_reply(self):
        token=self.prepare()
        original=self.manager._plugin
        def pending_then_timeout(command, request_id, deadline):
            if command.startswith('ghost-semantic-status '):
                raise TimeoutError('Owned status timeout after application delivery')
            receipt=original(command,request_id,deadline)
            if command.startswith('ghost-semantic-send '):
                receipt.update(state='pending',delivery='unknown',accepted=None)
            return receipt
        with patch.object(self.manager,'_plugin',side_effect=pending_then_timeout):
            for _ in range(2):
                with self.assertRaises(SemanticError) as error:
                    self.manager.send(token,ACTION)
                self.assertEqual((error.exception.code,error.exception.delivery),('SEMANTIC_UNKNOWN','unknown'))
        self.assertEqual(self.session.sends(),1)
    def test_exact_protected_action_binds_text_and_value(self):
        a=NativeSession.parse(dict(ACTION,type='edit-ref',text='private'))
        b=dict(a,text='changed')
        self.assertNotEqual(control_request(a),control_request(b))
        self.assertNotEqual(control_request(dict(ACTION,type='value-ref',value=1)),control_request(dict(ACTION,type='value-ref',value=2)))
        self.control.configure(mode='protected',approve=control_request(a))
        token=self.prepare(b)
        with self.assertRaises(ControlError):self.manager.send(token,b)
        self.assertEqual(self.session.sends(),0)
        token=self.prepare(a);self.manager.send(token,a)
        self.assertEqual(self.session.sends(),1)
        journal=Path(self.directory.name,'actions.jsonl').read_text()
        self.assertNotIn('private',journal);self.assertNotIn('/org/a11y',journal)
    def reference_capture(self, *, changed=False, resized=False):
        target=dict(address='0x1',key=(123,'1'),size=[800,600])
        record=dict(role='table cell',name='OwnedFolder',act=1,box=[190,290,100,100])
        reply=dict(status='ok',mutationIdentity=True,toolkit='GTK',node=record,semanticTarget=self.session.proof)
        reads=[]
        def tree(*args,**kwargs):
            current=copy.deepcopy(reply)
            if reads and changed: current['node']['name']='Replacement'
            reads.append(current)
            return current
        session=SimpleNamespace(plan=dict(runtime='/owned',display='wayland-owned'),
            _tree=tree,_geometry=lambda address: None,_check_target=lambda address: None,
            _target=lambda *args: {**target,'size':[900,600] if resized else [800,600]},
            _app=lambda app: SimpleNamespace(profile=Path(self.directory.name)))
        tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t200\t300\t80\t16\t99\tOwnedFolder\n'
        with patch('src.native.session.bounded_capture',return_value=(b'owned pixels',800,600)), \
                patch('src.native.session.verify_host'),patch('src.native.a11y_pixels._ocr',return_value=tsv.encode()):
            return NativeSession._reference_point(session,dict(ACTION,type='ref-click'),target,'0x1@1@owned')
    def test_reference_point_uses_pixel_label_instead_of_inaccurate_provider_center(self):
        self.assertEqual(self.reference_capture(),dict(point=(240,308),surface=(800,600),geometry=None))
        self.assertEqual(self.session.commands,[])
    def test_reference_point_refuses_ui_change_during_capture_without_pointer_input(self):
        with self.assertRaises(NativeRefError): self.reference_capture(changed=True)
        self.assertEqual(self.session.commands,[])
    def test_reference_point_refuses_resized_target_without_pointer_input(self):
        with self.assertRaises(NativeRefError): self.reference_capture(resized=True)
        self.assertEqual(self.session.commands,[])
    def test_public_bounds_and_empty_edit(self):
        for action in [dict(ACTION,index=32),dict(ACTION,index=True),dict(ACTION,type='edit-ref',text='é'*8001),dict(ACTION,type='value-ref',value=float('nan')),dict(ACTION,token='f'*32)]:
            with self.assertRaises(Exception):NativeSession.parse(action)
        for action in [dict(ACTION,type='edit-ref',text=''),dict(ACTION,type='edit-ref',text='é'*8000),dict(ACTION,type='value-ref',value=1.5)]:
            token=self.prepare(action);self.manager.send(token,action)
        self.assertEqual(self.session.sends(),3)

if __name__=='__main__':unittest.main()

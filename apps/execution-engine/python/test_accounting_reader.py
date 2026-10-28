import io
import unittest
from unittest.mock import patch
from accounting_reader import Reader, scalar
from ibapi.client import EClient
from ibapi.execution import ExecutionFilter
from ibapi.protobuf.ConfigResponse_pb2 import ConfigResponse
from ibapi.protobuf.CommissionAndFeesReport_pb2 import CommissionAndFeesReport
from ibapi.protobuf.ExecutionDetails_pb2 import ExecutionDetails
from ibapi.protobuf.ExecutionRequest_pb2 import ExecutionRequest
from ibapi.protobuf.ConfigRequest_pb2 import ConfigRequest
from ibapi.comm import make_msg_proto


class Tests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader(io.BytesIO())
        self.reader.account = 'TEST'
        self.events = []
        self.reader.emit = lambda *args: self.events.append(args)
        self.addCleanup(lambda: self.reader.outbox.put(None))

    def test_master_presence_not_default_zero(self):
        self.reader.pending['config'] = {'commandId': 1, 'requestId': 1}
        response = ConfigResponse(reqId=1)
        response.api.settings.readOnlyApi = True
        with self.assertRaisesRegex(ValueError, 'FIELD_MISSING'): self.reader.configResponseProtoBuf(response)
        response.api.settings.masterClientId = 0
        self.reader.configResponseProtoBuf(response)
        self.assertEqual(self.events[0][1], {'masterClientIdPresent': True, 'masterClientId': 0})

    def test_commission_omitted_and_unset_are_not_zero(self):
        self.reader.commissionAndFeesReportProtoBuf(CommissionAndFeesReport(execId='e', currency='USD'))
        self.assertIsNone(self.events[-1][1]['commission'])
        self.assertIsNone(self.events[-1][1]['realizedPNL'])
        self.reader.commissionAndFeesReportProtoBuf(CommissionAndFeesReport(execId='e', currency='USD', commissionAndFees=0, realizedPNL=1.7976931348623157e308))
        self.assertEqual(self.events[-1][1]['commission'], 0)
        self.assertIsNone(self.events[-1][1]['realizedPNL'])
        self.assertIsNone(scalar(float('nan')))

    def test_execution_missing_fields_rejected_and_decimal_kept(self):
        record = ExecutionDetails(reqId=7)
        record.contract.conId = 123
        with self.assertRaises(ValueError): self.reader.executionDetailsProtoBuf(record)
        record.contract.symbol = 'TEST'; record.contract.secType = 'STK'; record.contract.currency = 'USD'
        record.execution.orderId = 1; record.execution.execId = 'exec'; record.execution.time = '20261028 12:00:00Z'
        record.execution.acctNumber = 'TEST'; record.execution.exchange = 'SMART'; record.execution.side = 'BOT'
        record.execution.shares = '1.0'; record.execution.price = 12; record.execution.isPriceRevisionPending = True
        self.reader.pending['executions'] = {'commandId':7, 'requestId':7}
        self.reader.executionDetailsProtoBuf(record)
        self.assertEqual(self.events[-1][1]['execution']['shares'], '1.0')
        self.assertTrue(self.events[-1][1]['execution']['pendingPriceRevision'])
        record.reqId = 8
        with self.assertRaisesRegex(ValueError, 'CORRELATION'): self.reader.executionDetailsProtoBuf(record)

    def test_actual_sdk_execution_encoding_and_config_boundaries(self):
        api = EClient(self.reader)
        api.isConnected = lambda: True
        frames = []
        api.sendMsg = lambda kind, message: frames.append((kind, message))
        api.sendMsgProtoBuf = lambda kind, message: frames.append((kind, message))
        filt = ExecutionFilter()
        filt.acctCode = 'TEST'; filt.time = '20261026-12:00:00'; filt.lastNDays = 7; filt.specificDates = [20261026]
        api.serverVersion_ = 199
        api.reqExecutions(7, filt)
        self.assertEqual(frames, [])
        api.serverVersion_ = 200
        api.reqExecutions(7, filt)
        self.assertIn('7\x001\x0020261026\x00', frames[-1][1])
        for version in (213, 214, 218, 219, 226):
            api.serverVersion_ = version
            api.reqExecutions(7, filt)
            self.assertEqual(frames[-1][0], 207)
            decoded = ExecutionRequest.FromString(frames[-1][1])
            self.assertEqual(decoded.executionFilter.lastNDays, 7)
            self.assertTrue(decoded.executionFilter.HasField('clientId'))
            self.assertEqual(decoded.executionFilter.clientId, 0)
            self.assertEqual(list(decoded.executionFilter.specificDates), [20261026])
            self.assertEqual(decoded.executionFilter.time, filt.time)
        frames.clear(); api.serverVersion_ = 218; api.reqConfigProtoBuf(ConfigRequest(reqId=8))
        self.assertEqual(frames, [])
        api.serverVersion_ = 219; api.reqConfigProtoBuf(ConfigRequest(reqId=8))
        self.assertEqual(frames[0][0], 308)
        wire = make_msg_proto(308, frames[0][1])
        self.assertEqual(int.from_bytes(wire[:4], 'big'), len(wire)-4)
        self.assertEqual(int.from_bytes(wire[4:8], 'big'), 308)

    def test_write_methods_rejected_at_wire_boundary(self):
        for kind in (3, 4, 5, 58, 203, 204, 205, 309):
            with self.assertRaisesRegex(ValueError, 'FORBIDDEN'): self.reader.sendMsg(kind, '')
            with self.assertRaisesRegex(ValueError, 'FORBIDDEN'): self.reader.sendMsgProtoBuf(kind, b'')

    def test_bad_commands_never_call_sdk(self):
        base = dict(v=1, sessionId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', generation=1, seq=1, commandId=1, requestId=1, payload={})
        with patch.object(self.reader, 'connect') as connect:
            for kind in ('placeOrder', 'updateConfig', 'eval'):
                self.reader.input_seq = 0; self.reader.last_request_id = 0
                with self.assertRaises(ValueError): self.reader.dispatch(dict(base, type=kind))
            connect.assert_not_called()


if __name__ == '__main__': unittest.main()

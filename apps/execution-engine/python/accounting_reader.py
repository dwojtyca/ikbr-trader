"""Bounded read-only protocol for the official IBKR SDK. No arbitrary dispatch."""
import json
import logging
import math
import os
import queue
import re
import sys
import threading
import time

logging.disable(logging.CRITICAL)
from ibapi.client import EClient
from ibapi.wrapper import EWrapper
from ibapi.execution import ExecutionFilter
from ibapi.protobuf.ConfigRequest_pb2 import ConfigRequest
import ibapi
import google.protobuf

SDK_SHA256 = '50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316'
MAX_INPUT = 16384
MAX_OUTPUT = 65536
MAX_QUEUE = 1048576


def required(proto, fields):
    if any(not proto.HasField(field) for field in fields):
        raise ValueError('PROTOBUF_FIELD_MISSING')
    return {field: getattr(proto, field) for field in fields}


def scalar(value):
    if isinstance(value, float) and (not math.isfinite(value) or abs(value) >= 1e100):
        return None
    return value


class Reader(EWrapper, EClient):
    def __init__(self, output=None):
        EWrapper.__init__(self)
        EClient.__init__(self, self)
        self.output = output or sys.stdout.buffer
        self.identity = None
        self.input_seq = 0
        self.output_seq = 0
        self.output_lock = threading.Lock()
        self.outbox = queue.Queue()
        self.queued_bytes = 0
        self.stopping = False
        self.pending = {}
        self.account = ''
        self.started = False
        self.last_request_id = 0
        self.writer = threading.Thread(target=self.write_loop, daemon=True)
        self.writer.start()

    def sendMsg(self, msgId, msg):
        if msgId not in (17, 71, 105): raise ValueError('WRITE_METHOD_FORBIDDEN')
        return super().sendMsg(msgId, msg)

    def sendMsgProtoBuf(self, msgId, msg):
        if msgId not in (217, 271, 305, 308, 207): raise ValueError('WRITE_METHOD_FORBIDDEN')
        return super().sendMsgProtoBuf(msgId, msg)

    def emit(self, kind, payload, correlation=None):
        if self.identity is None or self.stopping and kind != 'closing': return
        with self.output_lock:
            self.output_seq += 1
            message = dict(v=1, **self.identity, seq=self.output_seq, type=kind, payload=payload)
            if correlation is not None:
                message.update(commandId=correlation['commandId'], requestId=correlation['requestId'])
            data = (json.dumps(message, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
            if len(data) > MAX_OUTPUT or self.queued_bytes + len(data) > MAX_QUEUE:
                self.stopping = True
                self.disconnect()
                raise ValueError('OUTPUT_OVERFLOW')
            self.queued_bytes += len(data)
            self.outbox.put_nowait(data)

    def write_loop(self):
        try:
            while True:
                data = self.outbox.get()
                if data is None: return
                self.output.write(data)
                self.output.flush()
                with self.output_lock: self.queued_bytes -= len(data)
        except Exception:
            self.stopping = True
            self.disconnect()

    def finish(self, family, kind, payload):
        command = self.pending.pop(family, None)
        if command is None: raise ValueError('UNEXPECTED_CALLBACK')
        self.emit(kind, payload, command)

    def nextValidId(self, orderId):
        if self.started: return
        self.started = True
        self.finish('connect', 'connected', dict(sdkVersion=ibapi.__version__, protobufVersion=google.protobuf.__version__,
            sdkSha256=SDK_SHA256, serverVersion=self.serverVersion(), connectionTime=self.twsConnectionTime().decode('utf-8') if isinstance(self.twsConnectionTime(), bytes) else self.twsConnectionTime()))

    def managedAccounts(self, accountsList):
        if 'managedAccounts' not in self.pending: return  # unsolicited bootstrap list
        self.finish('managedAccounts', 'managedAccounts', {'accounts': [s.strip() for s in accountsList.split(',') if s.strip()]})

    def currentTimeInMillisProtoBuf(self, value):
        fields = required(value, ['currentTimeInMillis'])
        self.finish('clock', 'clock', {'milliseconds': fields['currentTimeInMillis']})

    def configResponseProtoBuf(self, value):
        required(value, ['reqId', 'api'])
        required(value.api, ['settings'])
        settings = required(value.api.settings, ['masterClientId'])
        command = self.pending.get('config')
        if command is None or value.reqId != command['requestId']: raise ValueError('CONFIG_CORRELATION')
        self.finish('config', 'config', {'masterClientId': settings['masterClientId'], 'masterClientIdPresent': True})

    def executionDetailsProtoBuf(self, value):
        required(value, ['reqId', 'contract', 'execution'])
        contract = required(value.contract, ['conId', 'symbol', 'secType', 'currency'])
        execution = required(value.execution, ['orderId', 'execId', 'time', 'acctNumber', 'exchange', 'side', 'shares', 'price'])
        for name in ('permId', 'clientId', 'orderRef'):
            if value.execution.HasField(name): execution[name] = str(getattr(value.execution, name)) if name == 'permId' else getattr(value.execution, name)
        if value.execution.HasField('isPriceRevisionPending'):
            execution['pendingPriceRevision'] = value.execution.isPriceRevisionPending
        execution['price'] = scalar(execution['price'])
        if execution['acctNumber'] != self.account: raise ValueError('ACCOUNT_MISMATCH')
        command = self.pending.get('executions')
        if value.reqId == -1:
            self.emit('execution', {'ibRequestId': -1, 'contract': contract, 'execution': execution})
        elif command is not None and value.reqId == command['requestId']:
            self.emit('execution', {'ibRequestId': value.reqId, 'contract': contract, 'execution': execution}, command)
        else: raise ValueError('EXECUTION_CORRELATION')

    def executionDetailsEndProtoBuf(self, value):
        required(value, ['reqId'])
        command = self.pending.get('executions')
        if command is None or command['requestId'] != value.reqId: raise ValueError('END_CORRELATION')
        self.finish('executions', 'executionsEnd', {})

    def commissionAndFeesReportProtoBuf(self, value):
        fields = required(value, ['execId', 'currency'])
        fields['commission'] = scalar(value.commissionAndFees) if value.HasField('commissionAndFees') else None
        fields['realizedPNL'] = scalar(value.realizedPNL) if value.HasField('realizedPNL') else None
        self.emit('commission', fields)

    def connectionClosed(self):
        self.emit('disconnected', {})
        self.stopping = True

    def error(self, reqId, errorTime, errorCode, errorString, advancedOrderRejectJson=''):
        message = str(errorString).replace(self.account, '[account]') if self.account else str(errorString)
        message = re.sub(r'\b(?:DU|U|DF|F)\d+\b', '[account]', message)
        message = re.sub(r'(?i)(token|password|secret|authorization)[=: ]+\S+', r'\1=[redacted]', message)[:512]
        command = next((c for c in self.pending.values() if c['requestId'] == reqId), None)
        self.emit('error', {'origin': 'ibkr', 'name': None, 'code': errorCode, 'message': message}, command)
        if errorCode not in (2104, 2106, 2107, 2108, 2158): self.stopping = True

    def dispatch(self, command):
        keys = {'v', 'sessionId', 'generation', 'seq', 'type', 'commandId', 'requestId', 'payload'}
        if set(command) != keys or command['v'] != 1 or type(command['seq']) is not int or command['seq'] != self.input_seq + 1:
            raise ValueError('COMMAND_INVALID')
        if not isinstance(command['sessionId'], str) or not re.fullmatch(r'[a-f0-9-]{36}', command['sessionId']) or type(command['generation']) is not int or command['generation'] <= 0:
            raise ValueError('IDENTITY_INVALID')
        identity = {k: command[k] for k in ('sessionId', 'generation')}
        if self.identity is not None and self.identity != identity: raise ValueError('GENERATION_MISMATCH')
        self.identity = identity
        self.input_seq += 1
        if type(command['requestId']) is not int or not self.last_request_id < command['requestId'] < 2147483647 or command['commandId'] != command['requestId']:
            raise ValueError('REQUEST_ID_INVALID')
        self.last_request_id = command['requestId']
        kind = command['type']
        payload = command['payload']
        if not isinstance(payload, dict) or kind not in ('connect', 'managedAccounts', 'clock', 'config', 'executions', 'close'):
            raise ValueError('COMMAND_FORBIDDEN')
        if kind == 'close':
            if payload: raise ValueError('PAYLOAD_INVALID')
            self.stopping = True
            self.disconnect()
            self.emit('closing', {}, command)
            return
        if self.stopping or kind in self.pending or len(self.pending) >= 32: raise ValueError('COMMAND_BUSY')
        if kind != 'connect' and (not self.started or self.serverVersion() < 219): raise ValueError('CAPABILITY_UNAVAILABLE')
        self.pending[kind] = {**command, 'deadline': time.monotonic() + 30}
        if kind == 'connect':
            if self.started or set(payload) != {'host', 'port', 'clientId', 'accountId'} or type(payload['clientId']) is not int or payload['clientId'] != 0 or not isinstance(payload['host'], str) or not 0 < len(payload['host']) <= 200 or type(payload['port']) is not int or not 0 < payload['port'] <= 65535 or not isinstance(payload['accountId'], str) or not 0 < len(payload['accountId']) <= 200:
                raise ValueError('CONNECT_INVALID')
            self.account = payload['accountId']
            self.connect(payload['host'], payload['port'], 0)
            threading.Thread(target=self.run_guarded, daemon=True).start()
        elif kind == 'executions':
            if set(payload) != {'acctCode', 'clientId', 'time', 'lastNDays', 'symbol', 'secType', 'exchange', 'side'} or payload['acctCode'] != self.account or type(payload['clientId']) is not int or payload['clientId'] != 0 or payload['lastNDays'] != 7 or not re.fullmatch(r'\d{8}-\d{2}:\d{2}:\d{2}', payload['time']) or any(payload[k] != '' for k in ('symbol', 'secType', 'exchange', 'side')):
                raise ValueError('FILTER_INVALID')
            filt = ExecutionFilter()
            for key, val in payload.items(): setattr(filt, key, val)
            self.reqExecutions(command['requestId'], filt)
        else:
            if payload: raise ValueError('PAYLOAD_INVALID')
            if kind == 'managedAccounts': self.reqManagedAccts()
            elif kind == 'clock': self.reqCurrentTimeInMillis()
            elif kind == 'config':
                request = ConfigRequest(reqId=command['requestId'])
                self.reqConfigProtoBuf(request)

    def failure(self, exc):
        self.emit('error', {'origin': 'bridge', 'name': type(exc).__name__, 'code': 'READER_FAILED', 'message': str(exc)[:512] if isinstance(exc, ValueError) else None})
        self.stopping = True
        self.disconnect()

    def run_guarded(self):
        try: self.run()
        except Exception as exc: self.failure(exc)

    def read_commands(self):
        try:
            while not self.stopping:
                line = sys.stdin.buffer.readline(MAX_INPUT + 1)
                if not line: break
                if len(line) > MAX_INPUT or not line.endswith(b'\n'): raise ValueError('INPUT_OVERFLOW')
                self.dispatch(json.loads(line.decode('utf-8')))
        except Exception as exc: self.failure(exc)
        finally:
            self.stopping = True
            self.disconnect()


def main():
    reader = Reader()
    threading.Thread(target=reader.read_commands, daemon=True).start()
    while not reader.stopping:
        if any(c['deadline'] < time.monotonic() for c in list(reader.pending.values())):
            reader.failure(ValueError('COMMAND_TIMEOUT'))
        time.sleep(0.02)
    reader.disconnect()
    reader.outbox.put(None)
    reader.writer.join(timeout=0.2)


if __name__ == '__main__':
    main()

"""The forwarding shim must not let a loopback URL bypass the remote-transfer approval."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shim', ROOT / 'anthropic_schema_shim.py')
shim = importlib.util.module_from_spec(spec); spec.loader.exec_module(shim)
APPROVED = 'a' * 64


class ShimApprovalTests(unittest.TestCase):
    def setUp(self):
        self.forwarded = []
        self.saved_open = shim.OPENER.open
        def fake_open(req, timeout=None):
            self.forwarded.append(req)
            raise AssertionError('must not forward in these tests')
        shim.OPENER.open = fake_open
        shim.Handler.approved = APPROVED
        self.srv = shim.ThreadedServer(('127.0.0.1', 0), shim.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_port}/v1/chat/completions'

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close(); shim.OPENER.open = self.saved_open

    def post(self, headers):
        req = urllib.request.Request(self.url, data=json.dumps({'model': 'x', 'messages': []}).encode(),
                                     headers={'Content-Type': 'application/json', **headers})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            opener.open(req, timeout=5)
        return ctx.exception.code

    def test_missing_header_rejected_before_forwarding(self):
        self.assertEqual(self.post({}), 403)
        self.assertEqual(self.forwarded, [])

    def test_wrong_hash_rejected_before_forwarding(self):
        self.assertEqual(self.post({'X-Bench-Reviewed-Packets-Sha256': 'b' * 64}), 403)
        self.assertEqual(self.forwarded, [])

    def test_matching_hash_is_approved(self):
        self.assertTrue(shim.request_is_approved({'X-Bench-Reviewed-Packets-Sha256': APPROVED}, APPROVED))
        self.assertFalse(shim.request_is_approved({'X-Bench-Reviewed-Packets-Sha256': APPROVED}, None))


if __name__ == '__main__':
    unittest.main(verbosity=2)

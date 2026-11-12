import copy
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from app import BedrockService, Server, ApiError, ASSIST_OUTPUT_TOKENS, REPORT_OUTPUT_TOKENS
from grounding import InputError, prepare_context, parse_model_output
from limits import Quotas, QuotaExceeded


def layout():
    return {'schema_version': 'robocell-layout/v1', 'name': '합성 테스트', 'factory': {'width': 24, 'depth': 18, 'height': 6},
            'target_units_per_hour': 90, 'assets': [{'id': 'robot-1', 'name': '로봇', 'type': 'robot', 'x': 5, 'y': 6,
                'rotation': 0, 'width': 1.8, 'depth': 1.8, 'height': 2.4, 'processTime': 0}]}


class FakeBedrock:
    def __init__(self):
        self.calls = []
    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return {'output': {'message': {'content': [{'text': json.dumps({'answer': '입력 면적은 432m²입니다. 실제 검증은 별도입니다.',
            'citations': [{'evidence_id': 'layout_metrics', 'field': 'floor_area_m2'}], 'unverified': ['실측 도면 미제공']}, ensure_ascii=False)}]}},
            'usage': {'inputTokens': 500, 'outputTokens': 100, 'totalTokens': 600}}


class GroundingTests(unittest.TestCase):
    def test_layout_rejects_unknown_assets_and_nonfinite(self):
        for mutate in [lambda v: v['factory'].update(width=float('nan')), lambda v: v['assets'][0].update(type='shell'), lambda v: v['factory'].update(width=True)]:
            value = layout(); mutate(value)
            with self.assertRaises(InputError):
                prepare_context({'layout': value})

    def test_secret_document_and_raw_log_fields_never_enter_prompt(self):
        raw = {'layout': layout(), 'documents': ['SECRET-DOCUMENT'], 'api_key': 'SECRET-KEY',
               'diagnostics': {'source': {'kind': 'synthetic-example'}, 'anomalies': [{'signal': 'temperature_c', 'value': 80, 'command': 'SECRET-COMMAND'}], 'raw_csv': 'SECRET-CSV'},
               'runEvidence': {'job_id': 'bad', 'log_tail': 'SECRET-LOG'}}
        facts, digest = prepare_context(raw)
        self.assertNotIn('SECRET-', json.dumps(facts))
        self.assertEqual(len(digest), 64)
        self.assertEqual(next(f['data'] for f in facts if f['id'] == 'diagnostics')['anomalies'][0]['value'], 80)

    def test_changed_layout_and_wrong_run_id_exclude_counters(self):
        value = layout()
        run = {'job_id': 'run-123', 'request_snapshot': {'job_id': 'run-123', 'layout': copy.deepcopy(value)},
               'current_observation': {'job_id': 'run-123', 'run_id': 'run-123', 'good': 12}}
        def result():
            return next(f['data'] for f in prepare_context({'layout': value, 'runEvidence': run})[0] if f['id'] == 'run_evidence')
        self.assertTrue(result()['included'])
        value['assets'][0]['x'] += 1
        self.assertFalse(result()['included']); self.assertNotIn('metrics', result())
        value['assets'][0]['x'] -= 1; run['current_observation']['run_id'] = 'other-job'
        self.assertFalse(result()['included'])

    def test_stale_or_missing_input_confirmation_is_not_forwarded_as_confirmed(self):
        value = layout()
        for key in [None, '{}', '{broken', json.dumps({'width': 48, 'depth': 18, 'height': 6})]:
            facts, _ = prepare_context({'layout': value, 'projectEvidence': {'fields': {'dimensions': {'status': 'confirmed', 'source': 'userprovided', 'valueKey': key}}}})
            data = next(f['data'] for f in facts if f['id'] == 'input_evidence')
            self.assertEqual(data['dimensions']['status'], 'unverified')

    def test_hallucinated_citations_are_removed(self):
        facts, _ = prepare_context({'layout': layout()})
        result = parse_model_output(json.dumps({'answer': '검토 제안', 'citations': [{'evidence_id': 'madeup', 'field': 'x'},
            {'evidence_id': 'layout', 'field': 'password'}, {'evidence_id': 'layout', 'field': 'factory.width'}], 'unverified': []}), facts)
        self.assertEqual(result['citations'], [{'evidence_id': 'layout', 'field': 'factory.width'}])
        self.assertTrue(any('인용' in item for item in result['unverified']))

    def test_diagnostic_event_cap_is_explicit_and_malformed_nested_records_do_not_crash(self):
        facts, _ = prepare_context({'layout': layout(), 'projectEvidence': {'fields': {'materialFlow': 'invalid'}},
            'diagnostics': {'anomalies': [{'value': 80}] * 80}})
        data = next(f['data'] for f in facts if f['id'] == 'diagnostics')
        self.assertEqual(len(data['anomalies']), 40)
        self.assertEqual(data['context_limits']['anomalies_provided'], 80)

    def test_diagnostic_equipment_aggregates_association_and_two_stage_omissions_survive(self):
        equipment = [{'equipment_id': f'cnc-{i}', 'samples': 120, 'baselineReady': True,
                      'baselines': {'temperature_c': 43.5},
                      'signals': {'temperature_c': {'min': 41.7, 'max': 82.7, 'latest': 82.7, 'events': 42}}} for i in range(4)]
        raw = {'source': {'kind': 'synthetic-example', 'measurementStatus': 'synthetic'}, 'equipment': equipment,
               'summary': {'eventCount': 173, 'storedEventCount': 173}, 'contextEventCount': 80, 'contextEventsOmitted': 93,
               'layoutAssociation': {'kind': 'id-match-only-unverified', 'matchedIds': ['cnc-1']},
               'selectedMode': 'sensor', 'contextNote': 'Limited context, no raw CSV',
               'anomalies': [{'id': f'event-{i}', 'equipment_id': f'cnc-{i%4}', 'signal': 'temperature_c', 'value': 80 + i} for i in range(80)],
               'rows': [{'temperature_c': 12345}], 'samples': [{'raw_csv': 'PRIVATE'}]}
        facts, _ = prepare_context({'layout': layout(), 'diagnostics': raw})
        data = next(f['data'] for f in facts if f['id'] == 'diagnostics')
        self.assertEqual(data['equipment'], equipment)
        self.assertEqual(data['layoutAssociation'], raw['layoutAssociation'])
        self.assertEqual(data['source']['kind'], 'synthetic-example')
        self.assertEqual(data['context_limits']['anomalies_total_reported'], 173)
        self.assertEqual(data['context_limits']['anomalies_omitted_before_request'], 93)
        self.assertEqual(data['context_limits']['anomalies_omitted_by_backend'], 40)
        self.assertEqual(data['context_limits']['anomalies_omitted_total'], 133)
        self.assertEqual(data['anomalies'][0]['id'], 'event-0')
        self.assertEqual(data['anomalies'][-1]['id'], 'event-79')
        self.assertNotIn('rows', data); self.assertNotIn('samples', data)

    def test_diagnostic_names_require_exact_current_layout_id_match(self):
        raw = {'equipment': [{'equipment_id': 'robot-1', 'display_name': 'invented machine'},
                             {'equipment_id': 'robot-10', 'display_name': 'wrong similar ID'}],
               'anomalies': [{'equipment_id': 'robot-1', 'signal': 'current_a', 'value': 12, 'display_name': 'wrong'}]}
        facts, _ = prepare_context({'layout': layout(), 'diagnostics': raw})
        data = next(f['data'] for f in facts if f['id'] == 'diagnostics')
        self.assertEqual(data['equipment'][0]['display_name'], '로봇')
        self.assertEqual(data['anomalies'][0]['display_name'], '로봇')
        self.assertEqual(data['equipment'][0]['display_name_source'], 'layout-id-match-only-not-physical-attribution')
        self.assertNotIn('display_name', data['equipment'][1])
        self.assertNotIn('invented', json.dumps(data))


class QuotaTests(unittest.TestCase):
    def test_global_quota_survives_restart_and_rate_is_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'quota.db'
            quotas = Quotas(file, global_calls=2, per_minute=1)
            reservation = quotas.reserve('one', 1000, 1000)
            with self.assertRaises(QuotaExceeded): quotas.reserve('one', 1000, 1001)
            quotas.settle(reservation, 100)
            restarted = Quotas(file, global_calls=2, per_minute=1)
            restarted.reserve('two', 100, 1002)
            with self.assertRaises(QuotaExceeded): restarted.reserve('three', 100, 1003)

    def test_token_reservation_blocks_overspend_and_settle_releases_difference(self):
        with tempfile.TemporaryDirectory() as directory:
            quotas = Quotas(Path(directory) / 'quota.db', global_tokens=1000)
            key = quotas.reserve('one', 800)
            with self.assertRaises(QuotaExceeded): quotas.reserve('two', 300)
            quotas.settle(key, 100)
            quotas.reserve('two', 300)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.fake = FakeBedrock()
        self.ai = BedrockService(self.directory.name, enabled=True, client=self.fake)
        self.server = Server(('127.0.0.1', 0), self.ai, self.directory.name, ['http://studio.test'])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.directory.cleanup()
    def request(self, path, payload=None, origin='http://studio.test', host='studio.test'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Host': host}
        if payload is not None: headers.update({'Origin': origin, 'Content-Type': 'application/json'})
        conn.request('POST' if payload is not None else 'GET', path, json.dumps(payload).encode() if payload is not None else None, headers)
        response = conn.getresponse(); body = json.loads(response.read()); conn.close()
        return response.status, body
    def test_status_does_not_claim_checked_before_a_real_call(self):
        status, data = self.request('/api/ai/status')
        self.assertEqual(status, 200); self.assertTrue(data['configured']); self.assertFalse(data['model_checked']); self.assertFalse(data['available'])
        status, data = self.request('/api/ai/assist', {'question': '면적?', 'context': {'layout': layout()}})
        self.assertEqual(status, 200); self.assertEqual(data['mode'], 'llm'); self.assertEqual(data['usage']['totalTokens'], 600)
        self.assertTrue(self.request('/api/ai/status')[1]['available'])
        self.assertEqual(len(self.fake.calls), 1)
    def test_cross_origin_unknown_host_and_gpu_post_never_invoke(self):
        request = {'question': 'test', 'context': {'layout': layout()}}
        self.assertEqual(self.request('/api/ai/assist', request, origin='https://evil.test')[0], 403)
        self.assertEqual(self.request('/api/ai/assist', request, host='evil.test')[0], 400)
        self.assertEqual(self.request('/isaac/api/control', request)[0], 404)
        self.assertEqual(self.request('/isaac/connection')[0], 503)
        self.assertEqual(len(self.fake.calls), 0)
    def test_incomplete_model_output_is_explicit_and_output_limits_match_status(self):
        original = self.fake.converse
        def truncated(**kwargs):
            response = original(**kwargs)
            response['stopReason'] = 'max_tokens'
            response['output']['message']['content'] = [{'text': '{"answer":"incomplete'}]
            return response
        self.fake.converse = truncated
        status, data = self.request('/api/ai/assist', {'question': '우선 확인?', 'context': {'layout': layout()}})
        self.assertEqual(status, 502)
        self.assertEqual(data['error']['code'], 'model_output_truncated')
        self.assertNotIn('answer', data)
        self.assertEqual(self.fake.calls[-1]['inferenceConfig']['maxTokens'], ASSIST_OUTPUT_TOKENS)
        self.fake.converse = original
        self.assertEqual(self.request('/api/ai/report', {'context': {'layout': layout()}})[0], 200)
        self.assertEqual(self.fake.calls[-1]['inferenceConfig']['maxTokens'], REPORT_OUTPUT_TOKENS)
        limits = self.request('/api/ai/status')[1]['limits']
        self.assertEqual(limits['assist_output_tokens'], ASSIST_OUTPUT_TOKENS)
        self.assertEqual(limits['report_output_tokens'], REPORT_OUTPUT_TOKENS)
    def test_disabled_model_and_invalid_request_do_not_fake_answers(self):
        self.ai.enabled = False
        status, data = self.request('/api/ai/report', {'context': {'layout': layout()}})
        self.assertEqual(status, 503); self.assertNotIn('answer', data)
        self.assertEqual(self.request('/api/ai/assist', {'question': 'test', 'context': {}})[0], 400)
        self.assertEqual(len(self.fake.calls), 0)
    def test_static_traversal_and_hidden_files_are_denied(self):
        self.assertEqual(self.request('/../app.py')[0], 404)
        self.assertEqual(self.request('/.env')[0], 404)


if __name__ == '__main__':
    unittest.main()

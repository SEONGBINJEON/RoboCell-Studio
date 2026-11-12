"""Bounded facts sent to the model. No document, shell, network or GPU tools."""
import hashlib
import json
import math
import re

ASSET_TYPES = {'robot-cell', 'robot', 'cnc', 'conveyor', 'inspection', 'buffer', 'worker-zone', 'walkway'}
ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
RUN_ID = re.compile(r'^[A-Za-z0-9_-]{3,64}$')


class InputError(ValueError):
    pass


def text(value, limit=500):
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', value).strip()[:limit] if isinstance(value, str) else ''


def number(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise InputError(f'{name} 입력 범위를 확인하세요.')
    return value


def normalize_layout(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('factory'), dict) or not isinstance(raw.get('assets'), list):
        raise InputError('공장 치수와 설비 목록을 포함한 배치가 필요합니다.')
    if raw.get('schema_version', 'robocell-layout/v1') != 'robocell-layout/v1' or len(raw['assets']) > 100:
        raise InputError('배치 버전 또는 설비 수를 확인하세요.')
    factory = {key: number(raw['factory'].get(key), key, lo, hi) for key, lo, hi in [('width', 4, 200), ('depth', 4, 200), ('height', 2, 30)]}
    assets, ids = [], set()
    for item in raw['assets']:
        if not isinstance(item, dict) or item.get('type') not in ASSET_TYPES or not isinstance(item.get('id'), str) or not ID.fullmatch(item['id']) or item['id'] in ids:
            raise InputError('설비 종류 또는 식별자가 올바르지 않습니다.')
        ids.add(item['id'])
        asset = {'id': item['id'], 'type': item['type'], 'name': text(item.get('name'), 80)}
        for key, lo, hi in [('x', -500, 500), ('y', -500, 500), ('width', .1, 200), ('depth', .1, 200), ('height', .01, 30), ('processTime', 0, 86400)]:
            asset[key] = number(item.get(key, 0 if key == 'processTime' else None), key, lo, hi)
        asset['rotation'] = number(item.get('rotation', 0), 'rotation', -36000, 36000) % 360
        assets.append(asset)
    return {'schema_version': 'robocell-layout/v1', 'name': text(raw.get('name'), 80), 'factory': factory,
            'target_units_per_hour': number(raw.get('target_units_per_hour', 90), 'production target', 1, 100000), 'assets': sorted(assets, key=lambda a: a['id'])}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


DIAGNOSTIC_KEYS = set('schema_version source type kind mode name label id equipmentId equipment_id assetId asset_id metric metricId field value unit severity status message description reason expected threshold thresholds min max lower upper warning critical limit observedAt observed_at timestamp time sampleCount count missing invalid duplicates gaps anomalies dataQuality missingEvidence summary metrics baseline current delta ratio reference origin filename synthetic isSynthetic datasetId datasetName sensor sensor_id samples duration duration_s window window_s state code warnings notes unverified recommendedAction recommendation rows validRows invalidRows sourceLabel processTime temperature vibration current_a temperature_c vibration_mm_s rpm evidence_id'.split())
DIAGNOSTIC_KEYS.update('method sha256 measurementStatus cycle_s baseline_percent baseline_samples thresholdSource rowCount equipmentCount start end timeOrdered equipmentWithEvents eventCount highDeviationCount affectedSampleCount eventsTruncated signal signalLabel baselineValue changePercent level rules jobId identityMatches layoutMatches counters timeSemantics note good ng wip ik_timeouts grasp_fail part_lost parts_lost capture_error'.split())
DIAGNOSTIC_KEYS.update('equipment baselineReady baselines signals latest events layoutAssociation matchedIds contextEventCount contextEventsOmitted contextNote selectedMode storedEventCount droppedRows timestampZone generator at'.split())
DIAGNOSTIC_KEYS.discard('rows')


def bounded_diagnostics(value, depth=0):
    if depth > 7:
        return None
    if isinstance(value, dict):
        return {key: bounded_diagnostics(item, depth + 1) for key, item in list(value.items())[:80]
                if key in DIAGNOSTIC_KEYS and not (key == 'samples' and isinstance(item, (list, dict)))}
    if isinstance(value, list):
        return [bounded_diagnostics(item, depth + 1) for item in value[:40]]
    if isinstance(value, str):
        return text(value, 500)
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    return None


def run_facts(raw, layout):
    result = {'included': False, 'verification': 'client_provided_not_independently_fetched', 'validation': 'not_assessed'}
    if not isinstance(raw, dict):
        result['reason'] = '실행 근거 미제공'
        return result
    job = raw.get('job_id')
    receipt = raw.get('request_snapshot')
    if not isinstance(job, str) or not RUN_ID.fullmatch(job) or not isinstance(receipt, dict) or receipt.get('job_id') != job:
        result['reason'] = '작업 번호와 요청 사본의 일치를 확인할 수 없음'
        return result
    try:
        matches = normalize_layout(receipt.get('layout')) == layout
    except InputError:
        matches = False
    if not matches:
        result.update(job_id=job, reason='현재 배치와 실행 요청 당시 배치가 다름')
        return result
    observation, detail = raw.get('current_observation'), raw.get('job_detail')
    if isinstance(observation, dict):
        if observation.get('job_id') != job or observation.get('run_id', job) != job:
            result.update(job_id=job, reason='실시간 관측의 작업 번호가 다름')
            return result
    if isinstance(detail, dict):
        live = detail.get('live_status') if isinstance(detail.get('live_status'), dict) else {}
        if detail.get('job_id') != job or live.get('job_id', job) != job or live.get('run_id', job) != job:
            result.update(job_id=job, reason='실행 상세의 작업 번호가 다름')
            return result
    if isinstance(observation, dict):
        sample = observation
    elif isinstance(detail, dict):
        sample = detail.get('live_status') if isinstance(detail.get('live_status'), dict) and detail['live_status'] else detail
    else:
        result.update(job_id=job, reason='일치하는 관측값 미제공')
        return result
    result.update(included=True, job_id=job, state=text(sample.get('state') or (detail or {}).get('state'), 40),
                  observed_at=text(raw.get('observed_at') or raw.get('exported_at'), 50), metrics={})
    for key in ['sim_t', 'good', 'ng', 'wip', 'ik_timeouts', 'grasp_fail', 'grasp_ok', 'part_lost', 'parts_lost']:
        value = sample.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            result['metrics'][key] = value
    if sample.get('capture_error'):
        result['capture_error'] = text(sample.get('capture_error'), 300)
    return result


def prepare_context(raw):
    if not isinstance(raw, dict):
        raise InputError('분석할 배치 정보가 필요합니다.')
    layout = normalize_layout(raw.get('layout'))
    equipment = [a for a in layout['assets'] if a['type'] not in {'walkway', 'worker-zone'}]
    facts = [
        {'id': 'layout', 'kind': 'user_planning_input', 'data': layout},
        {'id': 'layout_metrics', 'kind': 'server_calculated_from_input', 'data': {
            'floor_area_m2': layout['factory']['width'] * layout['factory']['depth'], 'equipment_count': len(equipment),
            'zone_count': len(layout['assets']) - len(equipment), 'footprint_area_sum_m2': sum(a['width'] * a['depth'] for a in equipment),
            'note': '면적 합은 겹침을 제거하지 않음. 생산성·가동률·안전 검증 아님.'}},
        {'id': 'run_evidence', 'kind': 'client_provided_execution_record', 'data': run_facts(raw.get('runEvidence'), layout)},
    ]
    evidence = raw.get('projectEvidence')
    if isinstance(evidence, dict) and isinstance(evidence.get('fields'), dict):
        fields = {}
        material_flow = evidence['fields'].get('materialFlow')
        expected = {
            'dimensions': layout['factory'],
            'equipment': [{key: a[key] for key in ['id', 'type', 'name', 'width', 'depth', 'height']} for a in layout['assets']],
            'placement': [{key: a[key] for key in ['id', 'x', 'y', 'rotation', 'width', 'depth']} for a in layout['assets']],
            'processTimes': [{key: a[key] for key in ['id', 'processTime']} for a in equipment],
            'productionTarget': layout['target_units_per_hour'],
            'materialFlow': {'sequence': text(material_flow.get('value') if isinstance(material_flow, dict) else '', 2000), 'assets': [a['id'] for a in layout['assets']]},
        }
        for key in ['dimensions', 'equipment', 'placement', 'processTimes', 'productionTarget', 'materialFlow']:
            item = evidence['fields'].get(key)
            if not isinstance(item, dict):
                continue
            source = item.get('source') if item.get('source') in {'example', 'assumption', 'userprovided'} else 'assumption'
            try:
                matching_key = isinstance(item.get('valueKey'), str) and len(item['valueKey']) <= 100_000 and json.loads(item['valueKey']) == expected[key]
            except (ValueError, TypeError):
                matching_key = False
            fields[key] = {'source': source, 'status': 'user_claimed_confirmation' if item.get('status') == 'confirmed' and source == 'userprovided' and matching_key else 'unverified',
                           'reference': text(item.get('reference'), 300)}
            if key == 'materialFlow':
                fields[key]['sequence'] = text(item.get('value'), 1000)
        facts.append({'id': 'input_evidence', 'kind': 'user_attestation_not_independent_validation', 'data': fields})
    if isinstance(raw.get('planningReview'), dict):
        review = raw['planningReview']
        radius = review.get('radius')
        facts.append({'id': 'planning_review', 'kind': 'client_provided_planar_reference_only', 'data': {
            'status': 'not_assessed', 'radius_m': radius if isinstance(radius, (int, float)) and not isinstance(radius, bool) and math.isfinite(radius) and .1 <= radius <= 20 else None,
            'source': text(review.get('source'), 40), 'issues': [text(v, 300) for v in review.get('issues', [])[:30] if isinstance(v, str)] if isinstance(review.get('issues'), list) else [],
            'note': '입력 반경의 평면 참고 검사. 실제 도달거리·동작 충돌·안전거리·펜스 인증 아님.'}})
    if isinstance(raw.get('diagnostics'), dict):
        diagnostics = bounded_diagnostics(raw['diagnostics'])
        supplied_events = raw['diagnostics'].get('anomalies')
        if isinstance(supplied_events, list):
            received = len(supplied_events)
            transmitted = min(received, 40)
            def nonnegative_count(value):
                return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
            summary = raw['diagnostics'].get('summary')
            reported_total = nonnegative_count(summary.get('eventCount')) if isinstance(summary, dict) else 0
            upstream_omitted = nonnegative_count(raw['diagnostics'].get('contextEventsOmitted'))
            total = max(received, reported_total, received + upstream_omitted)
            # Preserve the temporal span of the supplied sample, not only its
            # earliest events. Equipment aggregates still describe all rows.
            indices = [round(i * (received - 1) / (transmitted - 1)) for i in range(transmitted)] if transmitted > 1 else list(range(transmitted))
            diagnostics['anomalies'] = [bounded_diagnostics(supplied_events[index], 2) for index in indices]
            diagnostics['context_limits'] = {
                'anomalies_total_reported': total, 'anomalies_provided': received, 'anomalies_transmitted': transmitted,
                'anomalies_omitted_before_request': total - received, 'anomalies_omitted_by_backend': received - transmitted,
                'anomalies_omitted_total': total - transmitted, 'selection': 'evenly_spaced_received_events',
                'equipment_summaries_provided': len(raw['diagnostics'].get('equipment', [])) if isinstance(raw['diagnostics'].get('equipment'), list) else 0,
                'equipment_summaries_transmitted': len(diagnostics.get('equipment', [])) if isinstance(diagnostics.get('equipment'), list) else 0,
                'note': '전체 건수와 설비 집계는 사용자가 제공한 분석 결과입니다. 이벤트 상세는 제한된 표본이며 전체 상세 분석이나 실제 배치 귀속 검증으로 주장하지 마세요.',
            }
        # Names come only from this normalized layout's exact ID match. This
        # supplies a label, not proof that a sensor belongs to physical equipment.
        asset_names = {asset['id']: asset['name'] or asset['id'] for asset in layout['assets']}
        for key in ('equipment', 'anomalies'):
            records = diagnostics.get(key)
            if not isinstance(records, list):
                continue
            for record in records:
                if not isinstance(record, dict):
                    continue
                identifier = record.get('equipment_id')
                if isinstance(identifier, str) and identifier in asset_names:
                    record['display_name'] = asset_names[identifier]
                    record['display_name_source'] = 'layout-id-match-only-not-physical-attribution'
        facts.append({'id': 'diagnostics', 'kind': 'client_provided_diagnostics_source_must_be_checked', 'data': diagnostics})
    serialized = json.dumps(facts, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    if len(serialized.encode()) > 48_000:
        raise InputError('분석 정보가 너무 큽니다. 설비 또는 진단 항목을 줄여 주세요.')
    return facts, fingerprint(layout)


def citation_field_exists(data, path):
    if not isinstance(path, str) or len(path) > 160:
        return False
    if path in ('', '*'):
        return True
    value = data
    for part in path.split('.'):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return False
    return True


def parse_model_output(raw, facts):
    body = raw.strip()
    if body.startswith('```') and body.endswith('```'):
        body = body.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
    result = json.loads(body)
    if not isinstance(result, dict) or not isinstance(result.get('answer'), str) or not result['answer'].strip():
        raise ValueError('Missing model answer')
    known = {fact['id']: fact['data'] for fact in facts}
    citations, seen, dropped = [], set(), False
    for item in result.get('citations', [])[:40] if isinstance(result.get('citations'), list) else []:
        if not isinstance(item, dict):
            dropped = True
            continue
        key, field = item.get('evidence_id'), item.get('field', '')
        if key in known and citation_field_exists(known[key], field):
            identity = (key, field)
            if identity not in seen:
                citations.append({'evidence_id': key, 'field': field}); seen.add(identity)
        else:
            dropped = True
    unverified = [text(v, 500) for v in result.get('unverified', [])[:12] if isinstance(v, str)] if isinstance(result.get('unverified'), list) else []
    if dropped:
        unverified.append('모델이 제시한 일부 인용을 제공된 근거에서 확인할 수 없어 제외했습니다.')
    if not citations:
        unverified.append('유효한 근거 인용이 없어 답변의 구체적 주장을 별도로 확인해야 합니다.')
    unverified.append('AI 검토 제안이며 실제 생산성 개선, 물리 검증 또는 안전 승인을 의미하지 않습니다.')
    return {'answer': text(result['answer'], 14000), 'citations': citations, 'unverified': unverified}

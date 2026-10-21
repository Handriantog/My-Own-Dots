"""Synthetic protocol fixture; never imports speech packages or opens devices."""
import base64
import json
import os
import sys
import time

mode = sys.argv[1]
transcriptions = 0
vad_frames = 0
if len(sys.argv) > 2:
    with open(sys.argv[2], 'w') as file:
        file.write(str(os.getpid()))
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    if method == 'warm':
        result = {'ready': True}
    elif method == 'transcribe':
        if mode == 'recognition-context':
            assert request['context'] == 'Sapa, mountain views.'
        if mode == 'hang':
            time.sleep(60)
        transcriptions += 1
        if mode == 'recognition-input' and transcriptions == 1:
            print(json.dumps({'id': request['id'], 'error': 'Recognition returned an invalid segment', 'code': 'recognition_input'}), flush=True)
            continue
        if mode == 'recognition-diagnostics' and transcriptions == 1:
            print(json.dumps({'id': request['id'], 'error': 'PRIVATE', 'code': 'recognition_input',
                              'reason': 'invalid_segment_text', 'fallbackReason': 'invalid_timestamp'}), flush=True)
            continue
        text = ('save-fixture' if transcriptions == 1 else 'What did I save?') if mode == 'conversation' else 'Hello Dot'
        result = {'text': text, 'language': 'en', 'segments': [{'startMs': 0, 'endMs': 500, 'text': text}]}
        if mode == 'recognition-diagnostics':
            result['fallbackReason'] = 'invalid_timestamp'
    elif method == 'vad':
        assert len(base64.b64decode(request['pcm'], validate=True)) == 1024
        vad_frames += 1
        result = {'probability': min(vad_frames / 4, 1)}
        if mode == 'vad-negative':
            result['probability'] = -0.01
        elif mode == 'vad-overflow':
            result['probability'] = 1.01
        elif mode == 'vad-text':
            result['probability'] = '0.5'
        elif mode == 'vad-extra':
            result['extra'] = True
    elif method == 'reset':
        vad_frames = 0
        result = {'ready': mode != 'reset-invalid'}
    else:
        if mode == 'selected-voice':
            assert request['voiceId'] == 'bm_george' and request['personality'] == 'calm'
            assert set(request) == {'id', 'method', 'text', 'voiceId', 'personality'}
        if mode == 'synthesis-hang':
            time.sleep(60)
        result = {'pcm': base64.b64encode(bytes(4800)).decode()}
        if mode == 'invalid-pcm':
            result['pcm'] = 'not base64!'
    if mode == 'oversized':
        print('x' * 2100000, flush=True)
    else:
        print(json.dumps({'id': 'wrong' if mode == 'bad-id' else request['id'], 'result': result}), flush=True)

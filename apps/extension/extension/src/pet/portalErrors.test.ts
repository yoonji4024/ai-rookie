import test from 'node:test';
import assert from 'node:assert/strict';
import {CONNECTION_MESSAGE,transportError,responseError} from './portalErrors.ts';
test('raw fetch failures do not escape to the user',()=>assert.equal(transportError(new TypeError('Failed to fetch')).message,CONNECTION_MESSAGE));
test('timeout has distinct guidance',()=>assert.ok(transportError(new DOMException('timeout','TimeoutError')).message.includes('응답이 늦어')));
test('explicit cancellation preserves identity',()=>{const cancelled=new DOMException('stop','AbortError');assert.equal(transportError(cancelled),cancelled);});
for(const status of [502,503,504])test('upstream connection '+status+' is not a credential failure',()=>assert.equal(responseError(status,'raw upstream failure').message,CONNECTION_MESSAGE));
test('authentication and application messages remain unchanged',()=>{assert.equal(responseError(401,undefined).message,'다시 로그인해 주세요.');assert.equal(responseError(422,'입력값을 확인해 주세요.').message,'입력값을 확인해 주세요.');});

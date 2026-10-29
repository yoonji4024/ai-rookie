import test from 'node:test';
import assert from 'node:assert/strict';
import {MEMFLIX_LOGO_SVG as overlayLogo} from './brandLogo.ts';
import {MEMFLIX_LOGO_SVG as sharedLogo} from '../brand/logo.ts';

test('overlay logo copy matches the shared logo', () => {
  assert.equal(overlayLogo, sharedLogo);
  assert.match(overlayLogo, /^<svg [^>]*aria-label="MEMFLIX"/);
});

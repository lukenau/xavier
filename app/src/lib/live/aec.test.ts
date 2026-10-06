// The two over-the-air switches ship in their safe positions: the native,
// echo-cancelled engine, with voice processing left on.
import { LIVE_AUDIO_ENGINE, LIVE_VP_BYPASS, nativeLiveAudio } from './aec';

jest.mock('../../../modules/live-audio', () => ({ LiveAudio: null }));

test('the native engine is the default, with voice processing on', () => {
  expect(LIVE_AUDIO_ENGINE).toBe('native');
  expect(LIVE_VP_BYPASS).toBe(false);
});

test('a build without the native module falls back to the library engine', () => {
  expect(nativeLiveAudio()).toBeNull();
});

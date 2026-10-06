// The Live screen's voice settings, as the app's native route sheet.
//
// A form sheet is inset from the top by the system, so it cannot collide with
// the status bar; it carries the system grabber and swipe-to-dismiss, and the
// body scrolls inside it. Declared on the Home stack with two detents: open
// tall so the voice list is visible, drag to 0.5.
//
// The settings are read from and written to the shared store
// (src/chat/voiceSettings.ts), so the Live screen underneath sees an edit
// without a remount.
import { useEffect } from 'react';
import { VoiceSettingsBody } from '../../src/components/chat/LiveSettingsSheet';
import { SheetScreen } from '../../src/components/shell';
import { useVoiceSettings } from '../../src/chat/voiceSettings';

export default function LiveSettingsRoute() {
  const settings = useVoiceSettings((s) => s.settings);
  const update = useVoiceSettings((s) => s.update);
  const hydrate = useVoiceSettings((s) => s.hydrate);

  // Normally already hydrated by the Live page that opened this sheet; this
  // covers a deep-open (and is idempotent).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <SheetScreen title="Voice settings">
      <VoiceSettingsBody settings={settings} onChange={update} />
    </SheetScreen>
  );
}

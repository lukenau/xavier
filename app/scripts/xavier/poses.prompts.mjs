export const STYLE = [
  'Two images are attached. The FIRST is the character: Xavier, an AI agent persona who is a Dalmatian butler. The SECOND is the rendering style to match exactly.',
  'Keep only his essence: white Dalmatian head with black spots, one fully dark ear, attentive intelligent expression, black tuxedo with a bow tie. He is the identity of a premium software agent, never a cute mascot or a pet. Expression always reserved and composed: mouth closed, no grins, no cartoon surprise.',
  'Rendering: match the second image exactly: the whole figure is built from a fine dot-matrix / LED particle grid of round dots of varying size and brightness, white and warm-gold dots, a soft glow on the brightest dots and a subtle gold bokeh. Props are made of the same dots.',
  'Blueprint hint: add at most two or three very thin warm-gold construction lines or measurement ticks near the figure, sparse and elegant. Never a full frame.',
  'Composition: waist-up, three-quarter view, centred, generous empty margin on all sides, nothing cropped. Square image.',
  'Background: completely flat near-black deep teal #000d0e. No text, no captions, no logo, no border.',
].join(' ');

export const POSES = [
  {
    id: 'portrait',
    prompt: 'Composition override: head and top of the shoulders only, filling most of the frame, three-quarter view facing right, bow tie visible at the bottom. Calm, attentive, intelligent, mouth closed. This is his avatar.',
  },
  {
    id: 'bow',
    prompt: 'Pose: a polite, gracious welcome bow. He bends slightly forward at the waist, head inclined, eyes softly closed or lowered, right paw placed flat on his chest over the heart, left arm holding the X towel at his side. Warm, welcoming.',
  },
  {
    id: 'tray-empty',
    prompt: 'Pose: holding an empty round polished silver serving tray in one paw at shoulder height, tilted slightly so it is visibly empty, other paw open palm-up in a small apologetic shrug, brows raised, composed neutral expression, mouth closed. "Nothing here yet."',
  },
  {
    id: 'tray-offer',
    prompt: 'Pose: presenting a round polished silver tray forward toward the viewer with both paws, on it a single folded cream envelope sealed with a red-gold wax seal stamped with an "X". Calm, attentive expression, mouth closed, slight forward lean. The X towel still draped on his forearm.',
  },
  {
    id: 'sniffing',
    prompt: 'Pose: searching. Nose lowered and pointed forward, sniffing along diligently, body leaning forward, holding a brass magnifying glass in one paw near his nose. Focused and investigative, mouth closed.',
  },
  {
    id: 'ledger',
    prompt: 'Pose: reading a small open brown leather ledger notebook held in one paw, writing in it with a slim gold fountain pen in the other, head bowed toward the page, focused, thoughtful, small reading glasses optional.',
  },
  {
    id: 'ears-up',
    prompt: 'Pose: suddenly alert. Ears perked high, head up, eyes bright and attentive, one paw raised with the index digit up in a courteous "one moment, sir" gesture. Poised and attentive, mouth closed.',
  },
  {
    id: 'tilt',
    prompt: 'Pose: the classic confused dog head tilt. Head tilted strongly to one side, one ear flopped, eyebrows quizzical, paws clasped politely in front of him. Quietly puzzled, mouth closed.',
  },
  {
    id: 'oops',
    prompt: 'Pose: startled "oops" moment. A white porcelain teacup with gold rim is tipping off its saucer mid-fall, a small splash of tea in the air, he holds the saucer in one paw and reaches with the other to catch the cup, brows raised, composure slipping for a moment but mouth closed.',
  },
  {
    id: 'triumph',
    prompt: 'Pose: triumphant and proud. Chin raised high, eyes half-closed with satisfaction, chest out, pressing a small shiny brass hotel service bell (the round desk bell) held in his paw, with a couple of tiny motion lines showing the "ding". Quiet satisfaction, mouth closed. Task accomplished.',
  },
  {
    id: 'asleep',
    prompt: 'Pose: dozing off while sitting upright on nothing visible (seated pose, legs folded), still in full tuxedo, head drooped forward and slightly to one side, eyes gently closed, peaceful, curled a little, the X towel across his lap. No hat, no pillow, no furniture. Serene.',
  },
  {
    id: 'pyjamas',
    prompt: 'Outfit override for this pose ONLY: instead of the tuxedo he wears navy-and-cream striped silk pyjamas with a deep burgundy velvet dressing robe tied at the waist, the cream X towel still draped over his forearm. Pose: late night, sleepy, heavy-lidded eyes, mouth closed, holding a brass chamberstick candle holder with a lit candle whose warm glow lights his face.',
  },
  {
    id: 'party',
    prompt: 'Pose: celebration. A tiny gold-and-black striped cone party hat perched askew on his head, raising a champagne coupe in a toast with one paw, a few gold and cream confetti pieces floating around him, a composed, knowing look, mouth closed. Festive but dignified.',
  },
];

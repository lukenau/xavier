// The weather widget: an hourly strip and a daily range bar, the two views
// the user asked for ("don't just do weekly view but include daily too").
import TestRenderer, { act } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { parseWidget } from '../../../chat/widget';
import type { WeatherWidget as WeatherWidgetT } from '../../../chat/widget';
import { WeatherWidget } from './WeatherWidget';

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string')
    .join(' | ');
}

function boston(): WeatherWidgetT {
  return parseWidget({
    kind: 'weather',
    props: {
      place: 'Boston',
      temp: 58,
      feels_like: 53,
      hours: [
        { label: 'Now', temp: 58, condition: 'partly cloudy' },
        { label: '7PM', temp: 58, condition: 'partly cloudy', night: true },
        { label: '8PM', temp: 57, condition: 'clear', night: true },
      ],
      days: [
        { label: 'Today', low: 54, high: 63, condition: 'cloudy' },
        { label: 'Sat', low: 56, high: 60, condition: 'rain', precip: 85 },
        { label: 'Thu', low: 57, high: 70, condition: 'cloudy' },
      ],
    },
  }) as WeatherWidgetT;
}

describe('the parser', () => {
  it('reads the shapes a forecast actually arrives in', () => {
    const w = boston();
    expect(w.place).toBe('Boston');
    expect(w.temp).toBe(58);
    expect(w.hours.map((h) => h.condition)).toEqual(['partly_cloudy', 'partly_cloudy_night', 'clear_night']);
    expect(w.days[1]).toEqual({
      label: 'Sat', low: 56, high: 60, condition: 'rain', precip: 85, precip_in: null, precip_hours: [],
    });
  });

  it('keeps a precipitation-only day — the rain view carries no temperatures', () => {
    // What Xavier actually sent on 2026-09-28, and what drew as "Could not
    // draw this weather": days with a chance, inches and hours, no range.
    const w = parseWidget({
      kind: 'weather',
      props: {
        view: 'precip',
        place: 'Boston',
        days: [
          { label: 'Today', precip: 99, precip_in: 0.92, precip_hours: [35, 60, 52] },
          { label: 'Sun', precip: 77, precip_in: 0.3, precip_hours: Array.from({ length: 31 }, () => 10) },
        ],
      },
    }) as WeatherWidgetT;
    expect(w).not.toBeNull();
    expect(w.view).toBe('precip');
    expect(w.days.map((d) => [d.low, d.high, d.precip])).toEqual([
      [null, null, 99],
      [null, null, 77],
    ]);
    expect(w.days[1].precip_hours).toHaveLength(24);
  });

  it('drops a day that says nothing at all', () => {
    expect(parseWidget({ kind: 'weather', props: { days: [{ label: 'Today', condition: 'cloudy' }] } })).toBeNull();
  });

  it('takes min/max and chance under the names a model reaches for', () => {
    const w = parseWidget({
      kind: 'weather',
      props: { days: [{ day: 'Wed', min: 53, max: 64, icon: 'windy', chance: 20 }] },
    }) as WeatherWidgetT;
    expect(w.days[0]).toEqual({
      label: 'Wed', low: 53, high: 64, condition: 'wind', precip: 20, precip_in: null, precip_hours: [],
    });
  });

  it('drops a row with no usable temperature rather than drawing it at zero', () => {
    const w = parseWidget({
      kind: 'weather',
      props: { temp: 58, hours: [{ label: '9PM' }, { label: '10PM', temp: 55 }] },
    }) as WeatherWidgetT;
    expect(w.hours.map((h) => h.label)).toEqual(['10PM']);
  });

  it('is not a widget at all when it carries no weather', () => {
    expect(parseWidget({ kind: 'weather', props: { place: 'Boston' } })).toBeNull();
  });

  it('answers to `forecast` too', () => {
    const w = parseWidget({ kind: 'forecast', props: { temp: 58 } });
    expect(w && w.kind).toBe('weather');
  });

  it("parses sections, keeping each block's type, label and counts", () => {
    const w = parseWidget({
      kind: 'weather',
      props: {
        place: 'Boston',
        temp: 58,
        hours: [{ label: 'Now', temp: 58, condition: 'clear', day: 0 }],
        days: [{ label: 'Sat', low: 54, high: 63, condition: 'cloudy' }],
        sections: [
          { type: 'days', title: 'Week ahead', days: 3 },
          { type: 'hourly', title: 'Sat rain', day: 1, metric: 'precip', hours: 12 },
        ],
      },
    }) as WeatherWidgetT;
    expect(w.sections).toHaveLength(2);
    expect(w.sections[0]).toEqual({
      type: 'days', title: 'Week ahead', days: 3, hours: null, from: null, day: null, metric: 'temp', metrics: [],
    });
    expect(w.sections[1].type).toBe('hourly');
    expect(w.sections[1].metric).toBe('precip');
    expect(w.sections[1].day).toBe(1);
    expect(w.hours[0].day).toBe(0);
  });

  it('drops a section whose type it does not know, without dropping the widget', () => {
    const w = parseWidget({
      kind: 'weather',
      props: { temp: 58, sections: [{ type: 'tornado' }, { type: 'days', days: 2 }] },
    }) as WeatherWidgetT;
    expect(w.sections.map((s) => s.type)).toEqual(['days']);
  });

  it('reads a section title under the label spelling too', () => {
    const w = parseWidget({
      kind: 'weather',
      props: { temp: 58, sections: [{ type: 'precip', label: 'Rain' }] },
    }) as WeatherWidgetT;
    expect(w.sections[0].title).toBe('Rain');
  });

  it('has no sections when none were asked for', () => {
    expect(boston().sections).toEqual([]);
  });
});

describe('the widget', () => {
  it('leads with where and how warm it is', () => {
    const shown = texts(render(<WeatherWidget widget={boston()} />));
    expect(shown).toContain('Boston');
    expect(shown).toContain('58°');
    expect(shown).toContain('feels 53°');
  });

  it('draws an hour per column, with its own temperature', () => {
    const tree = render(<WeatherWidget widget={boston()} />);
    const hours = tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-hour-'),
    );
    expect(hours).toHaveLength(3);
    expect(texts(tree)).toContain('7PM');
  });

  it('gives every day a bar, and only today the dot for right now', () => {
    const tree = render(<WeatherWidget widget={boston()} />);
    const rows = tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-day-'),
    );
    expect(rows).toHaveLength(3);
    const dots = tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'weather-now-dot');
    expect(dots).toHaveLength(1);
  });

  it('shows a chance of rain only on the days that have one', () => {
    const shown = texts(render(<WeatherWidget widget={boston()} />));
    expect(shown).toContain('85%');
    expect(shown.match(/85%/g)).toHaveLength(1);
  });

  it('draws a forecast with no hourly detail as the days alone', () => {
    const w = parseWidget({
      kind: 'weather',
      props: { days: [{ label: 'Today', low: 54, high: 63, condition: 'cloudy' }] },
    }) as WeatherWidgetT;
    const tree = render(<WeatherWidget widget={w} />);
    expect(
      tree.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-hour-')),
    ).toHaveLength(0);
    expect(texts(tree)).toContain('63°');
  });

  it('colours a warm day differently from a cold one', () => {
    const tree = render(<WeatherWidget widget={boston()} />);
    const fills = (label: string) => {
      const row = tree.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === `weather-day-${label}`,
      )[0];
      return row
        .findAllByType(View)
        .map((n) => [n.props.style].flat(Infinity).find((s) => s && typeof s.backgroundColor === 'string'))
        .filter(Boolean)
        .map((s) => (s as { backgroundColor: string }).backgroundColor);
    };
    expect(fills('Sat').join()).not.toEqual(fills('Thu').join());
  });
});

describe('the precipitation view', () => {
  // the user, 2026-09-23: "build precipitation weather charts as well please not
  // just that one overall widget".
  function seattle(view: string) {
    return parseWidget({
      kind: 'weather',
      props: {
        view,
        place: 'Seattle',
        days: [
          { label: 'Thu', low: 52, high: 61, condition: 'rain', precip: 69, precip_in: 0.23,
            precip_hours: [0, 0, 10, 40, 62, 55, 20, 0] },
          { label: 'Fri', low: 50, high: 58, condition: 'rain', precip: 96, precip_in: 0.94,
            precip_hours: [30, 45, 65, 60, 55, 40, 35, 20] },
        ],
      },
    }) as WeatherWidgetT;
  }

  it('draws a row per day with its inches and its chance', () => {
    const tree = render(<WeatherWidget widget={seattle('precip')} />);
    const rows = tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-precip-'),
    );
    expect(rows).toHaveLength(2);
    const shown = texts(tree);
    expect(shown).toContain('0.94"');
    expect(shown).toContain('96%');
  });

  it('draws the temperature view unless precipitation is asked for', () => {
    const tree = render(<WeatherWidget widget={seattle('conditions')} />);
    expect(
      tree.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-precip-')),
    ).toHaveLength(0);
    expect(
      tree.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-day-')),
    ).toHaveLength(2);
  });

  it('scales every sparkline against the wettest hour in the set, not its own', () => {
    // Thursday peaks at 62 and Friday at 65: Thursday's tallest bar must be
    // shorter, or a drizzle looks like a downpour on its own row.
    const tree = render(<WeatherWidget widget={seattle('precip')} />);
    const tallest = (label: string) => {
      const row = tree.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === `weather-precip-${label}`,
      )[0];
      const heights = row
        .findAllByType(View)
        .map((n) => [n.props.style].flat(Infinity).find((s) => s && typeof s.height === 'string'))
        .filter(Boolean)
        .map((s) => parseFloat((s as { height: string }).height));
      return Math.max(...heights);
    };
    expect(tallest('Thu')).toBeLessThan(tallest('Fri'));
  });

  it('reads a dry day as dry rather than as missing', () => {
    const dry = parseWidget({
      kind: 'weather',
      props: { view: 'precip', days: [{ label: 'Wed', low: 50, high: 60, precip: 0, precip_in: 0 }] },
    }) as WeatherWidgetT;
    expect(texts(render(<WeatherWidget widget={dry} />))).toContain('0%');
  });
});

describe('single-day hourly views', () => {
  // the user, 2026-09-23: "make more single day hourly views of the different
  // weather metrics and composite ones too".
  function today(view: string, metric?: string) {
    const hours = [
      { label: 'Now', temp: 58, condition: 'clear', precip: 0, wind: 4, humidity: 70, uv: 3, night: false },
      { label: '1PM', temp: 64, condition: 'clear', precip: 10, wind: 9, humidity: 62, uv: 6, night: false },
      { label: '2PM', temp: 71, condition: 'rain', precip: 55, wind: 14, humidity: 58, uv: 5, night: false },
      { label: '9PM', temp: 55, condition: 'clear', precip: 5, wind: 6, humidity: 80, uv: 0, night: true },
    ];
    return parseWidget({ kind: 'weather', props: { view, metric, place: 'Boston', hours } }) as WeatherWidgetT;
  }

  const metricCards = (tree: TestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-metric-'),
    );

  it('draws the measure it was asked for, hour by hour', () => {
    const tree = render(<WeatherWidget widget={today('hourly', 'wind')} />);
    expect(metricCards(tree)).toHaveLength(1);
    const shown = texts(tree);
    expect(shown).toContain('Wind');
    expect(shown).toContain('4 mph');
    expect(shown).toContain('peak 14 mph at 2PM');
  });

  it('answers to the names a forecast uses for a measure', () => {
    expect(today('hourly', 'uv_index').metric).toBe('uv');
    expect(today('hourly', 'chance of rain').metric).toBe('precip');
    expect(today('hourly', 'nonsense').metric).toBe('temp');
  });

  it('stacks one card per measure in the composite', () => {
    const tree = render(<WeatherWidget widget={today('composite')} />);
    expect(metricCards(tree).length).toBeGreaterThan(1);
    const shown = texts(tree);
    expect(shown).toContain('Temperature');
    expect(shown).toContain('Chance of rain');
  });

  it('leaves out a measure the forecast never carried', () => {
    const bare = parseWidget({
      kind: 'weather',
      props: { view: 'composite', hours: [{ label: 'Now', temp: 58, condition: 'clear' }] },
    }) as WeatherWidgetT;
    const shown = texts(render(<WeatherWidget widget={bare} />));
    expect(shown).toContain('Temperature');
    expect(shown).not.toContain('Humidity');
  });

  it('shows rain by the hour in the rain view, not temperature', () => {
    // "make sure the precip views actually show precip metric hourly too and
    // not just temp" (2026-09-23).
    const tree = render(<WeatherWidget widget={today('precip')} />);
    expect(metricCards(tree).map((n) => n.props.testID)).toEqual(['weather-metric-precip']);
    expect(
      tree.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-hour-')),
    ).toHaveLength(0);
  });

  it('keeps the temperature strip on the conditions view', () => {
    const tree = render(<WeatherWidget widget={today('conditions')} />);
    expect(metricCards(tree)).toHaveLength(0);
    expect(
      tree.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-hour-')),
    ).toHaveLength(4);
  });

  it('draws the rain view from days that carry no temperatures', () => {
    const rain = parseWidget({
      kind: 'weather',
      props: {
        view: 'precip',
        place: 'Boston',
        days: [{ label: 'Today', precip: 99, precip_in: 0.92, precip_hours: [35, 60, 52] }],
      },
    }) as WeatherWidgetT;
    const tree = render(<WeatherWidget widget={rain} />);
    expect(tree.root.findAll((n) => n.props.testID === 'weather-precip-Today')).not.toHaveLength(0);
    expect(texts(tree)).toContain('99%');
  });

  it('draws a conditions row without a range as label and rain only', () => {
    const mixed = parseWidget({
      kind: 'weather',
      props: {
        days: [
          { label: 'Today', low: 54, high: 63, condition: 'cloudy' },
          { label: 'Sat', precip: 85, condition: 'rain' },
        ],
      },
    }) as WeatherWidgetT;
    const shown = texts(render(<WeatherWidget widget={mixed} />));
    expect(shown).toContain('54°');
    expect(shown).toContain('85%');
  });
});

describe('composed sections', () => {
  // the user, 2026-10-02: "different combinations and customizations for days and
  // hour counts and labels and hourly views for each day and so on".
  const composed = () =>
    parseWidget({
      kind: 'weather',
      props: {
        place: 'Boston',
        temp: 58,
        days: [
          { label: 'Today', low: 54, high: 63, condition: 'cloudy' },
          { label: 'Sat', low: 56, high: 60, condition: 'rain', precip: 85 },
          { label: 'Sun', low: 50, high: 58, condition: 'cloudy' },
        ],
        hours: [
          { label: 'Now', temp: 58, condition: 'clear', day: 0, precip: 0 },
          { label: '1PM', temp: 64, condition: 'clear', day: 0, precip: 10, wind: 9 },
          { label: 'Now', temp: 60, condition: 'rain', day: 1, precip: 40 },
          { label: '1PM', temp: 66, condition: 'rain', day: 1, precip: 60, wind: 12 },
        ],
        sections: [
          { type: 'days', title: 'Week ahead', days: 2 },
          { type: 'hourly', title: 'Sat rain', day: 1, metric: 'precip', hours: 2 },
        ],
      },
    }) as WeatherWidgetT;

  const blocks = (tree: TestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-section-'),
    );

  it('draws one block per section, with its title', () => {
    const tree = render(<WeatherWidget widget={composed()} />);
    expect(blocks(tree)).toHaveLength(2);
    const shown = texts(tree);
    expect(shown).toContain('Week ahead');
    expect(shown).toContain('Sat rain');
  });

  it('caps the day list to the section count', () => {
    const tree = render(<WeatherWidget widget={composed()} />);
    const rows = tree.root.findAll(
      (n) => typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('weather-day-'),
    );
    expect(rows).toHaveLength(2);
  });

  it("draws a section's hourly view from that day's hours only", () => {
    const tree = render(<WeatherWidget widget={composed()} />);
    const metrics = tree.root.findAll(
      (n) => typeof n.type === 'string' && n.props.testID === 'weather-metric-precip',
    );
    expect(metrics).toHaveLength(1);
  });

  it('falls back to the single view when no sections are given', () => {
    const tree = render(<WeatherWidget widget={boston()} />);
    expect(blocks(tree)).toHaveLength(0);
  });
});

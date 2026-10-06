// The two slices a composed weather section asks for: one day's hours, and a
// count of days. Kept out of the renderer so "which hours does this block
// draw" is testable without rendering anything.
import { selectDays, selectHours } from './weatherMetrics';
import type { WeatherDay, WeatherHour } from './widget';

const hour = (label: string, day: number | null): WeatherHour => ({
  label, temp: 60, condition: 'clear', precip: 0, night: false,
  feels_like: null, wind: null, humidity: null, uv: null, cloud: null, day,
});

const day = (label: string): WeatherDay => ({
  label, low: 50, high: 60, condition: 'cloudy', precip: 0, precip_in: null, precip_hours: [],
});

describe('selectHours', () => {
  const hours = [hour('12AM', 0), hour('1AM', 0), hour('12AM', 1), hour('1AM', 1)];

  it('restricts to one day when asked', () => {
    expect(selectHours(hours, { day: 1 }).map((h) => h.label)).toEqual(['12AM', '1AM']);
  });

  it('takes a count and an offset', () => {
    expect(selectHours(hours, { from: 1, count: 2 }).map((h) => h.label)).toEqual(['1AM', '12AM']);
  });

  it('returns everything when nothing is constrained', () => {
    expect(selectHours(hours, {})).toHaveLength(4);
  });
});

describe('selectDays', () => {
  const days = [day('Today'), day('Sat'), day('Sun')];

  it('caps to a count', () => {
    expect(selectDays(days, 2).map((d) => d.label)).toEqual(['Today', 'Sat']);
  });

  it('returns everything for a null count', () => {
    expect(selectDays(days, null)).toHaveLength(3);
  });
});
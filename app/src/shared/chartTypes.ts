// BarSeries/BarBucket live in the PWA's StackedBars component; the shared
// colour helpers only need the shapes, so they are declared here and the
// chart component (Task 15) imports them from this module.
export interface BarSeries {
  id: string;
  label: string;
  color: string;
}

export interface BarBucket {
  key: string;
  values: Record<string, number>;
}

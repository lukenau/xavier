const expoPreset = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.ts?(x)'],
  // Jest's 5s default is a cold-cache trap here: the heavier render suites
  // (money, cost, feed, terminal) transform a lot on first run and cascade
  // into dozens of timeout "failures" that look like real defects and have
  // repeatedly cost agents a diagnosis detour. Warm, these finish in
  // milliseconds; the ceiling only ever fires on a cold babel cache.
  testTimeout: 20000,
  // Jest defaults to one worker per core (cpus-1). This suite is run on a
  // 6-core box that also runs other agents' work, and at that parallelism the
  // machine goes into swap — where the tests' own wall-clock settle deadlines
  // (3-5s) expire, tests are killed by testTimeout while their async bodies
  // keep running, and whole files collapse into cascades. Half the cores is
  // the ceiling that keeps the run inside the machine it is actually on.
  maxWorkers: '50%',
  // Recycle a worker whose heap grows past this between test files rather than
  // letting one worker's retained memory push the box into swap.
  workerIdleMemoryLimit: '512MB',
  // setupFiles replaces rather than merges with the preset's, so the preset's
  // own entries are re-listed ahead of our own setup.
  setupFiles: [
    ...expoPreset.setupFiles,
    '<rootDir>/jest.setup.js',
  ],
  // Same for the after-env hooks: the preset ships none, but keep the merge
  // symmetric so a future preset entry isn't silently dropped.
  setupFilesAfterEnv: [
    ...(expoPreset.setupFilesAfterEnv ?? []),
    '<rootDir>/jest.teardown.js',
  ],
};

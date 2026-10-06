import {
  breadcrumbSegments,
  filePreviewErrorCopy,
  formatMtime,
  formatSize,
  joinPath,
  parentPath,
} from './filesPath';

describe('joinPath', () => {
  test('joins onto an empty path with no leading slash', () => {
    expect(joinPath('', 'skills')).toBe('skills');
  });
  test('joins onto a non-empty path with a slash', () => {
    expect(joinPath('skills', 'devops')).toBe('skills/devops');
  });
});

describe('parentPath', () => {
  test('a root-level path has no parent', () => {
    expect(parentPath('skills')).toBe('');
  });
  test('a nested path drops its last segment', () => {
    expect(parentPath('skills/devops/README.md')).toBe('skills/devops');
  });
});

describe('formatSize', () => {
  test('null is blank', () => {
    expect(formatSize(null)).toBe('');
  });
  test('bytes under 1 KB', () => {
    expect(formatSize(512)).toBe('512 B');
  });
  test('KB range, one decimal', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });
  test('MB range, one decimal', () => {
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatMtime', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  test('null/0 is blank', () => {
    expect(formatMtime(null, now)).toBe('');
    expect(formatMtime(0, now)).toBe('');
  });
  test('seconds', () => {
    expect(formatMtime(now / 1000 - 30, now)).toBe('30s ago');
  });
  test('minutes, rounded not floored', () => {
    expect(formatMtime(now / 1000 - 330, now)).toBe('6m ago'); // 5.5m rounds up
  });
  test('hours', () => {
    expect(formatMtime(now / 1000 - 7200, now)).toBe('2h ago');
  });
  test('days', () => {
    expect(formatMtime(now / 1000 - 172800, now)).toBe('2d ago');
  });
});

describe('breadcrumbSegments', () => {
  test('the root has no segments', () => {
    expect(breadcrumbSegments('')).toEqual([]);
  });
  test('one segment', () => {
    expect(breadcrumbSegments('skills')).toEqual([{ path: 'skills', label: 'skills', isLast: true }]);
  });
  test('nested path builds cumulative paths and marks only the last', () => {
    expect(breadcrumbSegments('skills/devops/README.md')).toEqual([
      { path: 'skills', label: 'skills', isLast: false },
      { path: 'skills/devops', label: 'devops', isLast: false },
      { path: 'skills/devops/README.md', label: 'README.md', isLast: true },
    ]);
  });
});

describe('filePreviewErrorCopy', () => {
  test('passes the raw server message through unchanged — the 413/415 branch is unreachable', () => {
    // docs/inventory/terminal.md §7.3 open question: the server's real detail
    // strings never contain the digits '413'/'415', so this is what the PWA
    // actually shows today, bug-for-bug.
    expect(filePreviewErrorCopy('binary file — preview unsupported')).toBe(
      'binary file — preview unsupported',
    );
    expect(filePreviewErrorCopy('file larger than 262144 bytes')).toBe(
      'file larger than 262144 bytes',
    );
  });
  test('a message that DOES contain the substring 415 or 413 hits the friendly copy', () => {
    expect(filePreviewErrorCopy('GET /files/read → 415')).toBe('Binary file — preview unsupported');
    expect(filePreviewErrorCopy('GET /files/read → 413')).toBe('File too large to preview (>256 KB)');
  });
});

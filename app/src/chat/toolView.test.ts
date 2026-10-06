import { argSections, errorSection, resultSections, toolSummary } from './toolView';

describe('toolSummary — the collapsed one-liner', () => {
  it('shows the command, not the JSON wrapper', () => {
    expect(toolSummary('{"command": "date -u"}')).toBe('date -u');
    expect(toolSummary({ command: 'uname -r' })).toBe('uname -r');
  });
  it('falls back through the other primary arguments', () => {
    expect(toolSummary('{"path": "/tmp/x.json"}')).toBe('/tmp/x.json');
    expect(toolSummary('{"query": "alpaca rename"}')).toBe('alpaca rename');
    expect(toolSummary('{"whatever": "still shown"}')).toBe('still shown');
  });
  it('shows a plain string as itself', () => {
    expect(toolSummary('just text')).toBe('just text');
  });
});

describe('argSections', () => {
  it('names the command and keeps it unescaped', () => {
    expect(argSections('{"command": "echo \\"hi\\""}')).toEqual([{ label: 'Command', text: 'echo "hi"' }]);
  });
  it('splits the command from the rest', () => {
    expect(argSections({ command: 'ls', cwd: '/tmp' })).toEqual([
      { label: 'Command', text: 'ls' },
      { label: 'Arguments', text: '{\n  "cwd": "/tmp"\n}' },
    ]);
  });
  it('shows an unparseable payload as it arrived rather than dropping it', () => {
    expect(argSections('{not json')).toEqual([{ label: 'Arguments', text: '{not json' }]);
  });
  it('is empty for nothing', () => {
    expect(argSections(undefined)).toEqual([]);
    expect(argSections('')).toEqual([]);
  });
});

describe('resultSections', () => {
  it('pulls the output out of a terminal result', () => {
    expect(resultSections('{"output": "Tue Sep 22", "exit_code": 0}')).toEqual([
      { label: 'Output', text: 'Tue Sep 22' },
      { label: 'Exit', text: '0' },
    ]);
  });
  it('says so when a command printed nothing', () => {
    expect(resultSections({ output: '', exit_code: 0 })[0]).toEqual({ label: 'Output', text: '(no output)' });
  });
  it('surfaces an error string on its own line', () => {
    expect(resultSections({ output: '', error: 'boom', exit_code: 1 })).toEqual([
      { label: 'Output', text: '(no output)' },
      { label: 'Error', text: 'boom' },
      { label: 'Exit', text: '1' },
    ]);
  });
  it('shows a plain string result raw, with no re-encoding', () => {
    expect(resultSections('a\nb')).toEqual([{ label: 'Result', text: 'a\nb' }]);
  });
});

describe('double-encoded payloads — what was actually on screen', () => {
  it('unwraps JSON inside JSON inside JSON, backslashes and all', () => {
    const inner = JSON.stringify({ error: 'account_not_linked', hint: 'Call add_account to link it.' });
    const middle = JSON.stringify({ error: inner });
    const outer = JSON.stringify(middle);
    expect(resultSections(outer)).toEqual([
      { label: 'Error', text: 'account_not_linked' },
      { label: 'Detail', text: '{\n  "hint": "Call add_account to link it."\n}' },
    ]);
  });

  it('shows an execute_code payload as code, not a one-line string', () => {
    const args = JSON.stringify(JSON.stringify({ code: "from hermes_tools import terminal\nr = terminal('ls')" }));
    expect(argSections(args)).toEqual([
      { label: 'Code', text: "from hermes_tools import terminal\nr = terminal('ls')" },
    ]);
  });

  it('drops run metadata once there is real output to read', () => {
    const result = JSON.stringify({
      status: 'success', output: 'hello', exit_code: 0, tool_calls_made: 1,
      duration_seconds: 0.44, stdout_truncated: false, stdout_bytes_captured: 1,
    });
    expect(resultSections(result)).toEqual([
      { label: 'Output', text: 'hello' },
      { label: 'Exit', text: '0' },
    ]);
  });

  it('keeps the metadata when there is nothing else — never an empty card', () => {
    const sections = resultSections(JSON.stringify({ status: 'success', duration_seconds: 0.44 }));
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('Result');
    expect(sections[0].text).toContain('"status": "success"');
  });

  it('leaves a plain sentence alone even though it is a string', () => {
    expect(resultSections('all good')).toEqual([{ label: 'Result', text: 'all good' }]);
  });
});

describe('the same thing is never shown twice', () => {
  it('drops a section whose text another section already contains', () => {
    const sections = resultSections({ output: 'exit 1: boom', error: 'boom' });
    expect(sections.map((s) => s.label)).toEqual(['Output']);
  });

  it('treats an MCP `result` key as the output', () => {
    const payload = JSON.stringify({ result: JSON.stringify([{ id: 1, sender: 'x' }]) });
    const sections = resultSections(payload);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('Output');
    expect(sections[0].text).toContain('"sender": "x"');
    expect(sections[0].text).not.toContain('\\"');
  });

  it('keeps genuinely different sections', () => {
    expect(resultSections({ output: 'ran', error: 'but warned', exit_code: 2 }).map((s) => s.label))
      .toEqual(['Output', 'Error', 'Exit']);
  });
});

describe('the part error beside the result error', () => {
  // The real pair out of chat.db, 2026-09-22.
  const full =
    "tool_call to 'mcp__superhuman_mail__query_email_and_calendar' is missing required argument(s): question. The tool was NOT invoked.";

  it('says nothing the result already said, however it was tagged or cut', () => {
    const shown = resultSections(JSON.stringify({ error: full }));
    expect(errorSection(`tool_scope_block ${full.slice(0, 60)}… [truncated 156 chars]`, shown)).toBeNull();
    expect(errorSection(`tool_error ${full}`, shown)).toBeNull();
  });

  it('still shows an error the result never mentioned', () => {
    const shown = resultSections(JSON.stringify({ output: 'ok' }));
    expect(errorSection('exit 137: killed', shown)).toEqual({ label: 'Error', text: 'exit 137: killed' });
  });

  it('ignores an absent or blank error', () => {
    expect(errorSection(null, [])).toBeNull();
    expect(errorSection('   ', [])).toBeNull();
  });
});

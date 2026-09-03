import { describe, expect, test } from 'bun:test';
import { detectFormat, parseTranscript } from '../src/parsers/index.ts';
import { flatten, sumUsage, type Span } from '../src/model.ts';
import { capText } from '../src/parsers/util.ts';
import { flattenOpencodeExport } from '../src/parsers/opencode.ts';
import { isLciLaunch } from '../src/graft.ts';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.jsonl`, import.meta.url)).text();
const ms = (iso: string) => Date.parse(iso);
const byKind = (root: Span, kind: Span['kind']) => flatten(root).filter((s) => s.kind === kind);

describe('detectFormat', () => {
  for (const [name, format] of [
    ['claude-code', 'claude-code'],
    ['lci', 'lci'],
    ['lci-legacy', 'lci'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
    ['pi', 'pi'],
    ['garbage', 'generic'],
  ] as const) {
    test(`${name} → ${format}`, async () => {
      const lines = (await fixture(name)).split('\n');
      expect(detectFormat(lines)).toBe(format);
      expect(parseTranscript(await fixture(name), `${name}.jsonl`).format).toBe(format);
    });
  }
});

describe('claude-code parser', () => {
  test('split assistant records with one message.id yield one model span, usage counted once', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const models = byKind(s.root, 'model');
    const msg2 = models.filter((m) => m.usage?.output === 80);
    expect(msg2).toHaveLength(1);
    expect(msg2[0]!.usage).toMatchObject({ input: 5, cacheRead: 1000, cacheWrite: 200, cacheWrite5m: 200, output: 80, reasoning: 30 });
    expect(models).toHaveLength(6); // msg_1..msg_5 + sidechain msg_s1
    expect(sumUsage(models).output).toBe(50 + 80 + 40 + 20 + 10 + 5);
    expect(sumUsage(models).cacheWrite1h).toBe(1000);
  });

  test('tool spans end at their tool_result and carry ok from is_error', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const tools = byKind(s.root, 'tool');
    expect(tools.map((t) => t.toolName).sort()).toEqual(['Agent', 'Bash', 'Bash']);
    const t1 = tools.find((t) => t.toolInput?.includes('wc -l'))!;
    expect(t1.ok).toBe(true);
    expect(t1.startMs).toBe(ms('2026-08-30T10:00:00.500Z'));
    expect(t1.endMs).toBe(ms('2026-08-30T10:00:02.000Z'));
    const t2 = tools.find((t) => t.toolInput?.includes('missing.txt'))!;
    expect(t2.ok).toBe(false);
    expect(t2.endMs).toBe(ms('2026-08-30T10:00:04.000Z'));
  });

  test('model spans start at the record the response replies to (real API latency)', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const first = byKind(s.root, 'model').find((m) => m.usage?.output === 50)!;
    expect(first.startMs).toBe(ms('2026-08-30T10:00:00.010Z')); // the last record before the call (the isMeta attachment)
    // The isMeta attachment record joins the turn as injected context, not a new turn.
    expect(first.payload?.newContext?.map((c) => c.role)).toEqual(['user', 'system']);
    expect(first.endMs).toBe(ms('2026-08-30T10:00:00.500Z'));
    const msg2 = byKind(s.root, 'model').find((m) => m.usage?.output === 80)!;
    expect(msg2.startMs).toBe(ms('2026-08-30T10:00:02.000Z')); // toolu_1's result
    expect(msg2.endMs).toBe(ms('2026-08-30T10:00:03.000Z')); // last split record
  });

  test('sidechain records land in a subagent span', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const subs = byKind(s.root, 'subagent');
    expect(subs).toHaveLength(1);
    const inner = flatten(subs[0]!).filter((x) => x.kind === 'model');
    expect(inner).toHaveLength(1);
    expect(inner[0]!.model).toBe('claude-haiku-4-5');
  });

  test('gap > 2s before the next prompt becomes an idle span; turns split on prompts', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const idle = byKind(s.root, 'idle');
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...idle.map((i) => i.endMs - i.startMs))).toBeGreaterThan(2000);
    const turns = byKind(s.root, 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.endMs).toBe(ms('2026-08-30T10:00:20.400Z')); // last turn reaches the final record
    expect(s.title.startsWith('list the files')).toBe(true);
    expect(s.warnings.filter((w) => /malformed/.test(w))).toHaveLength(1);
    expect(s.id).toBe('sess-sample-1');
    expect(s.warnings.some((w) => /malformed|parse|json/i.test(w))).toBe(true);
  });
});

describe('claude-code background tasks', () => {
  const T = (s: string) => `2026-08-30T10:${s}Z`;
  const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'bg', isSidechain: false, ...o });
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const lines = [
    rec({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: T('00:00.000'), message: { role: 'user', content: 'build it with lci' } }),
    rec({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: T('00:01.000'), message: { id: 'm1', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tl', name: 'Bash', input: { command: 'lci --goal-file goal.md', run_in_background: true } }], stop_reason: 'tool_use', usage } }),
    rec({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: T('00:02.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tl', content: 'Command running in background with ID: task9. Output is being written to: /tmp/x/tasks/task9.output.' }] } }),
    rec({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: T('00:03.000'), message: { id: 'm2', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'waiting' }], stop_reason: 'end_turn', usage } }),
    rec({ type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: T('12:00.000'), message: { role: 'user', content: '<task-notification>\n<task-id>task9</task-id>\n<tool-use-id>tl</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run lci on the goal" completed (exit code 0)</summary>\n</task-notification>' } }),
    rec({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: T('12:01.000'), message: { id: 'm3', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage } }),
  ].join('\n');

  test('a backgrounded Bash call runs until its task-notification prompt', () => {
    const s = parseTranscript(lines, 'bg.jsonl');
    const tool = byKind(s.root, 'tool')[0]!;
    expect(tool.startMs).toBe(ms(T('00:01.000')));
    expect(tool.endMs).toBe(ms(T('12:00.000')));
    expect(tool.meta?.background).toBe(true);
    expect(tool.meta?.taskId).toBe('task9');
    // the launching turn widens to cover it, like a subagent would
    const turns = byKind(s.root, 'turn');
    expect(turns[0]!.endMs).toBe(ms(T('12:00.000')));
    expect(s.warnings.filter((w) => w.includes('clamped'))).toHaveLength(0);
  });

  test('task-notification turns are named from their summary', () => {
    const s = parseTranscript(lines, 'bg.jsonl');
    const names = byKind(s.root, 'turn').map((t) => t.name);
    expect(names[0]).toBe('build it with lci');
    expect(names[1]).toBe('task: "Run lci on the goal" completed (exit code 0)');
  });
});

describe('claude-code parallel subagents', () => {
  test('newContext is tracked per subagent chain, not per sidechain flag', () => {
    const T = (s: string) => `2026-08-30T10:00:${s}Z`;
    const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'p', ...o });
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
    const lines = [
      rec({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: T('00.000'), message: { role: 'user', content: 'do two things' } }),
      rec({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, timestamp: T('01.000'), message: { id: 'm0', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: 'A' } }, { type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'B' } }], stop_reason: 'tool_use', usage } }),
      // chain A starts
      rec({ type: 'user', uuid: 'sa1', parentUuid: null, isSidechain: true, timestamp: T('02.000'), message: { role: 'user', content: 'task A' } }),
      rec({ type: 'assistant', uuid: 'sa2', parentUuid: 'sa1', isSidechain: true, timestamp: T('03.000'), message: { id: 'mA1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'tool_use', id: 'ta', name: 'Bash', input: { command: 'a' } }], stop_reason: 'tool_use', usage: { ...usage, output_tokens: 11 } } }),
      rec({ type: 'user', uuid: 'sa3', parentUuid: 'sa2', isSidechain: true, timestamp: T('04.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ta', content: 'result A' }] } }),
      // chain B interleaves
      rec({ type: 'user', uuid: 'sb1', parentUuid: null, isSidechain: true, timestamp: T('05.000'), message: { role: 'user', content: 'task B' } }),
      rec({ type: 'assistant', uuid: 'sb2', parentUuid: 'sb1', isSidechain: true, timestamp: T('06.000'), message: { id: 'mB1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'B done' }], stop_reason: 'end_turn', usage: { ...usage, output_tokens: 21 } } }),
      // chain A continues after B's call
      rec({ type: 'assistant', uuid: 'sa4', parentUuid: 'sa3', isSidechain: true, timestamp: T('07.000'), message: { id: 'mA2', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'A done' }], stop_reason: 'end_turn', usage: { ...usage, output_tokens: 12 } } }),
      rec({ type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: false, timestamp: T('08.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'A done' }, { type: 'tool_result', tool_use_id: 't2', content: 'B done' }] } }),
    ].join('\n');
    const s = parseTranscript(lines, 'parallel.jsonl');
    const models = byKind(s.root, 'model');
    const a2 = models.find((m) => m.usage?.output === 12)!;
    const b1 = models.find((m) => m.usage?.output === 21)!;
    expect(a2.payload?.newContext?.map((c) => c.text)).toEqual(['result A']);
    expect(b1.payload?.newContext?.map((c) => c.text)).toEqual(['task B']);
    expect(byKind(s.root, 'subagent')).toHaveLength(2);
  });
});

describe('lci parser', () => {
  test('inference → model span with input = prompt − cacheRead − cacheWrite and start = at − latency', async () => {
    const s = parseTranscript(await fixture('lci'), 'transcript.jsonl');
    const models = byKind(s.root, 'model');
    expect(models).toHaveLength(2);
    const first = models.find((m) => m.usage?.output === 200)!;
    expect(first.usage).toMatchObject({ input: 1000, cacheRead: 3000, cacheWrite: 1000, output: 200 });
    expect(first.model).toBe('glm-5.3-flash');
    expect(first.provider).toBe('openrouter');
    expect(first.endMs).toBe(ms('2026-08-30T10:00:03.000Z'));
    expect(first.endMs - first.startMs).toBe(2500);
    expect(s.title.startsWith('Add a --version flag')).toBe(true);
  });

  test('tool-call/tool-result pair by callId; loops become turns', async () => {
    const s = parseTranscript(await fixture('lci'), 'transcript.jsonl');
    const tools = byKind(s.root, 'tool');
    expect(tools).toHaveLength(2);
    const bash = tools.find((t) => t.toolName === 'BASH')!;
    expect(bash.ok).toBe(true);
    expect(bash.endMs - bash.startMs).toBe(900);
    expect(tools.find((t) => t.toolName === 'EDIT')!.ok).toBe(false);
    expect(byKind(s.root, 'turn')).toHaveLength(2);
    expect(s.root.detail ?? '').toContain('Summary');
  });

  test('legacy transcript without inference events warns and has no model spans', async () => {
    const s = parseTranscript(await fixture('lci-legacy'), 'transcript.jsonl');
    expect(byKind(s.root, 'model')).toHaveLength(0);
    expect(byKind(s.root, 'tool')).toHaveLength(2);
    expect(s.warnings.some((w) => /no inference/i.test(w))).toBe(true);
  });
});

describe('codex parser', () => {
  test('token_count maps cached tokens to cacheRead and excludes them from input', async () => {
    const s = parseTranscript(await fixture('codex'), 'rollout.jsonl');
    const models = byKind(s.root, 'model');
    expect(models).toHaveLength(1);
    expect(models[0]!.usage).toMatchObject({ input: 2000, cacheRead: 6000, cacheWrite: 0, output: 300, reasoning: 100 });
    expect(models[0]!.model).toBe('gpt-5-codex');
    expect(s.id).toBe('sess-cx-1');
  });

  test('function_call pairs with function_call_output by call_id; turn spans task duration', async () => {
    const s = parseTranscript(await fixture('codex'), 'rollout.jsonl');
    const tools = byKind(s.root, 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.toolName).toBe('shell');
    expect(tools[0]!.startMs).toBe(ms('2026-08-30T15:00:01.000Z'));
    expect(tools[0]!.endMs).toBe(ms('2026-08-30T15:00:01.800Z'));
    const turns = byKind(s.root, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endMs).toBe(ms('2026-08-30T15:00:03.000Z'));
  });
});

describe('pi parser', () => {
  test('real session: header id/cwd, one turn, model spans with 1:1 usage', async () => {
    const s = parseTranscript(await fixture('pi'), 'pi.jsonl');
    expect(s.format).toBe('pi');
    expect(s.id).toBe('01a061db-821d-75d1-9c81-12645c109194');
    expect(s.root.meta?.cwd).toBe('/Users/tylerwhitehurst/src/seekdeep/.worktrees/72286388');
    expect(s.root.startMs).toBe(Date.parse('2026-09-02T11:22:50.782Z'));
    const turns = s.root.children.filter((c) => c.kind === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.name.startsWith('Run the shell command')).toBe(true);
    const models = flatten(s.root).filter((sp) => sp.kind === 'model');
    expect(models).toHaveLength(2);
    expect(models[0]!.model).toBe('gpt-5.4');
    expect(models[0]!.provider).toBe('openai');
    expect(models[0]!.usage).toEqual({ input: 1043, cacheRead: 0, cacheWrite: 0, output: 85 });
    expect(models[0]!.payload?.thinking?.length ?? 0).toBeGreaterThan(0);
    expect(models[0]!.payload?.newContext?.[0]?.role).toBe('user');
    // The model span starts at the prompt entry and ends at the assistant entry.
    expect(models[0]!.startMs).toBe(Date.parse('2026-09-02T11:22:50.790Z'));
    expect(models[0]!.endMs).toBe(Date.parse('2026-09-02T11:22:53.370Z'));
    expect(models[1]!.payload?.newContext?.some((c) => c.role === 'tool_result' && c.ok === true)).toBe(true);
    expect(models[1]!.payload?.stopReason).toBe('stop');
  });

  test('bash tool calls pair with their toolResult and expose the raw command', async () => {
    const s = parseTranscript(await fixture('pi'), 'pi.jsonl');
    const tools = flatten(s.root).filter((sp) => sp.kind === 'tool');
    expect(tools).toHaveLength(1);
    const bash = tools[0]!;
    expect(bash.toolName).toBe('bash');
    expect(bash.ok).toBe(true);
    expect(bash.payload?.input).toBe('lci --version');
    expect(bash.payload?.output).toBe('lci 0.97.0\n');
    expect(bash.endMs).toBe(Date.parse('2026-09-02T11:22:53.459Z'));
    expect(isLciLaunch(bash)).toBe(true);
  });

  test('model_change sets the model for messages without one; unmatched calls warn', () => {
    const t = '2026-09-02T10:00:0';
    const text = [
      { type: 'session', version: 3, id: 's1', timestamp: `${t}0.000Z`, cwd: '/p' },
      { type: 'model_change', id: 'a', parentId: null, timestamp: `${t}0.001Z`, provider: 'anthropic', modelId: 'claude-opus-5' },
      { type: 'message', id: 'b', parentId: 'a', timestamp: `${t}1.000Z`, message: { role: 'user', content: 'go', timestamp: 1 } },
      {
        type: 'message',
        id: 'c',
        parentId: 'b',
        timestamp: `${t}3.000Z`,
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'read', arguments: { path: 'x' } }], usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 3, cacheWrite1h: 3, reasoning: 1 }, stopReason: 'toolUse', timestamp: 3 },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const s = parseTranscript(text, 'x.jsonl');
    expect(s.format).toBe('pi');
    const model = flatten(s.root).find((sp) => sp.kind === 'model')!;
    expect(model.model).toBe('claude-opus-5');
    expect(model.provider).toBe('anthropic');
    expect(model.usage).toEqual({ input: 5, cacheRead: 1, cacheWrite: 3, cacheWrite1h: 3, output: 2, reasoning: 1 });
    const tool = flatten(s.root).find((sp) => sp.kind === 'tool')!;
    expect(tool.payload?.input).toContain('"path": "x"');
    expect(tool.ok).toBeUndefined();
    expect(s.warnings.some((w) => w.includes('no result'))).toBe(true);
  });
});

describe('opencode parser', () => {
  test('real session: title/cwd, turns per prompt, one model span per step-finish', async () => {
    const s = parseTranscript(await fixture('opencode'), 'opencode.jsonl');
    expect(s.format).toBe('opencode');
    expect(s.id).toBe('ses_f9e2c8994ffeGN1Ii7hj7D2065');
    expect(s.title).toBe('Repo contents overview');
    expect(s.root.meta?.cwd).toBe('/Users/tylerwhitehurst/src/seekdeep/.worktrees/c97a002e');
    expect(s.root.startMs).toBe(1788347643500);
    const turns = s.root.children.filter((c) => c.kind === 'turn');
    expect(turns.map((t) => t.name)).toEqual(['whats in this repo?', 'whats in this repo?', 'nice. how does it work?']);
    expect(s.root.children.filter((c) => c.kind === 'idle')).toHaveLength(2);
    const models = flatten(s.root).filter((sp) => sp.kind === 'model');
    // The first assistant message (a quota error with no parts and zero
    // tokens — `opencode export` drops the error object) draws nothing;
    // then 3 steps + 4 steps.
    expect(models).toHaveLength(7);
    const first = models[0]!;
    expect(first.model).toBe('muse-spark-1.2-contributor-free');
    expect(first.provider).toBe('opencode');
    expect(first.usage).toEqual({ input: 8435, cacheRead: 241, cacheWrite: 0, output: 82, reasoning: 11 });
    expect(first.startMs).toBe(1788347699048); // message time.created
    expect(first.endMs).toBe(1788347700508); // latest part time.end in the step (the read tool)
    expect(first.payload?.stopReason).toBe('tool-calls');
    expect(first.payload?.output).toBe("Checking what's in this repo.");
    expect(models[1]!.payload?.newContext?.[0]?.role).toBe('tool_result');
  });

  test('an assistant message with an API error and no parts is a failed model span', () => {
    const t0 = 1_800_000_000_000;
    const recs = [
      { type: 'opencode.session', data: { id: 'ses_a', directory: '/p', title: 'Err', version: '1.18.26', time: { created: t0, updated: t0 + 5000 } } },
      { type: 'opencode.message', data: { id: 'm1', sessionID: 'ses_a', role: 'user', time: { created: t0 } } },
      { type: 'opencode.part', data: { id: 'p1', sessionID: 'ses_a', messageID: 'm1', type: 'text', text: 'hi' } },
      { type: 'opencode.message', data: { id: 'm2', sessionID: 'ses_a', role: 'assistant', modelID: 'gpt-5.3-chat-latest', providerID: 'openai', time: { created: t0 + 10, completed: t0 + 3000 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, error: { name: 'APIError', data: { message: 'Quota exceeded.' } } } },
    ];
    const s = parseTranscript(recs.map((r) => JSON.stringify(r)).join('\n'), 'oc.jsonl');
    const model = flatten(s.root).find((sp) => sp.kind === 'model')!;
    expect(model.ok).toBe(false);
    expect(model.payload?.stopReason).toBe('error');
    expect(model.startMs).toBe(t0 + 10);
    expect(model.endMs).toBe(t0 + 3000);
    expect(model.detail).toBe('Quota exceeded.');
    expect(s.warnings.some((w) => w.startsWith('model call failed'))).toBe(true);
  });

  test('tool parts become tool spans timed by state.time with ok from status', async () => {
    const s = parseTranscript(await fixture('opencode'), 'opencode.jsonl');
    const tools = flatten(s.root).filter((sp) => sp.kind === 'tool');
    expect(tools).toHaveLength(12);
    expect(tools.every((t) => t.toolName === 'read' && t.ok === true)).toBe(true);
    expect(tools[0]!.startMs).toBe(1788347700504);
    expect(tools[0]!.endMs).toBe(1788347700508);
    expect(tools[0]!.payload?.input).toContain('"filePath"');
    expect(tools[0]!.payload?.output?.startsWith('<path>')).toBe(true);
  });

  test('bash tool input is the raw command; child sessions nest as subagents', () => {
    const t0 = 1_800_000_000_000;
    const recs = [
      { type: 'opencode.session', data: { id: 'ses_a', directory: '/p', title: 'Root', version: '1.18.26', time: { created: t0, updated: t0 + 20_000 } } },
      { type: 'opencode.session', data: { id: 'ses_b', parentID: 'ses_a', directory: '/p', title: 'explore', version: '1.18.26', time: { created: t0 + 3000, updated: t0 + 6000 } } },
      { type: 'opencode.message', data: { id: 'm1', sessionID: 'ses_a', role: 'user', time: { created: t0 } } },
      { type: 'opencode.part', data: { id: 'p1', sessionID: 'ses_a', messageID: 'm1', type: 'text', text: 'run lci' } },
      { type: 'opencode.message', data: { id: 'm2', sessionID: 'ses_a', role: 'assistant', modelID: 'gpt-5.4', providerID: 'openai', time: { created: t0 + 1000, completed: t0 + 10_000 } } },
      { type: 'opencode.part', data: { id: 'p2', sessionID: 'ses_a', messageID: 'm2', type: 'step-start' } },
      { type: 'opencode.part', data: { id: 'p3', sessionID: 'ses_a', messageID: 'm2', type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'lci --json "do it"' }, output: 'ok', time: { start: t0 + 2000, end: t0 + 9000 } } } },
      { type: 'opencode.part', data: { id: 'p4', sessionID: 'ses_a', messageID: 'm2', type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } } } },
      { type: 'opencode.message', data: { id: 'm3', sessionID: 'ses_b', role: 'user', time: { created: t0 + 3000 } } },
      { type: 'opencode.part', data: { id: 'p5', sessionID: 'ses_b', messageID: 'm3', type: 'text', text: 'look around' } },
      { type: 'opencode.message', data: { id: 'm4', sessionID: 'ses_b', role: 'assistant', modelID: 'gpt-5.4', providerID: 'openai', time: { created: t0 + 3500, completed: t0 + 5000 } } },
      { type: 'opencode.part', data: { id: 'p6', sessionID: 'ses_b', messageID: 'm4', type: 'text', text: 'done', time: { start: t0 + 4000, end: t0 + 5000 } } },
      { type: 'opencode.part', data: { id: 'p7', sessionID: 'ses_b', messageID: 'm4', type: 'step-finish', reason: 'stop', tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    ];
    const s = parseTranscript(recs.map((r) => JSON.stringify(r)).join('\n'), 'oc.jsonl');
    expect(s.format).toBe('opencode');
    const bash = flatten(s.root).find((sp) => sp.kind === 'tool')!;
    expect(bash.payload?.input).toBe('lci --json "do it"');
    expect(isLciLaunch(bash)).toBe(true);
    expect(bash.startMs).toBe(t0 + 2000);
    expect(bash.endMs).toBe(t0 + 9000);
    const model = flatten(s.root).find((sp) => sp.kind === 'model')!;
    expect(model.usage).toEqual({ input: 10, cacheRead: 2, cacheWrite: 1, output: 5, reasoning: 0 });
    expect(model.endMs).toBe(t0 + 9000); // step ends with its last tool
    const sub = flatten(s.root).find((sp) => sp.kind === 'subagent')!;
    expect(sub.name).toBe('subagent · explore');
    expect(sub.parentId).toBe(s.root.children.find((c) => c.kind === 'turn')!.id);
    expect(sub.children.map((c) => c.kind)).toEqual(['model']);
    expect(sub.children[0]!.usage?.input).toBe(3);
  });

  test('an `opencode export` JSON document flattens to the same spans', async () => {
    const flat = await fixture('opencode');
    const info: Record<string, unknown> = {};
    const messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[] = [];
    for (const line of flat.split('\n')) {
      if (line.trim().length === 0) continue;
      const rec = JSON.parse(line) as { type: string; data: Record<string, unknown> };
      if (rec.type === 'opencode.session') Object.assign(info, rec.data);
      else if (rec.type === 'opencode.message') messages.push({ info: rec.data, parts: [] });
      else messages[messages.length - 1]!.parts.push(rec.data);
    }
    const exported = JSON.stringify({ info, messages }, null, 2);
    expect(flattenOpencodeExport('[1,2]')).toBeNull();
    expect(flattenOpencodeExport('{"info":1}')).toBeNull();
    expect(flattenOpencodeExport(exported)).not.toBeNull();
    const a = parseTranscript(exported, 'export.json');
    const b = parseTranscript(flat, 'opencode.jsonl');
    expect(a.format).toBe('opencode');
    expect(flatten(a.root).map((sp) => [sp.kind, sp.startMs, sp.endMs])).toEqual(flatten(b.root).map((sp) => [sp.kind, sp.startMs, sp.endMs]));
  });
});

describe('generic parser', () => {
  test('never throws on garbage and still finds timestamped/usage records', async () => {
    const s = parseTranscript(await fixture('garbage'), 'garbage.jsonl');
    expect(s.format).toBe('generic');
    expect(flatten(s.root).length).toBeGreaterThan(1);
    expect(byKind(s.root, 'model')).toHaveLength(1);
    expect(s.warnings.length).toBeGreaterThan(0);
  });

  test('OpenAI-shaped usage: prompt_tokens includes cached tokens, so input excludes them', () => {
    const line = JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 700 } });
    const s = parseTranscript(line, 'openai.jsonl');
    const m = byKind(s.root, 'model')[0]!;
    expect(m.usage).toMatchObject({ input: 300, cacheRead: 700, output: 20 });
  });

  test('empty input yields a session with a root span', () => {
    const s = parseTranscript('', 'empty.jsonl');
    expect(s.root.kind).toBe('session');
    expect(s.root.endMs).toBeGreaterThanOrEqual(s.root.startMs);
  });
});

describe('invariants', () => {
  for (const name of ['claude-code', 'lci', 'lci-legacy', 'codex', 'opencode', 'pi', 'garbage']) {
    test(`${name}: endMs >= startMs and children within parents`, async () => {
      const s = parseTranscript(await fixture(name), `${name}.jsonl`);
      const check = (span: Span) => {
        expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
        for (const c of span.children) {
          expect(c.parentId).toBe(span.id);
          expect(c.startMs).toBeGreaterThanOrEqual(span.startMs);
          expect(c.endMs).toBeLessThanOrEqual(span.endMs);
          check(c);
        }
      };
      check(s.root);
    });
  }
});

describe('payloads (detail pane data)', () => {
  test('capText cuts at PAYLOAD_CAP and reports truncation', () => {
    const { text, truncated } = capText('x'.repeat(30_000));
    expect(text).toHaveLength(20_000);
    expect(truncated).toBe(true);
  });

  test('claude-code: tool spans carry full input/output payloads', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const tools = byKind(s.root, 'tool');
    const t1 = tools.find((t) => t.toolInput?.includes('wc -l'))!;
    expect(t1.payload?.input).toContain('ls src | wc -l');
    expect(t1.payload?.output).toBe('7');
    const t2 = tools.find((t) => t.toolInput?.includes('missing.txt'))!;
    expect(t2.payload?.output).toContain('No such file');
  });

  test('claude-code: model newContext = records since the previous model call', async () => {
    const s = parseTranscript(await fixture('claude-code'), 'cc.jsonl');
    const models = byKind(s.root, 'model');
    const m1 = models.find((m) => m.usage?.output === 50)!;
    const m2 = models.find((m) => m.usage?.output === 80)!;
    const m4 = models.find((m) => m.usage?.output === 10)!;
    const m5 = models.find((m) => m.usage?.output === 5)!;
    // First model call sees everything from the transcript start.
    expect(m1.payload?.newContext).toHaveLength(2); // prompt + injected attachment
    expect(m1.payload?.newContext?.[0]?.role).toBe('user');
    expect(m1.payload?.newContext?.[0]?.text.startsWith('list the files')).toBe(true);
    // Second call: only the Bash tool_result.
    expect(m2.payload?.newContext).toHaveLength(1);
    expect(m2.payload?.newContext?.[0]).toMatchObject({ role: 'tool_result', ok: true, text: '7' });
    expect(m2.payload?.newContext?.[0]?.label).toContain('Bash');
    // msg_4 output text; msg_5 opens the second turn with a new user prompt.
    expect(m4.payload?.output).toContain('7 files');
    expect(m5.payload?.newContext).toHaveLength(1);
    expect(m5.payload?.newContext?.[0]?.role).toBe('user');
    expect(m5.payload?.newContext?.[0]?.text).toBe('now run the tests');
  });

  test('lci: tool payloads and inference newContext (goal + tool results)', async () => {
    const s = parseTranscript(await fixture('lci'), 'transcript.jsonl');
    const models = byKind(s.root, 'model');
    const tools = byKind(s.root, 'tool');
    expect(tools.find((t) => t.toolName === 'BASH')!.payload?.output).toContain('exit code 0');
    const [first, second] = models;
    expect(first!.payload?.newContext).toHaveLength(1);
    expect(first!.payload?.newContext?.[0]?.label).toBe('goal');
    const secondCtx = second!.payload?.newContext ?? [];
    expect(secondCtx).toHaveLength(2);
    expect(secondCtx[0]).toMatchObject({ role: 'tool_result', ok: true });
    expect(secondCtx[1]).toMatchObject({ role: 'tool_result', ok: false });
  });

  test('codex: tool input/output and model newContext (prompt + tool result)', async () => {
    const s = parseTranscript(await fixture('codex'), 'rollout.jsonl');
    const models = byKind(s.root, 'model');
    const tools = byKind(s.root, 'tool');
    expect(tools[0]!.payload?.input).toContain('make');
    expect(tools[0]!.payload?.output).toContain('No rule');
    const ctx = models[0]!.payload?.newContext ?? [];
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toMatchObject({ role: 'user', text: 'fix the failing build' });
    expect(ctx[1]?.role).toBe('tool_result');
  });
});

describe('codex parser edge cases', () => {
  test('a re-issued call_id keeps the earlier call as its own tool span', () => {
    const lines = [
      { timestamp: '2026-01-01T00:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5' } },
      { timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"a":1}', call_id: 'c1' } },
      { timestamp: '2026-01-01T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"a":2}', call_id: 'c1' } },
      { timestamp: '2026-01-01T00:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
      { timestamp: '2026-01-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 4000 } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const s = parseTranscript(lines, 'dup.jsonl');
    const tools = byKind(s.root, 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.endMs - t.startMs).sort()).toEqual([1000, 1000]);
    expect(tools.some((t) => t.detail?.includes('superseded'))).toBe(true);
  });
});

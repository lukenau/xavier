#!/usr/bin/env node
// Usage: node scripts/xavier/gen-pose.mjs <id...|--all> [--n 3] [--model google/gemini-3-pro-image]
//        [--start 1] [--extra "additional direction"] [--ref character.png] [--style style.png]
// Needs OPENROUTER_API_KEY in env. Writes scripts/xavier/out/<id>/cand-<n>.png and appends
// per-call cost to scripts/xavier/out/costs.jsonl.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLE, POSES } from './poses.prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const n = Number(opt('n', 3));
const start = Number(opt('start', 1));
const model = opt('model', 'google/gemini-3-pro-image');
const extra = opt('extra', '');
const refPath = opt('ref', join(here, 'reference.png'));
const stylePath = opt('style', join(here, 'style.png'));
const all = args.includes('--all');
const ids = all ? POSES.map((p) => p.id) : args.filter((a) => !a.startsWith('--'));

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY not set');
if (!ids.length) throw new Error('give a pose id or --all');

const refUrl = `data:image/png;base64,${(await readFile(refPath)).toString('base64')}`;
const styleUrl = `data:image/png;base64,${(await readFile(stylePath)).toString('base64')}`;
const outRoot = join(here, 'out');

async function generate(pose, idx) {
  const text = [STYLE, pose.prompt, extra].filter(Boolean).join('\n\n');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      modalities: ['image', 'text'],
      usage: { include: true },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: refUrl } },
            { type: 'image_url', image_url: { url: styleUrl } },
            { type: 'text', text },
          ],
        },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pose.id}#${idx} HTTP ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`${pose.id}#${idx} no image returned: ${String(body.choices?.[0]?.message?.content).slice(0, 200)}`);
  const dir = join(outRoot, pose.id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `cand-${idx}.png`);
  await writeFile(file, Buffer.from(url.split(',')[1], 'base64'));
  const cost = body.usage?.cost ?? null;
  await appendFile(join(outRoot, 'costs.jsonl'), JSON.stringify({ id: pose.id, idx, model, cost, at: new Date().toISOString() }) + '\n');
  console.log(`${pose.id} cand-${idx} ok cost=${cost}`);
}

await mkdir(outRoot, { recursive: true });
const jobs = [];
for (const id of ids) {
  const pose = POSES.find((p) => p.id === id);
  if (!pose) throw new Error(`unknown pose ${id}`);
  for (let i = start; i < start + n; i++) jobs.push([pose, i]);
}
let failed = 0;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [pose, i] = queue.shift();
      await generate(pose, i).catch((e) => {
        failed++;
        console.error(e.message);
      });
    }
  }),
);
process.exitCode = failed ? 1 : 0;

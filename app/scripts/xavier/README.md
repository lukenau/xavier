# Xavier poses

Style: dot-matrix LED art with sparse gold blueprint ticks, on flat `#000d0e`,
waist-up, reserved expression (mouth closed). All 13 are from
**`openai/gpt-5.4-image-2`** — keep one model for the whole set or it reads as a
mixed family. Pipeline: `poses.prompts.mjs` (STYLE + per-pose prompt) →
`gen-pose.mjs` (OpenRouter; character ref `reference.png` + a style ref) →
`export.py` (square crop, 600px JPEG) → `assets/xavier/<id>.jpg`.

To add a pose:
1. Append `{ id, prompt }` to `POSES` in `poses.prompts.mjs`; add the id to `ORDER` in `export.py`.
2. `export OPENROUTER_API_KEY=...` (from /srv/hub-data/.env, never echo it), then
   `node scripts/xavier/gen-pose.mjs <id> --n 1 --model openai/gpt-5.4-image-2 --style <an existing pose's candidate png>`
   (~$0.24/image; the key is shared with Hermes, so check the balance first and generate one take at a time).
3. Review `out/<id>/cand-*.png`; reject anything off-model (floppy spotted ears, bow tie, calm face).
4. `python scripts/xavier/export.py <id>=scripts/xavier/out/<id>/cand-N.png`, then `--sheet`.
5. Add the pose to `src/whimsy/poses.ts` with a `POSE_FACES` entry (face centre + zoom for the round crop).

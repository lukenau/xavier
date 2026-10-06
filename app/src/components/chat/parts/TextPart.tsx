// Assistant/user prose, rendered from the markdown Xavier actually writes.
//
// The first cut printed the raw string, so bold came through as literal
// asterisks (the user, 2026-09-22). VERDICT-V2 §2 put `react-native-enriched-
// markdown` in the native build, but a new dependency changes the
// expo-updates fingerprint — waiting for a TestFlight build to make **bold**
// bold is the wrong trade. `chat/markdown.ts` parses the subset in-app and
// this file lays it out; the part shape is unchanged either way.
import { Fragment } from 'react';
import { Linking, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';
import { parseMarkdown, type Block, type Span } from '../../../chat/markdown';
import { useSmoothedText } from '../../../chat/useSmoothedText';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';

function Inline({ spans, color }: { spans: Span[]; color: TokenName }) {
  const { t } = useTheme();
  return (
    <>
      {spans.map((span, i) => (
        <Text
          key={i}
          selectable
          onPress={span.href ? () => void Linking.openURL(span.href as string).catch(() => {}) : undefined}
          style={[
            // Colour carries the hierarchy, not just weight: bold lifts to the
            // brightest ink so a scan finds it, code and links keep their own
            // hue, everything else sits at the body tone (the user: "diff font
            // colors for headers and such… design that reduces cognitive load").
            span.bold ? [styles.bold, { color: t('fg-0') }] : null,
            span.italic ? styles.italic : null,
            span.code ? [styles.code, { color: t('petrol') }] : null,
            span.href ? [styles.link, { color: t('accent') }] : null,
            !span.code && !span.href && !span.bold ? { color: t(color) } : null,
          ]}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

/** A run of prose the reader can select a PART of.
 *
 * React Native's iOS `<Text selectable>` cannot do that: its edit menu offers
 * one action, and `copy:` copies the paragraph from 0 to its full length
 * (`RCTParagraphComponentView.mm`). So "selection is the native gesture" (L44)
 * only ever copied whole paragraphs, and the user reported it twice (L44, L60).
 * A read-only multiline TextInput is a UITextView, which gives real range
 * selection with handles. Styled spans still render inside it as children.
 *
 * The one cost: a tap on a nested Text inside a TextInput does not fire, so a
 * block that contains a link stays as selectable Text and keeps its link. */
function Prose({ spans, color, style }: { spans: Span[]; color: TokenName; style: StyleProp<TextStyle> }) {
  // No height is pinned here, and none should be. A text view never reports a
  // content height smaller than its own frame, so a height taken from it can
  // only ratchet UP: one transient tall measurement stuck for good as an empty
  // gap above the timestamp, and while a long reply streamed the pin ran a pass
  // behind the text on every tick, so the page bounced ("long tool calls or
  // messages cause the chat page to go up and down in a flicker", the user,
  // 2026-10-01). The pin was a workaround for list items that were each their
  // own view in a flex row; those now live in one view (ProseRun) in a plain
  // column, which sizes itself in a single pass.
  if (spans.some((span) => span.href)) {
    return (
      <Text selectable style={style}>
        <Inline spans={spans} color={color} />
      </Text>
    );
  }
  return (
    <TextInput
      editable={false}
      multiline
      scrollEnabled={false}
      style={[style, styles.selectable]}
    >
      <Inline spans={spans} color={color} />
    </TextInput>
  );
}

function BlockView({ block, color }: { block: Block; color: TokenName }) {
  const { t } = useTheme();
  if (block.type === 'code') {
    return (
      <View style={[styles.codeBlock, { backgroundColor: t('bg-0'), borderColor: t('border') }]}>
        <TextInput
          editable={false}
          multiline
          scrollEnabled={false}
          style={[styles.codeBlockText, styles.selectable, { color: t('fg-2') }]}
        >
          {block.text}
        </TextInput>
      </View>
    );
  }
  if (block.type === 'rule') {
    return <View style={[styles.rule, { backgroundColor: t('border') }]} />;
  }
  if (block.type === 'h') {
    // Three ranks, three treatments. h1/h2 are titles in the brightest ink; h3
    // is an eyebrow — mono, uppercase, quiet — which is the app's own
    // SectionHead idiom and reads as a label rather than competing with the
    // prose under it.
    if (block.level === 3) {
      return (
        <Prose spans={block.spans} color="fg-3" style={[styles.eyebrow, { color: t('fg-3') }]} />
      );
    }
    return (
      <Prose spans={block.spans} color="fg-0" style={[styles.heading, HEADING_SIZE[block.level], { color: t('fg-0') }]} />
    );
  }
  if (block.type === 'li') {
    return (
      <View style={styles.listRow}>
        <Text style={[styles.marker, { color: t(block.ordered ? 'accent' : 'fg-3') }]}>{block.marker}</Text>
        <Prose spans={block.spans} color={color} style={[styles.text, styles.listText]} />
      </View>
    );
  }
  if (block.type === 'quote') {
    return (
      <View style={[styles.quote, { borderLeftColor: t('border-strong') }]}>
        <Prose spans={block.spans} color="fg-2" style={styles.text} />
      </View>
    );
  }
  return (
    <Prose spans={block.spans} color={color} style={styles.text} />
  );
}

/** Blocks that can share one selectable view. A selection only ever runs
 * inside a single native text view, so a paragraph, a heading and a list item
 * each in their own view meant a drag stopped at every blank line — "i can't
 * copy across multiple lines when there is a blank line right now. that is a
 * bug" (the user, 2026-09-30). Joined into one run they select together, and the
 * blank line between them is a real newline in the view, so it comes along in
 * what is copied.
 *
 * A quote and a code block keep their own view because their border and their
 * box cannot exist inside a text run, and a block carrying a link keeps its
 * own because a tap inside a TextInput never reaches the nested Text. */
/** The blocks that carry spans and no box of their own. A type guard, so a run
 * of them is typed as such rather than as the whole Block union — `code` and
 * `rule` have no `spans` at all (caught by ai-6d's release gate, 2026-09-30). */
type ProseBlock = Extract<Block, { type: 'p' | 'h' | 'li' }>;

function joinable(block: Block): block is ProseBlock {
  if (block.type !== 'p' && block.type !== 'h' && block.type !== 'li') return false;
  return !block.spans.some((span) => span.href);
}

/** The newline that goes BETWEEN two blocks of one run, and into the copy:
 * list items are one line apart, everything else a blank line. */
function gapBetween(before: ProseBlock, after: ProseBlock): string {
  return before.type === 'li' && after.type === 'li' ? '\n' : '\n\n';
}

function segment(blocks: Block[]): Block[][] {
  const runs: Block[][] = [];
  for (const block of blocks) {
    const current = runs[runs.length - 1];
    if (current && joinable(block) && joinable(current[current.length - 1])) current.push(block);
    else runs.push([block]);
  }
  return runs;
}

export function TextPart({
  text,
  color = 'fg-1',
  streaming = false,
}: {
  text: string;
  color?: TokenName;
  streaming?: boolean;
}) {
  // While the reply is still arriving, reveal it at a steady rate rather than a
  // chunk at a time — the plugin batches ~48 characters per post, and landing
  // those whole is the Discord-looking stutter (the user, 2026-09-22).
  const shown = useSmoothedText(text, streaming);
  const blocks = parseMarkdown(shown);
  const runs = segment(blocks);
  return (
    <View style={styles.stack}>
      {runs.map((run, i) =>
        run.every(joinable) ? (
          <ProseRun key={`run${i}`} blocks={run} color={color} />
        ) : (
          <Fragment key={`run${i}`}>
            <BlockView block={run[0]} color={color} />
          </Fragment>
        ),
      )}
    </View>
  );
}

/** One selectable view holding a run of blocks, newlines and all.
 *
 * It sizes itself — no height is pinned from `onContentSizeChange`. A text
 * view never reports a content height smaller than its own frame, so a pinned
 * height can only ratchet up: one transient tall measurement from some later
 * turn's re-render stuck as a large empty gap above the timestamp, and while a
 * long reply streamed the pin ran a pass behind the text on every tick, so the
 * page bounced (the user, 2026-10-01: "go up and down in a flicker"). The pin was
 * added for list items that were each their own view in a flex row; they are
 * one view in a plain column now, which is laid out in a single pass. */
function ProseRun({ blocks, color }: { blocks: ProseBlock[]; color: TokenName }) {
  const { t } = useTheme();
  return (
    <TextInput
      editable={false}
      multiline
      scrollEnabled={false}
      style={[styles.text, styles.selectable, { color: t(color) }]}
    >
      {blocks.map((block, i) => (
        <Fragment key={i}>
          {i > 0 ? <Text>{gapBetween(blocks[i - 1], block)}</Text> : null}
          <Text style={runStyle(block, t)}>
            {block.type === 'li' ? (
              <Text style={{ color: t(block.ordered ? 'accent' : 'fg-3') }}>{`${block.marker}  `}</Text>
            ) : null}
            <Inline spans={block.spans} color={block.type === 'h' ? 'fg-0' : color} />
          </Text>
        </Fragment>
      ))}
    </TextInput>
  );
}

function runStyle(block: ProseBlock, t: (name: TokenName) => string): StyleProp<TextStyle> {
  if (block.type !== 'h') return undefined;
  if (block.level === 3) return [styles.eyebrow, { color: t('fg-3') }];
  return [styles.heading, HEADING_SIZE[block.level], { color: t('fg-0') }];
}

const HEADING_SIZE = {
  1: { fontSize: 17.5, lineHeight: 24 },
  2: { fontSize: 15.5, lineHeight: 21 },
  3: { fontSize: 14.5, lineHeight: 20 },
} as const;

const styles = StyleSheet.create({
  stack: { gap: 8 },
  // A UITextView pads its text by default; zeroed so it sits exactly where the
  // Text it replaced did.
  selectable: { padding: 0, paddingTop: 0, paddingBottom: 0, margin: 0 },
  text: { fontFamily: fonts.sans(400), fontSize: 14.5, lineHeight: 21 },
  bold: { fontFamily: fonts.sans(600) },
  italic: { fontStyle: 'italic' },
  code: { fontFamily: fonts.mono(400), fontSize: 13 },
  link: { textDecorationLine: 'underline' },
  heading: { fontFamily: fonts.sans(620), letterSpacing: -0.2, marginTop: 2 },
  eyebrow: { fontFamily: fonts.mono(550), fontSize: 10, letterSpacing: 1.3, textTransform: 'uppercase', marginTop: 2 },
  listRow: { flexDirection: 'row', gap: 8, paddingLeft: 2 },
  marker: { fontFamily: fonts.mono(500), fontSize: 12.5, lineHeight: 21, minWidth: 14 },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 2, paddingLeft: 10 },
  codeBlock: { borderWidth: 1, borderRadius: 9, padding: 10 },
  codeBlockText: { fontFamily: fonts.mono(400), fontSize: 12, lineHeight: 18 },
  rule: { height: 1, marginVertical: 2 },
});

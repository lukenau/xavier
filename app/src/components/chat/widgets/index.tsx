// One `widget` part, drawn.
//
// Everything reaching here was written by the agent at run time, so the parse
// is the boundary: `parseWidget` returns null for anything this build cannot
// draw and this file says so in one quiet line rather than leaving a hole in
// the transcript. A widget that renders nothing is indistinguishable from a
// dropped message, which is the worse failure.
import { StyleSheet, Text } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { parseWidget, type ClarifyWidget as ClarifyWidgetT } from '../../../chat/widget';
import { selectClarifyAnswered, useChatStore } from '../../../chat/store';
import type { WidgetPart } from '../../../chat/types';
import { api } from '../../../lib/api';
import { ButtonRowWidget } from './ButtonRowWidget';
import { CalendarWidget } from './CalendarWidget';
import { WeatherWidget } from './WeatherWidget';
import { CardWidget } from './CardWidget';
import { ChartWidget } from './ChartWidget';
import { ChecklistWidget } from './ChecklistWidget';
import { ClarifyWidget } from './ClarifyWidget';
import { FormWidget } from './FormWidget';
import { LinkWidget } from './LinkWidget';
import { MetricWidget } from './MetricWidget';
import { PollWidget } from './PollWidget';
import { ProductWidget } from './ProductWidget';
import { CartWidget } from './CartWidget';
import { OrderWidget } from './OrderWidget';
import { ProgressWidget } from './ProgressWidget';
import { TableWidget } from './TableWidget';
import { TimelineWidget } from './TimelineWidget';

export function WidgetPartView({
  part,
  threadId,
  messageId,
  partIndex,
}: {
  part: WidgetPart;
  threadId: string;
  messageId?: string;
  partIndex?: number;
}) {
  const { t } = useTheme();
  const widget = parseWidget(part);

  if (!widget) {
    return (
      <Text style={[styles.fallback, { color: t('status-warn') }]}>
        {part.kind ? `Could not draw this ${part.kind}` : 'Could not draw this widget'}
      </Text>
    );
  }

  switch (widget.kind) {
    case 'clarify':
      return <ClarifyPart widget={widget} threadId={threadId} />;
    case 'card':
      return <CardWidget widget={widget} />;
    case 'metric':
      return <MetricWidget widget={widget} />;
    case 'chart':
      return <ChartWidget widget={widget} />;
    case 'table':
      return <TableWidget widget={widget} />;
    case 'progress':
      return <ProgressWidget widget={widget} />;
    case 'link':
      return <LinkWidget widget={widget} />;
    case 'button_row':
      // Answering back to the agent needs a route hub-api does not have yet, so
      // the buttons render disabled rather than pretending to send.
      return <ButtonRowWidget widget={widget} />;
    case 'poll':
      // No vote route either — same rule as button_row.
      return <PollWidget widget={widget} />;
    case 'checklist':
      return (
        <ChecklistWidget
          widget={widget}
          threadId={threadId}
          messageId={messageId}
          partIndex={partIndex}
        />
      );
    case 'calendar':
      return <CalendarWidget widget={widget} />;
    case 'timeline':
      return <TimelineWidget widget={widget} />;
    case 'weather':
      return <WeatherWidget widget={widget} />;
    case 'form':
      return <FormWidget widget={widget} />;
    case 'product':
      return <ProductWidget widget={widget} />;
    case 'cart':
      return <CartWidget widget={widget} />;
    case 'order':
      return <OrderWidget widget={widget} />;
  }
}

/** The answer's failure is the card's to show, so the promise is handed back
 * rather than swallowed; `resolved` is the server's word, which outlives any
 * remount of the card. */
function ClarifyPart({ widget, threadId }: { widget: ClarifyWidgetT; threadId: string }) {
  const resolved = useChatStore(selectClarifyAnswered(threadId, widget.clarifyId));
  return (
    <ClarifyWidget
      widget={widget}
      resolved={resolved}
      onAnswer={(text) => api.chatAnswerClarify(widget.clarifyId, threadId, text)}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { fontFamily: fonts.sans(400), fontSize: 12.5 },
});

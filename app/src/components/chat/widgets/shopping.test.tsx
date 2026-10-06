// The three shopping kinds (product / cart / order) — parser rules AND the
// drawing. These were added to the app to match the gateway's catalog; the
// parser is the half that must agree with widget_tool.py, because a kind the
// tool accepts but this file rejects renders "could not draw this widget".
import TestRenderer, { act } from 'react-test-renderer';
import { Image, Text } from 'react-native';
import { parseWidget } from '../../../chat/widget';
import { POSES } from '../../../whimsy/poses';
import { ProductWidget } from './ProductWidget';
import { CartWidget } from './CartWidget';
import { OrderWidget } from './OrderWidget';
import { ShopImage } from './shopBits';

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) =>
    (Array.isArray(n.props.children) ? n.props.children : [n.props.children]).filter(
      (c: unknown): c is string => typeof c === 'string',
    ),
  );
}

/** Each Text node's children concatenated — so `×{qty}` reads as one token. */
function lines(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) =>
    (Array.isArray(n.props.children) ? n.props.children : [n.props.children])
      .filter((c: unknown) => typeof c === 'string' || typeof c === 'number')
      .join(''),
  );
}

const ITEMS = [
  { name: 'Demo kettle', price: '$18.03', qty: 1 },
  { name: 'Demo filters', price: '$6.40', qty: 3 },
];

test('a product part parses with its rich fields', () => {
  const w = parseWidget({
    kind: 'product',
    props: {
      title: 'Demo kettle', merchant: 'Demo Market', price: '$18.03', was: '$24.00',
      rating: 4.6, reviews: 218, eta: 'arrives Tue', url: 'https://example.com/kettle',
      image: 'https://example.com/kettle.jpg', badge: 'best seller', badge_tone: 'up',
    },
  });
  expect(w).not.toBeNull();
  expect(w).toMatchObject({
    kind: 'product', title: 'Demo kettle', merchant: 'Demo Market', price: '$18.03',
    was: '$24.00', rating: 4.6, reviews: 218, eta: 'arrives Tue', badge: 'best seller', badgeTone: 'up',
  });
});

test('a product needs a title; a cart and an order need at least one drawable row', () => {
  expect(parseWidget({ kind: 'product', props: { merchant: 'Demo Market' } })).toBeNull();
  expect(parseWidget({ kind: 'cart', props: { items: [] } })).toBeNull();
  // An order without its id, its total or its items is not a receipt.
  expect(parseWidget({ kind: 'order', props: { order_id: 'D-1', items: ITEMS } })).toBeNull();
  expect(parseWidget({ kind: 'order', props: { order_id: 'D-1', total: '$24.43' } })).toBeNull();
  expect(parseWidget({ kind: 'cart', props: { items: ITEMS, total: '$24.43' } })).not.toBeNull();
});

test('parser rules mirror the gateway: name + price required, money normalised, https only', () => {
  const w = parseWidget({
    kind: 'cart',
    props: {
      items: [
        { name: 'Demo kettle', price: 18.03 },        // a bare number -> "$18.03"
        { name: 'no price' },                          // dropped
        { price: '$1.00' },                            // dropped (no name)
        { name: 'Demo filters', price: '$6.40', image: 'http://insecure.example/f.jpg' },
      ],
      subtotal: 24.43, shipping: 0, total: 24.43,
      url: 'http://insecure.example/cart',
    },
  });
  expect(w).toMatchObject({ kind: 'cart' });
  if (w?.kind !== 'cart') throw new Error('unreachable');
  expect(w.items.map((i) => i.name)).toEqual(['Demo kettle', 'Demo filters']);
  expect(w.items[0].price).toBe('$18.03');
  expect(w.items[1].image).toBeNull();       // http is refused, not passed through
  expect(w.total).toBe('$24.43');
});

test('a drawn cart shows every row and the total', () => {
  const w = parseWidget({ kind: 'cart', props: { title: 'Demo Market', items: ITEMS, subtotal: '$24.43', total: '$26.10' } });
  if (w?.kind !== 'cart') throw new Error('unreachable');
  const tree = render(<CartWidget widget={w} />);
  const t = texts(tree);
  expect(t).toContain('Demo Market');
  expect(t).toContain('Demo kettle');
  expect(t).toContain('$18.03');
  expect(lines(tree)).toContain('×3');
  expect(t).toContain('$26.10');
});

test('a drawn order reads as a receipt — id, items, totals, fulfilment', () => {
  const w = parseWidget({
    kind: 'order',
    props: {
      order_id: 'DEMO-4471', placed: 'Sun 4 Oct', items: ITEMS, subtotal: '$24.43',
      shipping: '$0.00', tax: '$1.67', total: '$26.10', payment: 'Demo Card ·· 4242',
      address: '1 Demo Way, Demo City', eta: 'arrives Tue', url: 'https://example.com/order',
    },
  });
  if (w?.kind !== 'order') throw new Error('unreachable');
  const t = texts(render(<OrderWidget widget={w} />));
  expect(t).toContain('DEMO-4471');
  expect(t).toContain('$26.10');
  expect(t).toContain('Demo Card ·· 4242');
  expect(t).toContain('1 Demo Way, Demo City');
});

test('a drawn product shows its price, struck-through was-price and merchant', () => {
  const w = parseWidget({
    kind: 'product',
    props: { title: 'Demo kettle', merchant: 'Demo Market', price: '$18.03', was: '$24.00', rating: 4.6, reviews: 218 },
  });
  if (w?.kind !== 'product') throw new Error('unreachable');
  const t = texts(render(<ProductWidget widget={w} />)).join(' | ');
  expect(t).toContain('Demo kettle');
  expect(t).toContain('$18.03');
  expect(t).toContain('$24.00');
  expect(t).toContain('Demo Market');
  expect(t).toContain('218 reviews');
});

test('a missing photo draws a pose, not a hole', () => {
  const tree = render(<ShopImage uri={null} size={40} />);
  const img = tree.root.findAllByType(Image);
  const src = img[img.length - 1]?.props.source;
  expect(src).toEqual(POSES.portrait);
});

// #632: how to find "an element wearing a coloured left bar" — once, for every pin on this family.
//
// The bar has been drawn three different ways over this ticket's life: a `border-left`, an absolutely
// positioned `::before` strip, and now a background layer. Each time it changed, several pins went red
// for the same reason — they were looking for the mechanism rather than for the bar. Their assertions
// were still right; only their way of finding the subject was out of date.
//
// So the predicate lives here and answers all three. That is not leniency: a pin that cannot find the bar
// reports "nothing rendered" on a page where the bar is perfectly visible, which is the shape that makes
// a premise assertion the only thing standing between a broken pin and a green one.
export const HAS_LEFT_BAR = `((el) => {
  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, '::before');
  const w = (v) => parseFloat(v) || 0;
  // (1) a left border noticeably thicker than the other sides — the original mechanism, and still the
  //     defect this ticket is about when the box has rounded corners
  const border = w(cs.borderLeftWidth) >= 2 && w(cs.borderLeftWidth) > w(cs.borderRightWidth);
  // (2) a narrow child pinned to the left edge — the second mechanism
  const pseudo = before.content !== 'none' && before.position === 'absolute'
    && w(before.left) === 0 && w(before.width) > 0 && w(before.width) <= 12;
  // (3) a gradient that paints a hard-edged band at the left — the current one. Matched by shape (a
  //     to-right gradient whose first stop ends within a bar's width) rather than by the exact text, so
  //     the colour and the token can change without this going blind.
  const img = cs.backgroundImage || '';
  const grad = /linear-gradient\\(\\s*to right/.test(img) && /\\b(\\d+(?:\\.\\d+)?)px/.test(img)
    && parseFloat((img.match(/\\b(\\d+(?:\\.\\d+)?)px/) || [])[1] || '99') <= 12;
  return border ? 'border' : pseudo ? 'pseudo' : grad ? 'background' : null;
})`;

/** The bar's painted width, whichever way it is drawn (0 when there is no bar). */
export const LEFT_BAR_WIDTH = `((el) => {
  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, '::before');
  const w = (v) => parseFloat(v) || 0;
  if (w(cs.borderLeftWidth) >= 2) return w(cs.borderLeftWidth);
  if (before.content !== 'none' && before.position === 'absolute' && w(before.left) === 0) return w(before.width);
  const m = (cs.backgroundImage || '').match(/\\b(\\d+(?:\\.\\d+)?)px/);
  return m ? parseFloat(m[1]) : 0;
})`;

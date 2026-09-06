/**
 * Flags a `className` where two utilities set the same CSS property under the
 * same variant.
 *
 * Tailwind resolves such a pair by the order the utilities appear in the
 * generated stylesheet, NOT by the order they appear in the string — so one of
 * them is silently dropped and the rendered result does not match what the code
 * says. Three such pairs shipped before this rule existed, all the same slip: a
 * light/dark hover pair where only the light half got the `hover:` prefix, so
 * `dark:bg-x` overrode the base colour instead of applying on hover. The result
 * was buttons with no hover feedback at all, and one permanently painted its
 * hover shade.
 *
 * Written here rather than pulled from eslint-plugin-tailwindcss: that plugin's
 * `no-contradicting-classname` reports without a node when the conflict sits
 * inside a conditional expression, which ESLint 10 asserts against — so on the
 * exact shape that caused the bug here (a ternary branch inside a template
 * literal) it crashes the whole lint run instead of reporting. It also pins a
 * tailwindcss peer, which this repo would have to keep in step.
 *
 * Scope is deliberately narrow — colour utilities only. Those are where the
 * variant slips happen, and widening it to every utility family invites false
 * positives (`text-sm` and `text-gray-500` share a prefix but not a property).
 */

// A Tailwind colour value: a palette entry with optional opacity, a keyword, or
// an arbitrary hex/rgb/hsl. Deliberately NOT matching `[11px]`-style arbitrary
// values, which are sizes rather than colours.
const COLOR = /^(?:[a-z]+-\d{2,3}(?:\/\d+)?|white|black|transparent|current|inherit|\[#[0-9a-fA-F]{3,8}\]|\[(?:rgb|hsl)a?\([^\]]*\)\])$/;

// bg-* utilities that are not background-color (background-image, -clip,
// -position, -size, -repeat, ...). Without this, `bg-clip-text bg-gradient-to-r`
// reads as a conflict.
const BG_NON_COLOR = /^(?:clip|gradient|none|opacity|blend|fixed|local|scroll|center|top|bottom|left|right|repeat|no-repeat|cover|contain|auto|origin|\[url)/;

const propertyOf = (utility) => {
  if (utility.startsWith('bg-')) {
    const value = utility.slice(3);
    return !BG_NON_COLOR.test(value) && COLOR.test(value) ? 'background-color' : null;
  }
  if (utility.startsWith('text-')) return COLOR.test(utility.slice(5)) ? 'color' : null;
  if (utility.startsWith('border-')) {
    const rest = utility.slice(7);
    // A directional side (t/b/l/r/x/y plus the logical s/e) is its own
    // property -- border-t-red-500 and border-l-red-500 don't conflict, only
    // two utilities naming the SAME side do.
    const dirMatch = rest.match(/^([tblrxyse])-(.*)$/);
    if (dirMatch) return COLOR.test(dirMatch[2]) ? `border-${dirMatch[1]}-color` : null;
    return COLOR.test(rest) ? 'border-color' : null;
  }
  return null;
};

const splitClasses = (text) => text.split(/\s+/).filter(Boolean);

/** The conflicting pairs in one set of classes that all apply together. */
const conflictsIn = (classes) => {
  const seen = new Map();
  const found = [];
  for (const cls of classes) {
    const boundary = cls.lastIndexOf(':');
    const variant = boundary === -1 ? '' : cls.slice(0, boundary);
    const utility = boundary === -1 ? cls : cls.slice(boundary + 1);
    const property = propertyOf(utility);
    if (!property) continue;
    const key = `${variant}|${property}`;
    if (seen.has(key)) found.push({ variant, property, first: seen.get(key), second: cls });
    else seen.set(key, cls);
  }
  return found;
};

/**
 * The sets of classes that can be on the element at once.
 *
 * A ternary contributes one set per branch rather than one containing both:
 * only one branch is ever applied, so two branches naming the same property is
 * the point, not a conflict. Everything outside the conditionals is in every
 * set, which is what catches a base colour conflicting with a branch's.
 */
// Shared by both the template-literal branch below and the bare-conditional
// one: walks a Conditional/Logical tree collecting one alternative per string
// literal it bottoms out at. Anything else it bottoms out at (an identifier,
// a call, a member expression) contributes nothing -- this rule only
// understands string literals and the conditionals branching between them.
const collectAlternatives = (expr, alternatives) => {
  if (!expr) return;
  if (expr.type === 'Literal' && typeof expr.value === 'string') alternatives.push(splitClasses(expr.value));
  else if (expr.type === 'ConditionalExpression') { collectAlternatives(expr.consequent, alternatives); collectAlternatives(expr.alternate, alternatives); }
  else if (expr.type === 'LogicalExpression') { collectAlternatives(expr.left, alternatives); collectAlternatives(expr.right, alternatives); }
};

const classSetsOf = (node) => {
  if (node.type === 'Literal' && typeof node.value === 'string') return [splitClasses(node.value)];
  if (node.type !== 'JSXExpressionContainer') return [];

  const expression = node.expression;
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return [splitClasses(expression.value)];
  }

  if (expression.type === 'TemplateLiteral') {
    const always = expression.quasis.flatMap(q => splitClasses(q.value.cooked ?? ''));
    const alternatives = [];
    expression.expressions.forEach(expr => collectAlternatives(expr, alternatives));

    return alternatives.length ? alternatives.map(alt => [...always, ...alt]) : [always];
  }

  // A bare ternary/`&&` outside any template literal --
  // `className={cond ? 'a' : 'b'}` -- contributes one set per branch, same as
  // a conditional nested inside a template literal, just with no `always`
  // classes surrounding it. Everything else (an identifier, a call, a member
  // expression -- e.g. a classnames() helper) stays unchecked, same as before.
  if (expression.type === 'ConditionalExpression' || expression.type === 'LogicalExpression') {
    const alternatives = [];
    collectAlternatives(expression, alternatives);
    return alternatives.map(alt => [...alt]);
  }

  return [];
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow two Tailwind utilities that set the same CSS property under the same variant, since only one of them applies',
    },
    schema: [],
    messages: {
      conflict:
        '"{{first}}" and "{{second}}" both set {{property}}{{variantNote}}. Tailwind applies only one of them, chosen by stylesheet order{{suggestionNote}}',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'className' || !node.value) return;
        const reported = new Set();
        for (const classes of classSetsOf(node.value)) {
          for (const { variant, property, first, second } of conflictsIn(classes)) {
            const signature = `${first}|${second}`;
            if (reported.has(signature)) continue;
            reported.add(signature);
            // The overwhelmingly common cause is a missing state prefix on the
            // second half of a light/dark pair, so name the likely intent --
            // unless the variant already has `hover`, in which case there's no
            // prefix left to add and the real fix is to drop one of the two
            // (a variant of just "hover:bg-x hover:bg-y" is already the state
            // it would suggest, not a light/dark pair missing one).
            const utility = second.slice(second.lastIndexOf(':') + 1);
            const hasHover = variant !== '' && variant.split(':').includes('hover');
            const suggestion = variant ? `${variant}:hover:${utility}` : `hover:${utility}`;
            const suggestionNote = hasHover
              ? ' — remove one of them.'
              : ` — did you mean "${suggestion}"?`;
            context.report({
              node: node.value,
              messageId: 'conflict',
              data: {
                first,
                second,
                property,
                variantNote: variant ? ` under "${variant}"` : '',
                suggestionNote,
              },
            });
          }
        }
      },
    };
  },
};

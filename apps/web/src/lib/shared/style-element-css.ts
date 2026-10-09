/**
 * Workspace-controlled CSS (the custom CSS setting and the branding theme
 * values) reaches the page as the raw text of a `<style>` element, through
 * `dangerouslySetInnerHTML`. HTML does not parse that text as CSS first: the
 * tokenizer ends a `<style>` element at the first `</style` it meets, in any
 * ASCII letter case, so a stored value containing it closes the element early
 * and whatever follows is parsed as markup, including a `<script>`.
 *
 * Only that sequence is neutralised. A blanket escape of every `<` would
 * break valid stylesheets: media and container query range syntax
 * (`@media (width < 600px)`) uses a bare `<` outside any string, and an
 * escaped `\3c` there becomes an identifier instead of the comparison.
 */

/** The sequence that ends a `<style>` element, as the HTML tokenizer reads it. */
const STYLE_END_TAG = /<\/(style)/gi

/** True when `css` contains a `</style` sequence (any letter case). */
export function containsStyleEndTag(css: string): boolean {
  return /<\/style/i.test(css)
}

/**
 * Make `css` safe to use as the text of a `<style>` element.
 *
 * Each `</style` becomes `<\/style`, which the HTML tokenizer treats as plain
 * text. Inside a string or an unquoted `url()`, `\/` is an escaped `/`, so the
 * value decodes back to `</style`; inside a comment the text is ignored as
 * before. In any other position the sequence is either invalid CSS or, where
 * arbitrary tokens are accepted (a custom property value, for example), a
 * token run that never reached the page intact, because the HTML parser ended
 * the element there. The rewrite does change such a run (`\/style` is read as
 * one identifier), but a `<style>` element never handed the original run to
 * the CSS parser either.
 */
export function cssForStyleElement(css: string): string {
  return css.replace(STYLE_END_TAG, '<\\/$1')
}

/** Browser-only, DOM Range based rendered-line measurement. Imported by the CLI and real-browser tests.
 * Rectangles approximate glyph advance extents, not raster ink. No DOM mutation or layout correction.
 */
export async function collectRenderedText({ policy, selector, stress = false } = {}) {
  await document.fonts.ready;
  const profiles = policy?.profiles;
  if (!profiles?.headline || !profiles?.['short-copy'] || !profiles?.prose) throw new Error('Missing canonical text-quality profiles');
  for (const key of ['headline','short-copy','prose']) {
    const p=profiles[key];
    if (!Number.isFinite(p.minimumLastLineRatio) || p.minimumLastLineRatio <= 0 || p.minimumLastLineRatio > 1 || typeof p.forbidSingleWordFinalLine !== 'boolean' || !['fail','review'].includes(p.disposition)) throw new Error(`Invalid text-quality profile: ${key}`);
  }
  const select = selector || 'h1,h2,h3,h4,h5,h6,p,blockquote,.ds-card__body,.ds-stat__lead,.ds-announce__copy,.ds-docs-pagination__sublabel,.ds-docs-pagination__label,button,summary,label,legend,figcaption,li,th,td,a,[role=button],[data-text-profile]';
  const visible = e => {
    if (e.checkVisibility && !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true})) return false;
    for (let a=e;a;a=a.parentElement) {
      const style=getComputedStyle(a);
      if (style.display==='none' || style.visibility!=='visible' || style.opacity==='0') return false;
      if (a.localName==='details' && !a.open) { const summary=Array.from(a.children).find(n=>n.localName==='summary'); if(e!==a && (!summary || !summary.contains(e))) return false; }
    }
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility === 'visible' && s.opacity !== '0' && !e.closest('.ds-sr-only,.sr-only');
  };
  const locator = e => {
    if (e.id) return `#${CSS.escape(e.id)}`;
    const parts = [];
    while (e && e !== document.body) {
      const tag = e.localName;
      const siblings = Array.from(e.parentElement?.children || []).filter(n => n.localName === tag);
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(e) + 1})` : ''}`);
      e = e.parentElement;
    }
    return `body > ${parts.join(' > ')}`;
  };
  const output = [];
  const measuredNodes = new Set();
  const literal = 'script,style,svg,pre,code,kbd,samp,textarea,select,option,progress,meter,.ds-docs-anchor,.logo-word,.ds-stat__value';
  const eligibleNode = node => {
    const p=node.parentElement;
    return p && visible(p) && !p.closest(literal) && /[\p{L}\p{N}]/u.test(node.textContent);
  };
  const candidates = new Set(document.querySelectorAll(select));
  // A simple visible text-only div/span is still copy. Rich composite containers are
  // checked below for unmeasured fragments instead of flattening independent blocks.
  if (!selector) for (const e of document.querySelectorAll('div,span')) {
    if (!visible(e) || e.closest(literal)) continue;
    if (!Array.from(e.childNodes).some(n=>n.nodeType===Node.TEXT_NODE && eligibleNode(n))) continue;
    candidates.add(e);
  }
  const blocks = 'h1,h2,h3,h4,h5,h6,p,blockquote,li,th,td,button,summary,figcaption,label';
  for (const element of candidates) {
    if (!visible(element) || element.matches('.ds-stat')) continue;
    // Measure each independent inline run; nested blocks receive their own records.
    const composite=Array.from(element.querySelectorAll(blocks+',.ds-announce__copy,.ds-docs-pagination__sublabel,.ds-docs-pagination__label')).some(visible);
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
    const locale = element.closest('[lang]')?.lang || document.documentElement.lang || 'en';
    const profile = element.dataset.textProfile || (/^H[1-6]$/.test(element.tagName) ? 'headline' : element.matches('p,blockquote') && element.closest('.ds-prose,.ds-docs-content,.ds-docs-article') && !element.matches('.ds-hero__lead,.ds-card__body') ? 'prose' : 'short-copy');
    const rule = profiles[profile];
    if (!rule) throw new Error(`Unknown text profile: ${profile}`);
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => {
      const p = node.parentElement;
      if (!p || p.closest('script,style,svg,.ds-docs-anchor,.logo-word') || !visible(p)) return NodeFilter.FILTER_REJECT;
      for(let a=p;a!==element;a=a.parentElement) {
        if(!a || (composite && (a.matches(blocks+',.ds-announce__copy,.ds-docs-pagination__sublabel,.ds-docs-pagination__label') || !['inline','contents'].includes(getComputedStyle(a).display)))) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }});
    while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: text.length }); text += walker.currentNode.textContent; }
    if (!text.trim() || nodes.every(({node})=>measuredNodes.has(node))) continue;
    // A code-only block is a literal identifier, not editorial copy. Preserve its exact spelling.
    if (element.querySelector('code') && Array.from(element.querySelectorAll('code')).map(e=>e.textContent).join('').trim() === text.trim()) continue;
    for (const {node} of nodes) measuredNodes.add(node);
    const words = Array.from(new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)).filter(s => s.isWordLike);
    const glyphs = [];
    for (const { node, start } of nodes) for (const segment of new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(node.textContent)) {
      if (!segment.segment.trim()) continue;
      const range = document.createRange();
      range.setStart(node, segment.index); range.setEnd(node, segment.index + segment.segment.length);
      const rect = Array.from(range.getClientRects()).find(r => r.width > 0 && r.height > 0);
      if (rect) glyphs.push({ start: start + segment.index, end: start + segment.index + segment.segment.length, text: segment.segment, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    }
    const groups = [];
    const tolerance = Math.max(2, parseFloat(style.fontSize) * 0.45);
    for (const glyph of glyphs) {
      const center = (glyph.top + glyph.bottom) / 2;
      let line = groups.find(l => Math.abs(l.center - center) < tolerance);
      if (!line) { line = { center, glyphs: [] }; groups.push(line); }
      line.glyphs.push(glyph);
    }
    const lines = groups.sort((a,b) => a.center - b.center).map(group => {
      const gs = group.glyphs, start = Math.min(...gs.map(g=>g.start)), end = Math.max(...gs.map(g=>g.end));
      return { text: text.slice(start,end).replace(/\s+/g,' ').trim(), width: +(Math.max(...gs.map(g=>g.right))-Math.min(...gs.map(g=>g.left))).toFixed(2), wordCount: words.filter(w => w.index < end && w.index+w.segment.length > start).length };
    });
    const last = lines.at(-1), longest = Math.max(0,...lines.slice(0,-1).map(l=>l.width));
    const ratio = longest ? +(last.width / longest).toFixed(4) : null;
    const reasons = [];
    if (lines.length > 1) {
      if (ratio < rule.minimumLastLineRatio) reasons.push(`Final line occupies ${Math.round(ratio*100)}% of the widest preceding line; minimum ${Math.round(rule.minimumLastLineRatio*100)}%.`);
      if (rule.forbidSingleWordFinalLine && last.wordCount === 1) reasons.push('Isolated final word.');
    }
    const declaredReason = element.closest('[data-text-review-reason]')?.dataset.textReviewReason || null;
    const origin = element.closest('[data-text-origin]')?.dataset.textOrigin || 'authored';
    const reviewReasons = [];
    if (reasons.length && (rule.disposition === 'review' || profile === 'prose')) reviewReasons.push('Long prose requires editorial review; never force-fill the line.');
    if (reasons.length && stress) reviewReasons.push('Accessibility text-spacing stress: legibility, reflow, and full content take precedence.');
    if (reasons.length && origin !== 'authored') reviewReasons.push(`${origin} content: preserve meaning and review the available composition.`);
    if (reasons.length && declaredReason) reviewReasons.push(declaredReason);
    for (let ancestor=element;ancestor;ancestor=ancestor.parentElement) {
      const s=getComputedStyle(ancestor);
      if ((Number(s.columnCount)>1 || s.columnWidth!=='auto') && (ancestor===element || element.getClientRects().length>1)) { reviewReasons.push('Multi-column text requires manual fragment and terminal-line review.'); break; }
    }
    if (style.writingMode !== 'horizontal-tb') reviewReasons.push('Vertical writing requires manual line-composition review.');
    const overflow = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
    if (overflow) reasons.push('Text container overflows horizontally; inspect clipping and access to full content.');
    const status = overflow ? 'FAIL' : reviewReasons.length ? 'NEEDS_REVIEW' : reasons.length ? 'FAIL' : 'PASS';
    output.push({ selector: locator(element), profile, origin, text: text.replace(/\s+/g,' ').trim(), status, reasons, reviewReasons, lines, lastLineRatio: ratio, minimumLastLineRatio: rule.minimumLastLineRatio, containerWidth: +bounds.width.toFixed(2), fontSize: style.fontSize, fontFamily: style.fontFamily, textWrap: style.textWrap, direction: style.direction, locale, overflow });
  }
  const unmeasuredText = [];
  if (!selector) {
    const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const byElement=new Map();
    while(walk.nextNode()) {
      const node=walk.currentNode;
      if (!eligibleNode(node) || measuredNodes.has(node)) continue;
      const e=node.parentElement;
      const old=byElement.get(e)||'';byElement.set(e,old+node.textContent);
    }
    for(const [e,text] of byElement) unmeasuredText.push({selector:locator(e),text:text.replace(/\s+/g,' ').trim(),status:'NEEDS_REVIEW',reason:'Visible text is outside a confidently measured text block. Give its complete semantic block an explicit data-text-profile or review this composite text layout.'});
  }
  return { unmeasuredText, fonts: Array.from(document.fonts).map(f=>({family:f.family,status:f.status})), loadedFonts: document.fonts.status, viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, elements: output };
}

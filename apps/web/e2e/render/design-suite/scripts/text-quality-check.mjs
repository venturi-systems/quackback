/** Read-only browser quality gate. Examples:
 * node scripts/text-quality-check.mjs --output TEST-RESULTS/text-quality.json
 * node scripts/text-quality-check.mjs --url https://example.test/ --width 390 --width 1440 --text-spacing --output review.json
 * --strict-review also exits nonzero for unresolved NEEDS_REVIEW results. No flag suppresses a FAIL.
 * Set DESIGN_TEST_DEPENDENCIES to a node_modules directory containing Playwright;
 * optionally BROWSER_EXECUTABLE to a compatible Chromium executable.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { collectRenderedText } from './text-quality-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args = process.argv.slice(2), urls = [], widths = [];
let out = path.join(root,'TEST-RESULTS/text-quality.json'), selector, spacing = false, strict = false;
for (let i=0;i<args.length;i++) {
  const a=args[i];
  if (a==='--url') urls.push(args[++i]); else if(a==='--width') widths.push(Number(args[++i]));
  else if(a==='--output') out=path.resolve(args[++i]); else if(a==='--selector') selector=args[++i];
  else if(a==='--text-spacing') spacing=true; else if(a==='--strict-review') strict=true;
  else throw new Error(`Unknown argument: ${a}`);
}
if (widths.some(w=>!Number.isInteger(w)||w<240||w>7680)) throw new Error('Viewport widths must be integers from 240 to 7680');
if (!widths.length) widths.push(320,390,600,768,1024,1440,1920,2560);
const policyBytes=fs.readFileSync(path.join(root,'SOURCE/quality-policy.json'));
const policy=JSON.parse(policyBytes);
const dependencies=process.env.DESIGN_TEST_DEPENDENCIES||process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
if(!dependencies) throw new Error('Set DESIGN_TEST_DEPENDENCIES to a node_modules directory containing Playwright');
const require=createRequire(path.join(path.resolve(dependencies),'package.json'));
const {chromium}=require('playwright');
// document.fonts.ready only waits for attempted loads; an undeclared/missing
// family can silently render its fallback while FontFaceSet reports "loaded".
// Chromium's actual rendered-font evidence verifies the requested primary face.
// Common platform stacks may intentionally select a declared system fallback.
const normalizeFamily=value=>String(value).replace(/^['"]|['"]$/g,'').replace(/\s+\d+(?:\.\d+)?pt$/i,'').replace(/[\s_-]/g,'').toLowerCase();
const genericFamilies=new Set(['serif','sansserif','monospace','cursive','fantasy','systemui','uiserif','uisansserif','uimonospace','uirounded','emoji','math','fangsong']);
const platformFamilies=new Set(['arial','helvetica','helveticaneue','timesnewroman','times','georgia','verdana','tahoma','trebuchetms','couriernew','courier','sfmonoregular','menlo','monaco','consolas','liberationmono','liberationsans','liberationserif','dejavusansmono','dejavusans','dejavuserif','segoeui','roboto','applesystem','blinkmacsystemfont']);
function assessFontRun(fontFamily,renderedFonts,declaredFaces){
  const familyStack=fontFamily.split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map(value=>value.trim().replace(/^['"]|['"]$/g,''));
  const first=normalizeFamily(familyStack[0]);
  const loadedFaces=declaredFaces.filter(face=>normalizeFamily(face.family)===first && face.status==='loaded');
  const primaryUsed=renderedFonts.some(font=>normalizeFamily(font.familyName)===first);
  const customDeclared=declaredFaces.some(face=>normalizeFamily(face.family)===first);
  let status='NEEDS_REVIEW',verification='unverified',reason;
  if(!renderedFonts.length)reason='No actual rendered-font evidence is available for this text run.';
  else if(customDeclared && loadedFaces.length && primaryUsed){status='PASS';verification='loaded-custom-primary-used';}
  else if(customDeclared)reason='The declared primary font did not both load and appear in the actual rendered-font evidence.';
  else if(primaryUsed){status='PASS';verification='installed-primary-used';}
  else if(genericFamilies.has(first)){status='PASS';verification='browser-selected-generic-family';}
  else if(platformFamilies.has(first) && (renderedFonts.some(font=>familyStack.slice(1).some(family=>normalizeFamily(family)===normalizeFamily(font.familyName))) || (familyStack.some(family=>genericFamilies.has(normalizeFamily(family))) && renderedFonts.every(font=>!font.isCustomFont)))){
    status='PASS';verification='browser-selected-platform-stack';
  }else reason='The requested primary family is absent from actual rendered-font evidence; a fallback rendered instead. Verify or correct the intended font.';
  return{status,requestedPrimary:familyStack[0],familyStack,loadedFaces,renderedFonts,verification,...(reason?{reason}:{})};
}
async function verifyRenderedFonts(page,result){
  let session;const checks=[];
  try{
    session=await page.context().newCDPSession(page);
    await session.send('DOM.enable');await session.send('CSS.enable');
    const {root:documentNode}=await session.send('DOM.getDocument');
    const nodeCache=new Map();
    function actualRun(nodeId){
      if(!nodeCache.has(nodeId))nodeCache.set(nodeId,(async()=>{
        const {node}=await session.send('DOM.describeNode',{nodeId,depth:1});
        if(!node.children?.some(child=>child.nodeType===3 && /[\p{L}\p{N}]/u.test(child.nodeValue||'')))return null;
        const {fonts}=await session.send('CSS.getPlatformFontsForNode',{nodeId});
        const renderedFonts=fonts.filter(font=>font.glyphCount>0);
        if(!renderedFonts.length)return null;
        const {computedStyle}=await session.send('CSS.getComputedStyleForNode',{nodeId});
        const family=computedStyle.find(property=>property.name==='font-family')?.value;
        if(!family)return{status:'NEEDS_REVIEW',verification:'unverified',renderedFonts,reason:'Computed font family could not be obtained for actual rendered text.'};
        return assessFontRun(family,renderedFonts,result.fonts);
      })());
      return nodeCache.get(nodeId);
    }
    for(const element of result.elements){
      try{
        const {nodeId}=await session.send('DOM.querySelector',{nodeId:documentNode.nodeId,selector:element.selector});
        const {nodeIds}=nodeId?await session.send('DOM.querySelectorAll',{nodeId,selector:'*'}):{nodeIds:[]};
        // Container font evidence can aggregate inline descendants or contain no
        // glyphs for a wrapper. Inspect each text-bearing descendant against its
        // own computed family: a link can intentionally use another
        // font than its list-item wrapper, and a broken inline font must not be
        // hidden by one correctly rendered parent text run.
        const runs=await Promise.all((nodeId?[nodeId,...nodeIds]:[]).map(async(id,index)=>{
          const run=await actualRun(id);return run?{relativeElementIndex:index-1,...run}:null;
        }));
        const fontRuns=runs.filter(Boolean),unique=new Map();
        for(const run of fontRuns)for(const font of run.renderedFonts){
          const key=JSON.stringify([font.familyName,font.postScriptName,font.isCustomFont]);
          const previous=unique.get(key);unique.set(key,{...font,glyphCount:Math.max(font.glyphCount,previous?.glyphCount||0)});
        }
        const failed=fontRuns.filter(run=>run.status!=='PASS');
        checks.push({selector:element.selector,status:fontRuns.length&&!failed.length?'PASS':'NEEDS_REVIEW',computedBlockFamily:element.fontFamily,verification:'actual-font-runs-with-own-computed-family',renderedFonts:[...unique.values()],fontRuns,...(!fontRuns.length?{reason:'No actual rendered-font evidence is available for this measured text block.'}:failed.length?{reason:failed.map(run=>run.reason).join(' ')}:{})});
      }catch(error){checks.push({selector:element.selector,status:'NEEDS_REVIEW',verification:'unverified',reason:'Actual rendered-font verification could not complete: '+error.message});}
    }
  }catch(error){checks.push({selector:null,status:'NEEDS_REVIEW',verification:'unverified',reason:'Actual rendered-font verification is unavailable: '+error.message});}
  finally{await session?.detach();}
  return checks;
}

let server;
const sources=[];
if(!urls.length){
  server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{const ext=path.extname(file), mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};res.setHeader('Content-Type',mime[ext]||'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir='IMPLEMENTATION/GENERAL-REFERENCE/examples';
  for(const name of fs.readdirSync(path.join(root,dir)).filter(n=>n.endsWith('.html')).sort()){
    sources.push(`${dir}/${name}`);urls.push(`http://127.0.0.1:${server.address().port}/${dir}/${name}`);
  }
}
const runs=[];let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:['--no-sandbox','--disable-gpu']});
  for(let i=0;i<urls.length;i++)for(const width of widths)for(const stress of spacing?[false,true]:[false]){
    const context=await browser.newContext({viewport:{width,height:900},locale:'en-US',reducedMotion:'reduce'});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('requestfailed',r=>{if(['font','stylesheet'].includes(r.resourceType()))errors.push(`Critical resource request failed: ${r.url()}`);});
    page.on('response',r=>{if(['font','stylesheet'].includes(r.request().resourceType())&&r.status()>=400)errors.push(`Critical resource response ${r.status()}: ${r.url()}`);});
    const response = await page.goto(urls[i],{waitUntil:'networkidle'});
    const httpStatus = response?.status() || null;
    if (!httpStatus || httpStatus >= 400) errors.push(`Target document response: ${httpStatus ?? 'unavailable'}`);
    await page.evaluate(()=>document.fonts.ready);
    if(stress)await page.addStyleTag({content:'body * { line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important } p { margin-block-end:2em!important }'});
    const result=await page.evaluate(collectRenderedText,{policy,selector,stress});
    const fontChecks=await verifyRenderedFonts(page,result);
    const fontFindings=fontChecks.filter(check=>check.status!=='PASS').map(check=>({...check,kind:'font-verification',reasons:[],reviewReasons:[check.reason]}));
    const unmeasuredFindings=(result.unmeasuredText||[]).map(item=>({...item,kind:'unmeasured-visible-text',reasons:[],reviewReasons:[item.reason]}));
    const findings=[...result.elements.filter(e=>e.status!=='PASS'),...fontFindings,...unmeasuredFindings];
    runs.push({source:sources[i]||urls[i],width,textSpacingStress:stress,httpStatus,finalURL:sources[i]||page.url(),...result,fontChecks,errors,findings});
    await context.close();
  }
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());}
const sourceInputs=[];
if(sources.length){
  const collect=dir=>{for(const ent of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const p=`${dir}/${ent.name}`;if(ent.isDirectory())collect(p);else if(ent.isFile()){const bytes=fs.readFileSync(path.join(root,p));sourceInputs.push({path:p,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}}};
  collect('IMPLEMENTATION/GENERAL-REFERENCE/examples');collect('IMPLEMENTATION/GENERAL-REFERENCE/dist');
}
const failures=runs.flatMap(r=>r.findings.filter(f=>f.status==='FAIL').map(f=>({source:r.source,width:r.width,stress:r.textSpacingStress,...f})));
const reviews=runs.flatMap(r=>r.findings.filter(f=>f.status==='NEEDS_REVIEW').map(f=>({source:r.source,width:r.width,stress:r.textSpacingStress,...f})));
const infrastructureFailures=runs.filter(r=>r.loadedFonts!=='loaded'||r.fonts.some(f=>f.status==='error')||!r.elements.length||r.elements.some(e=>e.overflow)||r.errors.length||r.documentWidth>r.width);
const status=failures.length||infrastructureFailures.length?'FAIL':reviews.length?'NEEDS_REVIEW':'PASS';
const toolInputs=['scripts/text-quality-check.mjs','scripts/text-quality-browser.mjs'].map(file=>({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}));
const report={schemaVersion:1,status,scope:'Rendered authored text on specified pages at the stated widths. Range rectangles approximate glyph advances, not raster ink. Font verification records Chromium actual font families and primary-face use, including platform-stack resolution; it does not establish glyph-by-glyph correctness or approve unintended fallback. Color, imagery, visual hierarchy, task usability and assistive technology require separate review. No guarantee for untested routes, states, fonts, copy, viewports or agent output.',selection:{selector:selector||null,coverage:selector?'Only the explicitly selected elements; omitted page text is not covered.':'Visible eligible text; any unmeasured text remains review-required.'},policySha256:crypto.createHash('sha256').update(policyBytes).digest('hex'),toolInputs,sourceInputs,runs,summary:{status,runs:runs.length,elements:runs.reduce((n,r)=>n+r.elements.length,0),failures:failures.length,needsReview:reviews.length,fontReviews:fontChecksCount(reviews),unmeasuredText:reviews.filter(review=>review.kind==='unmeasured-visible-text').length,infrastructureFailures:infrastructureFailures.length},failures,reviews};
function fontChecksCount(findings){return findings.filter(finding=>finding.kind==='font-verification').length;}
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report.summary,output:out}));
if(failures.length||infrastructureFailures.length||(strict&&reviews.length))process.exitCode=1;

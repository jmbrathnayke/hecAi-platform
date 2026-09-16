import { readFileSync } from "node:fs";
const src = readFileSync("tailwind.config.ts", "utf8");
const colors = {};
for (const m of src.matchAll(/["']?([a-z][\w-]*)["']?\s*:\s*["'](#[0-9A-Fa-f]{3,6}|rgba?\([^)]*\))["']/g)) {
  colors[m[1]] = m[2];
}
const srgb = c => { c/=255; return c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
const lum = h => { const s=h.replace("#",""); const f=s.length===3?s.split("").map(c=>c+c).join(""):s;
  return 0.2126*srgb(parseInt(f.slice(0,2),16))+0.7152*srgb(parseInt(f.slice(2,4),16))+0.0722*srgb(parseInt(f.slice(4,6),16)); };
const ratio = (a,b) => { const x=lum(a), y=lum(b); const [hi,lo]=x>y?[x,y]:[y,x]; return (hi+0.05)/(lo+0.05); };
const PAIRS = [
 ["ink-primary","surface-base",4.5],["ink-primary","surface-raised",4.5],["ink-primary","surface-tint",4.5],
 ["ink-secondary","surface-base",4.5],["ink-secondary","surface-raised",4.5],["ink-secondary","surface-tint",4.5],
 ["ink-on-dark","forest",4.5],["ink-on-amber","amber",4.5],["ink-on-dark","civic",4.5],
 ["forest","surface-raised",4.5],["forest","surface-base",4.5],["forest","forest-pale",4.5],
 ["status-error","status-error-pale",4.5],["status-error","surface-raised",4.5],
 ["status-success","surface-raised",4.5],["civic","civic-pale",4.5],["amber","amber-pale",4.5],
 ["border-strong","surface-raised",3],["border-strong","surface-base",3],
 ["border-focus","surface-raised",3],["forest","surface-raised",3],
 ["border-default","surface-raised",3],["border-default","surface-base",3],
];
let bad=0;
for (const [fg,bg,min] of PAIRS) {
  if (!colors[fg]||!colors[bg]) { console.log(`  ?? ${fg}/${bg} missing`); continue; }
  const r = ratio(colors[fg], colors[bg]);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`  ${ok?"PASS":"FAIL"}  ${(fg+"/"+bg).padEnd(34)} ${r.toFixed(2)}:1  (need ${min})  ${colors[fg]} on ${colors[bg]}`);
}
console.log(`\n${bad} failing pair(s)`);

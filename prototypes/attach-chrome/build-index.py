#!/usr/bin/env python3
"""Build the prototype attach page (#69).

Takes ttyd's stock index.html and applies two things:

1. A viewport meta tag. ttyd 1.7.7 ships none, so a phone lays the page out
   at ~980 CSS px and scales it down — that is the "even worse on mobile"
   half of the complaint, and it is a baseline fix, not a variant.
2. The chrome bundle in chrome.html: three variants plus the switcher.

Usage:  ./build-index.py index-orig.html index-proto.html
"""
import io
import os
import sys

src, dst = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
html = io.open(src, encoding="utf-8").read()
chrome = io.open(os.path.join(here, "chrome.html"), encoding="utf-8").read()

VIEWPORT = ('<meta name="viewport" content="width=device-width,initial-scale=1,'
            'maximum-scale=1,viewport-fit=cover">')

# Runs in <head>, ahead of ttyd's inline bundle — the only point at which the
# app's WebSocket can be observed. Feeds the ?diag=1 strip. Prototype only.
PRESCRIPT = """<script>
window.__diag={ws:[],err:[]};
addEventListener('error',function(e){
  window.__diag.err.push((e.message||e.type)+' @'+(e.filename||'')+':'+(e.lineno||''));
});
addEventListener('unhandledrejection',function(e){
  window.__diag.err.push('reject: '+((e.reason&&e.reason.message)||e.reason));
});
(function(){
  var W=window.WebSocket, n=0;
  function P(u,p){
    var s=p?new W(u,p):new W(u);
    window.__diag.ws.push('new '+u+(p?' ['+p+']':''));
    s.addEventListener('open',function(){window.__diag.ws.push('open')});
    s.addEventListener('error',function(){window.__diag.ws.push('ERROR')});
    s.addEventListener('close',function(e){
      window.__diag.ws.push('close code='+e.code+' clean='+e.wasClean+(e.reason?' "'+e.reason+'"':''));
    });
    s.addEventListener('message',function(){n++; if(n<4||n%100===0) window.__diag.ws.push('msg#'+n)});
    return s;
  }
  P.prototype=W.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){P[k]=W[k]});
  window.WebSocket=P;
})();
</script>"""

marker = "</head>"
pos = html.find(marker)
assert pos != -1, "no </head>"
head_add = PRESCRIPT + ("" if 'name="viewport"' in html else VIEWPORT)
html = html[:pos] + head_add + html[pos:]

# anchored at the LAST occurrence — the minified inline bundle can contain the
# marker string, and a global replace would corrupt it (same care as spike #32)
marker = "</body></html>"
pos = html.rfind(marker)
assert pos != -1, "marker missing"
html = html[:pos] + chrome + html[pos:]

io.open(dst, "w", encoding="utf-8").write(html)
print("wrote", dst, len(html), "bytes")

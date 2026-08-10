#!/usr/bin/env python3
"""Inject a touch key-bar into ttyd's stock index.html (spike #32)."""
import io, sys

src, dst = sys.argv[1], sys.argv[2]
html = io.open(src, encoding="utf-8").read()

SNIPPET = """
<style>
#keybar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;gap:4px;
padding:4px 6px calc(4px + env(safe-area-inset-bottom));background:#1a1a1a;border-top:1px solid #333;
font-family:monospace}
#keybar button{flex:1;min-width:0;padding:10px 2px;font-size:14px;background:#2a2a2a;color:#ddd;
border:1px solid #444;border-radius:6px;font-family:inherit;touch-action:manipulation}
#keybar button.hit{background:#454545}
@media (pointer:fine){#keybar{display:none}} /* desktop: hide */
</style>
<div id="keybar">
<button data-k="Escape:27">Esc</button>
<button data-k="Tab:9">Tab</button>
<button data-k="Tab:9:shift">⇧Tab</button>
<button data-k="ArrowUp:38">↑</button>
<button data-k="ArrowDown:40">↓</button>
<button data-k="c:67:ctrl">^C</button>
<button data-k="Enter:13">⏎</button>
</div>
<script>
(function(){
  var bar=document.getElementById('keybar');
  function target(){return document.querySelector('.xterm-helper-textarea');}
  // preventDefault keeps terminal focus but kills :active — fake it with a class
  bar.addEventListener('pointerdown',function(e){
    e.preventDefault();
    var b=e.target.closest('button');
    if(b){b.classList.add('hit');setTimeout(function(){b.classList.remove('hit');},150);}
  },true);
  bar.addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b) return;
    var p=b.dataset.k.split(':'), t=target(); if(!t) return;
    t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown',{key:p[0],keyCode:+p[1],which:+p[1],
      shiftKey:p[2]==='shift',ctrlKey:p[2]==='ctrl',bubbles:true,cancelable:true}));
  });
  // keep the bar above the virtual keyboard (visual viewport tracking)
  if(window.visualViewport){
    var vv=window.visualViewport;
    var fix=function(){
      // clamp: negative offsets (resizes-content mode, mid-animation) → invalid CSS
      var off=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
      bar.style.transform='translateY(-'+off+'px)';
    };
    vv.addEventListener('resize',fix); vv.addEventListener('scroll',fix); fix();
  }
})();
</script>
"""

# anchored single replacement at the LAST occurrence — the minified inline JS
# bundle could contain the marker string, and a global replace would corrupt it
marker = "</body></html>"
pos = html.rfind(marker)
assert pos != -1, "marker missing"
html = html[:pos] + SNIPPET + html[pos:]
io.open(dst, "w", encoding="utf-8").write(html)
print("wrote", dst, len(html))

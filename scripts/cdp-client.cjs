const http = require('http');
const WSR = globalThis.WebSocket;
const STEP = process.argv[2] || 'info';
const ARG = process.argv.slice(3).join(' ');
function httpGetJson(u) {
  return new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej);
  });
}
function openWs(url) {
  return new Promise((res, rej) => {
    const ws = new WSR(url);
    let done = false;
    const tm = setTimeout(() => {
      if (!done) {
        done = true;
        rej('open to');
      }
    }, 10000);
    ws.addEventListener('open', () => {
      if (!done) {
        done = true;
        clearTimeout(tm);
        res(ws);
      }
    });
    ws.addEventListener('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(tm);
        rej(e.error || e.message || 'ws err');
      }
    });
  });
}
async function evalJs(ws, expr) {
  let mid = 99;
  await new Promise((r) => {
    ws.send(JSON.stringify({ id: ++mid, method: 'Runtime.enable' }));
    setTimeout(r, 100);
  });
  return new Promise((resolve, reject) => {
    const myId = ++mid;
    const timer = setTimeout(() => reject('eval timeout'), 20000);
    function h(ev) {
      let msg;
      try {
        msg = JSON.parse(
          ev.data && Buffer.isBuffer(ev.data)
            ? ev.data.toString()
            : typeof ev.data === 'string'
              ? ev.data
              : String(ev.data),
        );
      } catch (e) {
        return;
      }
      if (msg && msg.id === myId) {
        clearTimeout(timer);
        ws.removeEventListener('message', h);
        resolve(msg.result);
      }
    }
    ws.addEventListener('message', h);
    ws.send(
      JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true },
      }),
    );
  });
}
async function main() {
  const pages = await httpGetJson('http://localhost:9222/json');
  const renderer = pages
    .filter((p) => p.type === 'page' && p.url)
    .sort(
      (a, b) => (b.title === 'Urchin Browser' ? 1 : 0) - (a.title === 'Urchin Browser' ? 1 : 0),
    )[0];
  if (!renderer) {
    console.log('ERROR no renderer');
    process.exit(1);
  }
  console.error('Using renderer: ' + renderer.url);
  const ws = await openWs(renderer.webSocketDebuggerUrl);
  let js = '';
  if (STEP === 'click-ai') {
    js =
      '(function(){var list=document.querySelectorAll("button");for(var k=0;k<list.length;k++){var b=list[k];var al=b.getAttribute("aria-label")||"";var ti=b.getAttribute("title")||"";if(al.indexOf("AI")>=0 || ti.indexOf("AI")>=0 || al.indexOf("assistant")>=0){b.click();return "AI_BTN_OK index="+k+" label="+al+" title="+ti;}}return "NO_MATCH count="+list.length;})()';
  } else if (STEP === 'check-ai-tab') {
    js =
      '(function(){return "URL="+location.href+" TEXTAREAS="+document.querySelectorAll("textarea").length+" ACTIVE_CLASS="+document.body.className.substring(0,50);})()';
  } else if (STEP === 'send-question') {
    var Q64 = Buffer.from(ARG, 'utf8').toString('base64');
    js =
      '(function(){var q64="' +
      Q64 +
      '";var q=decodeURIComponent(escape(atob(q64)));var ta=document.querySelector("textarea");if(!ta){return "NO_TA_FOUND count="+document.querySelectorAll("textarea").length;}ta.focus();var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;setter.call(ta,q);ta.dispatchEvent(new Event("input",{bubbles:true}));ta.dispatchEvent(new Event("change",{bubbles:true}));var ev=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true});ta.dispatchEvent(ev);return "MSG_SENT_LEN="+q.length;})()';
  } else if (STEP === 'check-streaming') {
    js =
      '(function(){var t=document.body.innerText;var a=t.indexOf("思考中");var b=t.indexOf("正在回复");var c=t.indexOf("thinking");if(a>=0)return "STREAM_OK_CN1_at="+a;if(b>=0)return "STREAM_OK_CN2_at="+b;if(c>=0)return "STREAM_OK_EN_at="+c;return "NOT_YET bodylen="+t.length+" sample="+t.substring(t.length-200);})()';
  } else {
    // info
    js =
      '(function(){var bs=Array.from(document.querySelectorAll("button")).slice(0,12).map(b=>(b.getAttribute("aria-label")||b.getAttribute("title")||"").substring(0,30));return "PAGEURL="+location.href+" | BTN="+bs.join(" | ");})()';
  }
  var r = await evalJs(ws, js);
  var v = r && r.result && r.result.value != null ? String(r.result.value) : JSON.stringify(r);
  console.log('STEP=' + STEP + ' RESULT=' + v);
  try {
    ws.close();
  } catch (e) {}
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log('FATAL=' + (e.message || String(e)));
    process.exit(1);
  });

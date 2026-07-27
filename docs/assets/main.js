(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))i(r);new MutationObserver(r=>{for(const o of r)if(o.type==="childList")for(const n of o.addedNodes)n.tagName==="LINK"&&n.rel==="modulepreload"&&i(n)}).observe(document,{childList:!0,subtree:!0});function s(r){const o={};return r.integrity&&(o.integrity=r.integrity),r.referrerPolicy&&(o.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?o.credentials="include":r.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function i(r){if(r.ep)return;r.ep=!0;const o=s(r);fetch(r.href,o)}})();var c="transcription_gas_api_url";function d(){const t=localStorage.getItem(c);return t||document.querySelector('meta[name="gas-api-url"]')?.content||"https://script.google.com/macros/s/AKfycbxVN3iTnaUBpeuUBGLwAp7vIthoscUWeZ65hq8whzorai7ae6qn1EEh16BY4fmg8WYhuA/exec"}var l=d(),u=class{async post(t,e={}){let s;try{s=await fetch(l,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action:t,...e})})}catch(o){throw new Error("ネットワーク/CORSエラー: "+o.message+" (URL: "+l+")")}const i=await s.text();let r;try{r=JSON.parse(i)}catch{const o=i.replace(/\s+/g," ").slice(0,150);throw new Error("GASがJSON以外を返却(URL無効/削除/未デプロイ?): "+o)}if(r.status==="error")throw new Error(r.error||"GAS error");return r}async getSttToken(t){return(await this.post("stt_token",{provider:t})).token}async summarize(t,e){return(await this.post("summarize",{transcript:t,interval:e})).summary}async save(t,e,s,i){return await this.post("save",{transcript:t,mode:e,sttProvider:s,summaryInterval:i})}},h=class{ws=null;provider;token;sampleRate;onTranscript;onError;onClose;onOpen;reconnectAttempts=0;maxReconnect=5;sendQueue=[];closedByUser=!1;sentBytes=0;onDebug;constructor(t,e,s,i){this.provider=t,this.token=e,this.sampleRate=s,this.onTranscript=i.onTranscript,this.onError=i.onError,this.onClose=i.onClose,this.onOpen=i.onOpen,this.onDebug=i.onDebug||(()=>{})}connect(){this.closedByUser=!1,this.open()}buildUrl(){return this.provider==="speechmatics"?`wss://eu2.rt.speechmatics.com/v2?jwt=${encodeURIComponent(this.token)}`:`wss://api.deepgram.com/v1/listen?${new URLSearchParams({model:"nova-2",language:"ja",smart_format:"true",interim_results:"true",punctuate:"true",diarize:"true",sample_rate:String(this.sampleRate)}).toString()}`}open(){const t=this.buildUrl();try{this.provider==="deepgram"?this.ws=new WebSocket(t,["token",this.token]):this.ws=new WebSocket(t)}catch(e){this.onError(e instanceof Error?e:new Error(String(e)));return}this.ws.binaryType="arraybuffer",this.ws.onopen=()=>{for(this.reconnectAttempts=0,this.onOpen(),this.onDebug("ws","OPEN");this.sendQueue.length>0;){const e=this.sendQueue.shift();this.ws.send(e)}},this.ws.onmessage=e=>{this.onDebug("msg",(typeof e.data=="string"?e.data:"[binary]").slice(0,200)),this.handleMessage(e.data)},this.ws.onerror=()=>{this.onError(new Error(`WebSocket error: ${this.provider}`))},this.ws.onclose=e=>{if(this.closedByUser){this.onClose(e.code);return}this.reconnectAttempts<this.maxReconnect?(this.reconnectAttempts++,setTimeout(()=>this.open(),1e3*this.reconnectAttempts)):this.onClose(e.code)}}handleMessage(t){if(this.provider==="speechmatics"){let e;try{e=JSON.parse(t)}catch{return}if(e.message==="AddTranscript"&&e.results?.length>0)for(const s of e.results){const i=(s.alternatives?.[0]?.speaker??0)===0?a.micLabel:a.cableLabel;this.onTranscript({time:this.nowStr(),speaker:i,text:s.alternatives?.[0]?.content||"",final:!0})}}else{let e;try{e=JSON.parse(t)}catch{return}if(e.type==="Results"&&e.channel?.alternatives?.[0]){const s=e.channel.alternatives[0],i=(s.words?.[0]?.speaker??0)===0?a.micLabel:a.cableLabel;this.onTranscript({time:this.nowStr(),speaker:i,text:s.transcript||"",final:e.is_final===!0})}}}sendAudio(t){this.sentBytes+=t.byteLength,this.onDebug("audio",this.sentBytes+" bytes"),this.ws?.readyState===WebSocket.OPEN?this.ws.send(t):this.ws?.readyState===WebSocket.CONNECTING&&this.sendQueue.push(t)}close(){this.closedByUser=!0,this.ws&&(this.ws.onclose=null,this.ws.close(),this.ws=null)}nowStr(){const t=new Date,e=s=>s<10?"0"+s:""+s;return`${e(t.getMinutes())}:${e(t.getSeconds())}`}},a={micLabel:"自分",cableLabel:"相手"},p=class{audioContext=null;source=null;processor=null;stream=null;stt=null;sampleRate=16e3;onError;onRms=null;constructor(t,e){this.onError=t,this.onRms=e||null}async start(t,e){this.stt=t;const s={audio:e?{deviceId:{exact:e},echoCancellation:!1,noiseSuppression:!1,autoGainControl:!1}:{echoCancellation:!1,noiseSuppression:!1,autoGainControl:!1}};this.stream=await navigator.mediaDevices.getUserMedia(s);const i=window.AudioContext||window.webkitAudioContext;this.audioContext=new i({sampleRate:this.sampleRate}),this.audioContext.state==="suspended"&&await this.audioContext.resume(),this.source=this.audioContext.createMediaStreamSource(this.stream);const r=4096;this.processor=this.audioContext.createScriptProcessor(r,1,1),this.processor.onaudioprocess=o=>this.onAudioProcess(o),this.source.connect(this.processor),this.processor.connect(this.audioContext.destination)}onAudioProcess(t){if(!this.stt)return;const e=t.inputBuffer.getChannelData(0),s=new Int16Array(e.length);let i=0;for(let o=0;o<e.length;o++){const n=Math.max(-1,Math.min(1,e[o]));s[o]=n<0?n*32768:n*32767,i+=n*n}const r=Math.sqrt(i/e.length);this.onRms&&this.onRms(r),this.stt.sendAudio(s.buffer)}getSampleRate(){return this.sampleRate}stop(){this.processor&&(this.processor.disconnect(),this.processor=null),this.source&&(this.source.disconnect(),this.source=null),this.stream&&(this.stream.getTracks().forEach(t=>t.stop()),this.stream=null),this.audioContext&&(this.audioContext.close(),this.audioContext=null)}},m=class{gas=new u;audio=new p(t=>this.log("音声エラー: "+t.message),t=>this.updateDebug("rms",t.toFixed(4)));stt=null;transcripts=[];recording=!1;mode="inperson";sttProvider="deepgram";summaryInterval=3;lastSummary="";summaryTimer=null;elStatus;elTranscript;elSummary;elMicSelect;async init(){this.buildUI(),await this.loadDevices()}buildUI(){document.body.innerHTML=`
      <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; background: #f5f5f5; color: #222; }
        .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
        button { padding: 8px 14px; border: none; border-radius: 6px; background: #1976d2; color: #fff; font-size: 14px; cursor: pointer; }
        button.stop { background: #d32f2f; }
        button:disabled { opacity: .5; cursor: not-allowed; }
        select, input { padding: 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 14px; }
        .status { padding: 6px 10px; border-radius: 6px; background: #e3f2fd; font-size: 13px; margin-bottom: 8px; }
        .error { background: #ffebee; color: #c62828; }
        .row { display: flex; gap: 16px; }
        .col { flex: 1; min-width: 280px; }
        .panel { background: #fff; border-radius: 8px; padding: 12px; height: 50vh; overflow-y: auto; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
        .entry { margin-bottom: 6px; font-size: 14px; line-height: 1.4; }
        .entry.tmp { opacity: .6; }
        .speaker { font-weight: bold; color: #1976d2; }
        .summary { white-space: pre-wrap; font-size: 14px; }
        h3 { margin: 0 0 8px; font-size: 15px; }
        .settings { background: #fff; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
        .settings input { width: 100%; box-sizing: border-box; margin: 4px 0; }
        .settings .savestatus { font-size: 12px; color: #2e7d32; margin-top: 4px; }
      </style>
      <div class="toolbar">
        <button id="btnRec">🎤 録音開始</button>
        <label>モード:
          <select id="selMode">
            <option value="inperson">対面</option>
            <option value="web">Web会議</option>
          </select>
        </label>
        <label>STT:
          <select id="selStt">
            <option value="deepgram">Deepgram</option>
            <option value="speechmatics">Speechmatics</option>
          </select>
        </label>
        <label>要約間隔:
          <select id="selInterval">
            <option value="1">1分</option>
            <option value="3" selected>3分</option>
            <option value="5">5分</option>
          </select>
        </label>
        <label>マイク:
          <select id="selMic"><option value="">デフォルト</option></select>
        </label>
        <button id="btnSave">💾 保存</button>
      </div>
      <div class="settings">
        <strong>GAS API URL設定</strong>
        <input id="inpGasUrl" type="text" placeholder="https://script.google.com/macros/s/.../exec" value="${l}">
        <button id="btnSaveGasUrl">URLを保存</button>
        <div id="gasSaveStatus" class="savestatus"></div>
      </div>
      <div id="status" class="status">待機中...</div>
      <div class="settings">
        <strong>デバッグ情報</strong>
        <div id="dbgWs" style="font-size:12px;color:#555">WS: -</div>
        <div id="dbgMsg" style="font-size:12px;color:#555;max-height:80px;overflow:auto">受信: -</div>
        <div id="dbgAudio" style="font-size:12px;color:#555">送信音声: 0 bytes</div>
        <div id="dbgRms" style="font-size:12px;color:#555">音声RMS: -</div>
      </div>
      <div class="row">
        <div class="col">
          <div class="panel"><h3>文字起こし</h3><div id="transcript"></div></div>
        </div>
        <div class="col">
          <div class="panel"><h3>要約</h3><div id="summary" class="summary"></div></div>
        </div>
      </div>
    `,this.elStatus=document.getElementById("status"),this.elTranscript=document.getElementById("transcript"),this.elSummary=document.getElementById("summary"),this.elMicSelect=document.getElementById("selMic"),document.getElementById("btnRec").addEventListener("click",()=>this.toggleRecording()),document.getElementById("btnSave").addEventListener("click",()=>this.save()),document.getElementById("selMode").addEventListener("change",t=>{this.mode=t.target.value}),document.getElementById("selStt").addEventListener("change",t=>{this.sttProvider=t.target.value}),document.getElementById("selInterval").addEventListener("change",t=>{this.summaryInterval=parseInt(t.target.value,10),this.restartSummaryTimer()}),document.getElementById("btnSaveGasUrl").addEventListener("click",()=>this.saveGasUrl())}saveGasUrl(){const t=document.getElementById("inpGasUrl").value.trim();if(!t){document.getElementById("gasSaveStatus").textContent="URLを入力してください";return}localStorage.setItem(c,t),l=t,document.getElementById("gasSaveStatus").textContent="保存しました ✓",this.setStatus("GAS API URLを更新しました")}async loadDevices(){try{const t=(await navigator.mediaDevices.enumerateDevices()).filter(e=>e.kind==="audioinput");this.elMicSelect.innerHTML='<option value="">デフォルト</option>'+t.map((e,s)=>`<option value="${e.deviceId}">${e.label||"マイク"+(s+1)}</option>`).join("")}catch(t){this.log("デバイス一覧取得失敗: "+t.message)}}async toggleRecording(){this.recording?this.stopRecording():await this.startRecording()}async startRecording(){try{if((await navigator.permissions.query({name:"microphone"})).state==="denied"){this.setStatus("マイク権限が拒否されています。ブラウザの設定から許可してください。",!0);return}this.setStatus("トークン取得中...");const t=await this.gas.getSttToken(this.sttProvider),e=this.elMicSelect.value||void 0;await this.audio.start(this.stt,e),this.stt=new h(this.sttProvider,t,this.audio.getSampleRate(),{onTranscript:s=>this.addTranscript(s),onError:s=>this.log(s.message),onClose:s=>this.log(`STT切断: ${s}`),onOpen:()=>this.log(`[STT] ${this.sttProvider} connected`),onDebug:(s,i)=>this.updateDebug(s,i)}),this.stt.connect(),this.recording=!0,document.getElementById("btnRec").textContent="⏹ 録音停止",document.getElementById("btnRec").classList.add("stop"),this.setStatus("録音中..."),this.startSummaryTimer()}catch(t){this.setStatus("開始エラー: "+t.message,!0),this.stopRecording()}}stopRecording(){this.recording=!1,document.getElementById("btnRec").textContent="🎤 録音開始",document.getElementById("btnRec").classList.remove("stop"),this.stt&&(this.stt.close(),this.stt=null),this.audio.stop(),this.stopSummaryTimer(),this.setStatus("停止しました")}addTranscript(t){if(!t.text)return;this.transcripts.push(t);const e=document.createElement("div");e.className="entry"+(t.final?"":" tmp"),e.innerHTML=`<span class="speaker">[${t.time}] ${t.speaker}:</span> ${t.text}`,this.elTranscript.appendChild(e),this.elTranscript.scrollTop=this.elTranscript.scrollHeight}startSummaryTimer(){this.stopSummaryTimer(),this.summaryTimer=window.setInterval(()=>this.runSummary(),this.summaryInterval*60*1e3)}restartSummaryTimer(){this.recording&&this.startSummaryTimer()}stopSummaryTimer(){this.summaryTimer&&(clearInterval(this.summaryTimer),this.summaryTimer=null)}async runSummary(){if(this.transcripts.length!==0)try{const t=await this.gas.summarize(this.transcripts,this.summaryInterval);this.lastSummary=t,this.elSummary.textContent=t}catch(t){this.log("要約失敗: "+t.message)}}async save(){if(this.transcripts.length===0){this.setStatus("保存するデータがありません",!0);return}try{this.setStatus("保存中...");const t=await this.gas.save(this.transcripts,this.mode,this.sttProvider,this.summaryInterval);this.elSummary.textContent=t.summary,this.setStatus("保存完了: "+t.filename)}catch(t){this.setStatus("保存失敗: "+t.message,!0)}}updateDebug(t,e){const s=t==="ws"?"dbgWs":t==="msg"?"dbgMsg":t==="audio"?"dbgAudio":"dbgRms",i=document.getElementById(s);i&&(t==="msg"?i.textContent="受信: "+e:t==="rms"?i.textContent="音声RMS: "+e:i.textContent=(t==="ws"?"WS: ":"送信音声: ")+e)}setStatus(t,e=!1){this.elStatus.textContent=t,this.elStatus.className="status"+(e?" error":"")}log(t){console.log(t),t.startsWith("STT切断")||t.startsWith("音声エラー")||t.startsWith("[STT]")}};new m().init();

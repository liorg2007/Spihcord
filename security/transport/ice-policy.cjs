// Hidden Electron: checks the WebRTC IP handling policy applied by the desktop
// app (security T2). For each policy it gathers ICE candidates (no STUN/TURN
// reachable, like ice-leak.cjs) and tries a direct two-peer connection in the
// same page, then prints the candidate addresses and whether ICE connected.
// Run: npx electron security/transport/ice-policy.cjs [policy ...]
const { app, BrowserWindow } = require("electron");
const page = `<script>
async function run(){
  const cfg={iceServers:[{urls:["stun:127.0.0.1:3479"]}],bundlePolicy:"max-bundle",rtcpMuxPolicy:"require"};
  const a=new RTCPeerConnection(cfg),b=new RTCPeerConnection(cfg);const cands=[];
  a.onicecandidate=e=>{if(e.candidate){cands.push(e.candidate.candidate);b.addIceCandidate(e.candidate)}};
  b.onicecandidate=e=>{if(e.candidate)a.addIceCandidate(e.candidate)};
  a.createDataChannel("d");
  await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);
  const state=await new Promise(r=>{const t=setTimeout(()=>r(a.iceConnectionState),10000);
    a.oniceconnectionstatechange=()=>{if(["connected","completed","failed"].includes(a.iceConnectionState)){clearTimeout(t);r(a.iceConnectionState)}}});
  let pair=null;try{const st=await a.getStats();st.forEach(s=>{if(s.type==="candidate-pair"&&s.nominated&&s.state==="succeeded"){const l=st.get(s.localCandidateId);pair=l&&(l.address+" "+l.candidateType)}})}catch{}
  a.close();b.close();
  return {addresses:[...new Set(cands.map(c=>c.split(" ")[4]+" "+c.split(" ")[7]))],ice:state,pair};
}
window.go=()=>{window.result=null;run().then(r=>window.result=r,e=>window.result={error:String(e)})};
</script>`;
// Policies run in order in ONE page, switching at runtime like the app does
// (strict at startup, relaxed when the hub is on a private network).
const policies = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith(".cjs"));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  w.webContents.setWebRTCIPHandlingPolicy("default_public_interface_only");
  await w.loadURL("data:text/html," + encodeURIComponent(page));
  for (const policy of policies.length ? policies : ["default_public_interface_only", "default", "default_public_interface_only"]) {
    w.webContents.setWebRTCIPHandlingPolicy(policy);
    await w.webContents.executeJavaScript("window.go()");
    let r = null;
    for (let i = 0; i < 60 && !r; i++) {
      r = await w.webContents.executeJavaScript("window.result||null");
      if (!r) await new Promise((s) => setTimeout(s, 250));
    }
    console.log(policy, JSON.stringify(r));
  }
  app.exit(0);
});
setTimeout(() => app.exit(2), 60000);

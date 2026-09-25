// Hidden Electron: gathers ICE candidates with iceTransportPolicy 'relay' vs 'all' (engine's rtcConfig shape)
// and reports every candidate that would be handed to the signaling transport.
// Run: npx electron security/transport/ice-leak.cjs
const { app, BrowserWindow } = require("electron");
const page = `<script>
async function gather(policy){
  const pc=new RTCPeerConnection({iceServers:[{urls:["stun:127.0.0.1:3479","turn:127.0.0.1:3479?transport=udp"],username:"1:x",credential:"y"}],
    iceTransportPolicy:policy,bundlePolicy:"max-bundle",rtcpMuxPolicy:"require"});
  const out=[];pc.createDataChannel("d");
  const done=new Promise(r=>{pc.onicecandidate=e=>{if(e.candidate)out.push(e.candidate.candidate);else r()};setTimeout(r,8000)});
  await pc.setLocalDescription(await pc.createOffer());await done;
  const sdpC=(pc.localDescription.sdp.match(/a=candidate.*$/gm)||[]);pc.close();return {policy,candidates:out,sdpCandidates:sdpC};
}
(async()=>{window.result=[await gather("relay"),await gather("all")]})();
</script>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL("data:text/html," + encodeURIComponent(page));
  for (let i = 0; i < 40; i++) {
    const r = await w.webContents.executeJavaScript("window.result||null");
    if (r) { console.log(JSON.stringify(r, null, 1)); break; }
    await new Promise((s) => setTimeout(s, 500));
  }
  app.exit(0);
});
setTimeout(() => app.exit(2), 40000);

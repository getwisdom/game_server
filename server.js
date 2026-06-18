const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const DFLT = ['玩家一','玩家二','玩家三','玩家四','玩家五'];
const MODE = {
  mode1:{count:3, base:[5,5,5]},
  mode2:{count:4, base:[3,4,4,4]},
  mode3:{count:5, base:[3,3,3,3,3]},
};

function pp(m,r) {
  if(m!=='mode2') return [...MODE[m].base];
  const b=[3,4,4,4],r2=[]; for(let i=0;i<4;i++) r2.push(b[(i-(r%4)+4)%4]); return r2;
}
function rd(a,b){return Math.floor(Math.random()*(b-a+1))+a;}
function shf(a){for(let i=a.length-1;i>0;i--){let j=rd(0,i);[a[i],a[j]]=[a[j],a[i]];}return a;}

function calcScores(ply, pcs) {
  const scores=[];const allGreen=[];
  for(let i=0;i<ply.length;i++){
    const p=ply[i];const need=pcs[i]||0;let bk=0,rd=0,yl=0,hB=false;
    for(let si=0;si<need+4;si++){if(si<need){if(p.cs[si]==='bk'){bk++;hB=true;}}else{
      if(p.cs[si]==='rd'){rd++;}else if(p.cs[si]==='yl'){yl++;}
    }}
    allGreen[i]=!hB;scores[i]={bk,rd,yl};
  }
  const r=[];
  for(let i=0;i<ply.length;i++){if(!allGreen[i])r[i]=-scores[i].bk+scores[i].rd-2*scores[i].yl;}
  for(let i=0;i<ply.length;i++){if(allGreen[i]){let o=0;for(let j=0;j<ply.length;j++)if(j!==i)o+=r[j]||0;r[i]=-o;}}
  return r;
}

let state = {
  mode: 'mode2', ply: [], pcs: [], round: 0, assignCount: 0,
  cum: [], done: false, lit: false, ended: false,
  history: [], historyPos: -1,
};
let clients = [];
let lightVotes = {};
let lightTimer = null;

function initPlayers() {
  const c = MODE[state.mode];
  state.ply = [];
  for(let i=0;i<c.count;i++) state.ply.push({n:DFLT[i],s:[],cs:[]});
  state.pcs=pp(state.mode,0);state.round=0;state.assignCount=0;state.cum=[];
  state.done=false;state.lit=false;state.ended=false;
  state.history=[];state.historyPos=-1;
}

function doAssign() {
  if(state.historyPos!==-1) {
    // 浏览历史时分配：截断历史，回到live模式
    state.history=state.history.slice(0,state.historyPos+1);
    state.historyPos=-1;
  }
  state.assignCount++; state.round++;
  if(state.assignCount>1){
    state.history.push({
      ply:state.ply.map(p=>({s:[...p.s],cs:[...p.cs]})),
      pcs:[...state.pcs],
      cum:[...state.cum],
      round:state.round-1,
      assignCount:state.assignCount-1,
    });
    const ps=calcScores(state.ply,state.pcs);
    for(let i=0;i<ps.length;i++) state.cum[i]=(state.cum[i]||0)+ps[i];
  }
  state.ply.forEach(p=>{p.s=[];p.cs=[];});
  state.done=false;state.lit=false;state.ended=false;
  state.pcs=pp(state.mode,state.round);
  const total=state.pcs.reduce((a,b)=>a+b,0);
  const pool=[];for(let n=1;n<=15;n++)pool.push(n);shf(pool);
  const seq=pool.slice(0,total);let idx=0;
  for(let pi=0;pi<state.ply.length;pi++) for(let k=0;k<state.pcs[pi];k++) state.ply[pi].s.push(seq[idx++]);
  state.ply.forEach(p=>{p.cs=p.s.map(()=>'bk');for(let z=0;z<4;z++){p.s.push(0);p.cs.push('gy');}});
  state.done=true;
  clearLightVotes();
}
function doLight(){if(state.done){state.lit=true;clearLightVotes();}}

function restoreSnapshot(snap) {
  snap.ply.forEach((sp,i)=>{if(i<state.ply.length){state.ply[i].s=sp.s;state.ply[i].cs=sp.cs;}});
  state.pcs=snap.pcs;state.cum=snap.cum;
  state.round=snap.round;state.assignCount=snap.assignCount;
  state.done=true;state.lit=true;state.ended=false;
}

function doPrev() {
  if(state.history.length===0)return;
  if(state.historyPos===-1){
    // 从live进入历史，保存live现场
    state._liveBackup={
      ply:state.ply.map(p=>({s:[...p.s],cs:[...p.cs],n:p.n})),
      pcs:[...state.pcs],cum:[...state.cum],
      round:state.round,assignCount:state.assignCount,
      done:state.done,lit:state.lit,ended:state.ended,
    };
    state.historyPos=state.history.length-1;
    restoreSnapshot(state.history[state.historyPos]);
  } else if(state.historyPos>0){
    state.historyPos--;
    restoreSnapshot(state.history[state.historyPos]);
  }
}
function doNext() {
  if(state.historyPos===-1)return;
  if(state.historyPos<state.history.length-1){
    state.historyPos++;
    restoreSnapshot(state.history[state.historyPos]);
  } else {
    // 回到live
    const bk=state._liveBackup;
    if(bk){
      bk.ply.forEach((sp,i)=>{if(i<state.ply.length){state.ply[i].s=sp.s;state.ply[i].cs=sp.cs;state.ply[i].n=sp.n;}});
      state.pcs=bk.pcs;state.cum=bk.cum;
      state.round=bk.round;state.assignCount=bk.assignCount;
      state.done=bk.done;state.lit=bk.lit;state.ended=bk.ended;
    }
    state.historyPos=-1;
    state._liveBackup=null;
  }
}

function toggleCell(pi,si){
  if(!state.done||state.ended||state.historyPos>=0)return; // 历史模式不可编辑
  const p=state.ply[pi];if(!p||si>=p.s.length)return;
  const val=p.s[si];const cur=p.cs[si];
  if(val>0) p.cs[si]=cur==='bk'?'gr':'bk';
  else p.cs[si]=cur==='gy'?'rd':cur==='rd'?'yl':'gy';
}

function clearLightVotes() { lightVotes={};if(lightTimer){clearTimeout(lightTimer);lightTimer=null;} }

function handleLight(client) {
  if(!state.done||state.lit||state.historyPos>=0)return;
  const pi=client.playerIndex;if(pi<0)return;
  lightVotes[pi]=Date.now();
  const now=Date.now();
  Object.keys(lightVotes).forEach(k=>{if(now-lightVotes[k]>5000)delete lightVotes[k];});
  const voters=Object.keys(lightVotes);
  if(voters.length>=2){doLight();broadcast();}
  else{if(lightTimer)clearTimeout(lightTimer);lightTimer=setTimeout(()=>{lightVotes={};lightTimer=null;broadcast();},5000);broadcast();}
}

function getState(){const s=JSON.parse(JSON.stringify(state));delete s._liveBackup;return s;}

function getOccupied(){const o={};clients.forEach(c=>{if(c.playerIndex>=0)o[c.playerIndex]=true;});return o;}

function broadcast(){
  const st=getState();st.occupied=getOccupied();st.mode=state.mode;
  st.lightVotes=Object.keys(lightVotes).map(Number);
  const msg=JSON.stringify({type:'state',state:st});
  clients.forEach(c=>{try{c.ws.send(msg);}catch(e){}});
}

function handleMessage(client, msg) {
  switch(msg.type) {
    case 'joinPlayer':
      if(msg.playerIndex<0||msg.playerIndex>=state.ply.length){client.ws.send(JSON.stringify({type:'err',msg:'无效玩家'}));return;}
      if(clients.some(c=>c!==client&&c.playerIndex===msg.playerIndex)){client.ws.send(JSON.stringify({type:'err',msg:'该玩家已被选择'}));return;}
      client.playerIndex=msg.playerIndex;
      if(msg.name&&state.ply[msg.playerIndex])state.ply[msg.playerIndex].n=msg.name;
      client.ws.send(JSON.stringify({type:'joined',playerIndex:client.playerIndex,state:getState()}));
      broadcast();break;
    case 'toggleCell':
      if(msg.playerIndex!==client.playerIndex)return;
      toggleCell(msg.playerIndex,msg.cellIndex);
      broadcast();break;
    case 'assign':doAssign();broadcast();break;
    case 'light':handleLight(client);break;
    case 'prev':doPrev();broadcast();break;
    case 'next':doNext();broadcast();break;
    case 'modeChange':
      state.mode=msg.mode;initPlayers();clearLightVotes();
      clients.forEach(c=>c.playerIndex=-1);
      broadcast();break;
  }
}

const publicDir=__dirname;
const PORT=process.env.PORT||8899;
const server=http.createServer((req,res)=>{
  let url=req.url.split('?')[0];if(url==='/')url='/index.html';
  const fp=path.join(publicDir,url);
  const mime={'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8'};
  fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);res.end('Not Found');return;}res.writeHead(200,{'Content-Type':mime[path.extname(fp)]||'application/octet-stream'});res.end(data);});
});
const wss=new WebSocketServer({server});
wss.on('connection',(ws)=>{
  const client={ws,playerIndex:-1};clients.push(client);
  ws.send(JSON.stringify({type:'lobby',occupied:getOccupied(),mode:state.mode,ply:state.ply.map(p=>p.n)}));
  broadcast();
  ws.on('message',raw=>{try{handleMessage(client,JSON.parse(raw));}catch(e){}});
  ws.on('close',()=>{clients=clients.filter(c=>c!==client);broadcast();});
});
initPlayers();
server.listen(PORT,()=>{console.log(`台麻游戏服务器已启动: http://0.0.0.0:${PORT}`);console.log(`局域网地址: http://192.168.3.25:${PORT}`);});

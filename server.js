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

function calcScores(ply,pcs){
  const scores=[];const allGreen=[];
  for(let i=0;i<ply.length;i++){const p=ply[i];const need=pcs[i]||0;let bk=0,rd=0,yl=0,hB=false;
    for(let si=0;si<need+4;si++){if(si<need){if(p.cs[si]==='bk'){bk++;hB=true;}}else{if(p.cs[si]==='rd'){rd++;}else if(p.cs[si]==='yl'){yl++;}}}
    allGreen[i]=!hB;scores[i]={bk,rd,yl};}
  const r=[];for(let i=0;i<ply.length;i++){if(!allGreen[i])r[i]=-scores[i].bk+scores[i].rd-2*scores[i].yl;}
  for(let i=0;i<ply.length;i++){if(allGreen[i]){let o=0;for(let j=0;j<ply.length;j++)if(j!==i)o+=r[j]||0;r[i]=-o;}}
  return r;
}

// ====== 房间系统 ======
const rooms = new Map(); // roomCode -> state
const clients = new Map(); // ws -> {roomCode, playerIndex}

function genCode(){let c;do{c=String(rd(1000,9999));}while(rooms.has(c));return c;}

function newRoom(mode){
  const c=MODE[mode];
  return {
    mode,ply:[],pcs:[],round:0,assignCount:0,cum:[],multi:1,
    done:false,lit:false,ended:false,history:[],historyPos:-1,
    _liveBackup:null,
  };
}

function broadcast(room, msg, optForPlayer){
  if(typeof msg==='object')msg=JSON.stringify(msg);
  clients.forEach((v,ws)=>{if(v.roomCode===room){
    let m=msg;
    if(optForPlayer===undefined&&typeof msg==='string'){
      try{
        const parsed=JSON.parse(msg);
        if(parsed.type==='state'&&parsed.state){
          // 亮号前给每个玩家个性化（隐藏非自己的数字格颜色）
          const st=rooms.get(room);
          if(st&&!st.lit){
            const masked=stateForClient(room,v.playerIndex);
            m=JSON.stringify({type:'state',state:masked});
          }
        }
      }catch(e){}
    }
    try{ws.send(m);}catch(e){}
  }});
}

function stateForClient(room, forPlayer){
  const s=rooms.get(room);if(!s)return null;
  const r=JSON.parse(JSON.stringify(s));delete r._liveBackup;
  r.lightVotes=s._lightVotes?Object.keys(s._lightVotes).map(Number):[];
  // 亮号前对其他玩家隐藏数字格颜色
  if(!s.lit&&forPlayer!==undefined&&forPlayer>=0){
    for(let i=0;i<r.ply.length;i++){
      if(i===forPlayer)continue;
      const need=r.pcs[i]||0;
      for(let si=0;si<need;si++)r.ply[i].cs[si]='bk';
    }
  }
  return r;
}

// ====== 房间内游戏逻辑 ======
function initPlayers(st){
  const c=MODE[st.mode];
  st.ply=[];for(let i=0;i<c.count;i++)st.ply.push({n:DFLT[i],s:[],cs:[]});
  st.pcs=pp(st.mode,0);st.round=0;st.assignCount=0;st.cum=[];
  st.done=false;st.lit=false;st.ended=false;st.history=[];st.historyPos=-1;
  st._lightVotes={};if(st._lt){clearTimeout(st._lt);st._lt=null;}
}

function doAssign(st){
  if(st.historyPos!==-1){st.history=st.history.slice(0,st.historyPos+1);st.historyPos=-1;}
  st.assignCount++;st.round++;
  if(st.assignCount>1){
    st.history.push({ply:st.ply.map(p=>({s:[...p.s],cs:[...p.cs]})),pcs:[...st.pcs],cum:[...st.cum],round:st.round-1,assignCount:st.assignCount-1});
    const ps=calcScores(st.ply,st.pcs);
    for(let i=0;i<ps.length;i++)st.cum[i]=(st.cum[i]||0)+ps[i];
  }
  st.ply.forEach(p=>{p.s=[];p.cs=[];});
  st.done=false;st.lit=false;st.ended=false;
  st.pcs=pp(st.mode,st.round);
  const total=st.pcs.reduce((a,b)=>a+b,0);const pool=[];
  for(let n=1;n<=15;n++)pool.push(n);shf(pool);
  const seq=pool.slice(0,total);let idx=0;
  for(let pi=0;pi<st.ply.length;pi++)for(let k=0;k<st.pcs[pi];k++)st.ply[pi].s.push(seq[idx++]);
  st.ply.forEach(p=>{p.cs=p.s.map(()=>'bk');for(let z=0;z<4;z++){p.s.push(0);p.cs.push('gy');}});
  st.done=true;st._lightVotes={};if(st._lt){clearTimeout(st._lt);st._lt=null;}
}
function doLight(st){if(st.done){st.lit=true;st._lightVotes={};if(st._lt){clearTimeout(st._lt);st._lt=null;}}}
function restoreSnapshot(st,snap){
  snap.ply.forEach((sp,i)=>{if(i<st.ply.length){st.ply[i].s=sp.s;st.ply[i].cs=sp.cs;}});
  st.pcs=snap.pcs;st.cum=snap.cum;st.round=snap.round;st.assignCount=snap.assignCount;
  st.done=true;st.lit=true;st.ended=false;
}
function doPrev(st){
  if(st.history.length===0)return;
  if(st.historyPos===-1){
    st._liveBackup={ply:st.ply.map(p=>({s:[...p.s],cs:[...p.cs],n:p.n})),pcs:[...st.pcs],cum:[...st.cum],round:st.round,assignCount:st.assignCount,done:st.done,lit:st.lit,ended:st.ended};
    st.historyPos=st.history.length-1;restoreSnapshot(st,st.history[st.historyPos]);
  }else if(st.historyPos>0){st.historyPos--;restoreSnapshot(st,st.history[st.historyPos]);}
}
function doNext(st){
  if(st.historyPos===-1)return;
  if(st.historyPos<st.history.length-1){st.historyPos++;restoreSnapshot(st,st.history[st.historyPos]);}
  else{const bk=st._liveBackup;if(bk){bk.ply.forEach((sp,i)=>{if(i<st.ply.length){st.ply[i].s=sp.s;st.ply[i].cs=sp.cs;st.ply[i].n=sp.n;}});st.pcs=bk.pcs;st.cum=bk.cum;st.round=bk.round;st.assignCount=bk.assignCount;st.done=bk.done;st.lit=bk.lit;st.ended=bk.ended;}st.historyPos=-1;st._liveBackup=null;}
}
function toggleCell(st,pi,si){
  if(!st.done||st.ended||st.historyPos>=0)return;
  const p=st.ply[pi];if(!p||si>=p.s.length)return;
  const val=p.s[si];const cur=p.cs[si];
  if(val>0)p.cs[si]=cur==='bk'?'gr':'bk';else p.cs[si]=cur==='gy'?'rd':cur==='rd'?'yl':'gy';
}
function isAllGreen(st,pi){const p=st.ply[pi];const need=st.pcs[pi]||0;for(let si=0;si<need;si++){if(p.cs[si]==='bk')return false;}return true;}
function handleLightRoom(st,client){
  if(!st.done||st.lit||st.historyPos>=0)return;
  if(client.playerIndex<0)return;
  if(!st._lightVotes)st._lightVotes={};
  st._lightVotes[client.playerIndex]=Date.now();
  const now=Date.now();
  Object.keys(st._lightVotes).forEach(k=>{if(now-st._lightVotes[k]>5000)delete st._lightVotes[k];});
  const voters=Object.keys(st._lightVotes);
  if(voters.length>=2){doLight(st);broadcast(client.roomCode,{type:'state',state:stateForClient(client.roomCode)});}
  else{if(st._lt)clearTimeout(st._lt);st._lt=setTimeout(()=>{st._lightVotes={};st._lt=null;broadcast(client.roomCode,{type:'state',state:stateForClient(client.roomCode)});},5000);broadcast(client.roomCode,{type:'state',state:stateForClient(client.roomCode)});}
}

// ====== 消息处理 ======
function handleMessage(client, msg) {
  const rc=client.roomCode;
  switch(msg.type) {
    case 'createRoom': {
      const mode=msg.mode||'mode2';const code=genCode();
      const st=newRoom(mode);initPlayers(st);
      st.ply[0].n=msg.name||DFLT[0];st.multi=parseFloat(msg.multi)||1;
      rooms.set(code,st);
      client.roomCode=code;client.playerIndex=0;
      client.ws.send(JSON.stringify({type:'joined',roomCode:code,playerIndex:0,state:stateForClient(code)}));
      broadcast(code,{type:'state',state:stateForClient(code)});
      break;
    }
    case 'joinRoom': {
      const code=msg.roomCode;if(!code||!rooms.has(code)){client.ws.send(JSON.stringify({type:'err',msg:'房间不存在'}));return;}
      const st=rooms.get(code);const c=MODE[st.mode].count;
      // 找空位
      let pi=-1;
      for(let i=0;i<c;i++){const taken=Array.from(clients.values()).some(v=>v.roomCode===code&&v.playerIndex===i);if(!taken){pi=i;break;}}
      if(pi===-1){client.ws.send(JSON.stringify({type:'err',msg:'房间已满'}));return;}
      client.roomCode=code;client.playerIndex=pi;
      st.ply[pi].n=msg.name||DFLT[pi];
      // 有人回来了，取消空房清理定时器
      if(st._emptyTimer){clearTimeout(st._emptyTimer);st._emptyTimer=null;}
      client.ws.send(JSON.stringify({type:'joined',roomCode:code,playerIndex:pi,state:stateForClient(code)}));
      broadcast(code,{type:'state',state:stateForClient(code)});
      break;
    }
    case 'toggleCell':
      if(!rc)return;if(msg.playerIndex!==client.playerIndex)return;
      toggleCell(rooms.get(rc),msg.playerIndex,msg.cellIndex);
      // 自己发完整状态，其他玩家通过broadcast自动隐藏
      {const st=rooms.get(rc);
        try{client.ws.send(JSON.stringify({type:'state',state:stateForClient(rc,client.playerIndex)}));}catch(e){}
        broadcast(rc,{type:'state',state:stateForClient(rc)});
      }break;
    case 'assign':
      if(!rc)return;
      const ast=rooms.get(rc);
      if(ast.lit&&!isAllGreen(ast,client.playerIndex)){
        client.ws.send(JSON.stringify({type:'err',msg:'只有全绿玩家才能分配下一局'}));
        return;
      }
      doAssign(ast);
      broadcast(rc,{type:'state',state:stateForClient(rc)});break;
    case 'light':
      if(!rc)return;handleLightRoom(rooms.get(rc),client);break;
    case 'prev':
      if(!rc)return;doPrev(rooms.get(rc));
      broadcast(rc,{type:'state',state:stateForClient(rc)});break;
    case 'next':
      if(!rc)return;doNext(rooms.get(rc));
      broadcast(rc,{type:'state',state:stateForClient(rc)});break;
  }
}

// ====== HTTP + WebSocket ======
const PORT=process.env.PORT||8899;
const server=http.createServer((req,res)=>{
  let url=req.url.split('?')[0];if(url==='/')url='/index.html';
  const fp=path.join(__dirname,url);
  const mime={'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8'};
  fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);res.end('Not Found');return;}res.writeHead(200,{'Content-Type':mime[path.extname(fp)]||'application/octet-stream'});res.end(data);});
});
const wss=new WebSocketServer({server});
wss.on('connection',(ws)=>{
  const client={ws,roomCode:null,playerIndex:-1};clients.set(ws,client);
  ws.on('message',raw=>{try{handleMessage(client,JSON.parse(raw));}catch(e){}});
  ws.on('close',()=>{
    const rc=client.roomCode;clients.delete(ws);
    if(rc&&rooms.has(rc)){
      // 检查房间是否还有人
      const hasPlayer=Array.from(clients.values()).some(v=>v.roomCode===rc);
      if(!hasPlayer){
        // 没人了，但保留房间，5小时后清理
        if(!rooms.get(rc)._emptyTimer)
          rooms.get(rc)._emptyTimer=setTimeout(()=>{rooms.delete(rc);},5*60*60*1000);
      }else{
        broadcast(rc,{type:'state',state:stateForClient(rc)});
      }
    }
  });
});
server.listen(PORT,()=>{console.log(`台麻游戏服务器已启动: http://0.0.0.0:${PORT}`);});

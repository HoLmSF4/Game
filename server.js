'use strict';
/* Castle & Frontier — multiplayer server. No dependencies: run with `node server.js`.
   Serves the game page over HTTP and runs lobbies + authoritative matches over WebSocket on the same port. */
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const D=require('./data.js');
const PORT=+process.env.PORT||8080,LOBBY_SECS=+process.env.LOBBY_SECS||60,SPAWN_TICKS=+process.env.SPAWN_TICKS||0;
const MAX_GAMES=+process.env.MAX_GAMES||8,ROT=['william','med','europe','known','asia','norse','brit'];
/*DATA*/
/* ================= balance and content tables (shared by the game page and the server) =================
   Every number here is provisional and meant to be tuned. Nothing below this block hard-codes a balance value. */
const CFG={
  win:.90,                 // share of the land that wins the match; there is no time limit
  deploy:.30,              // default share of the troop pool sent with an order
  cancelLoss:[.01,.05],    // recalled armies lose 1–5% when the target was an enemy realm (free against unclaimed land)
  tile:5,terr:[0,1,1.5,2.5,1,1.5],      // base cost of a tile and terrain multipliers: plains, forest, mountains, desert, tundra
  growBase:4,growRate:.009,overext:1.4,overextMax:.6,
  capBase:300,capTile:80,capPow:.82,cityCap:2500,cityCapLv:1200,castleCap:400,
  taxBase:.5,taxTile:.03,cityInc:.3,portInc:.3,pactInc:.6,allyInc:.8,incomeEvery:50,
  stabStart:50,stabLow:15,stabDrain:.0006,
  stabConquer:6,stabEncircle:2,stabTake:1,stabLoseBig:-3,stabLoseSmall:-2,stabShip:-2,stabTrade:-1,stabSack:-8,stabLand:-3,   // stability moves with conquest and loss
  shipRange:.5,tradeHp:40,
  fortBase:1.5,fortLv:.5,fortR:6,castleAtk:.07,
  shot:100,catRange:40,catRangeLv:6,catBlast:4,catReload:80,
  sector:9,sectorGrow:.05,sectorMax:70,mergeR:12,shieldMax:.5,clash:.02,
  allyTicks:1800,allyWarn:300,allyRenew:600,truce:900,tribute:.20,tributeNeed:2.5,askTicks:300,giftRel:15,maxPacts:4,
  policyTicks:450,maxCourt:3,courtShown:5,
  eventEvery:[700,1100],eventWait:300,
  sackCd:900,sackLoot:.3,
  graceTicks:900,           // bots declare no wars in the first 90 seconds
  spawnMP:100,maxHumans:15,realmsMP:30,
  buildGap:4,portSnap:6,buildStep:.6,upStep:.8,
  tradeGap:60,tradeBase:40,tradeLen:.9,tradePortLv:.25,tradePartner:.4,tradeV:.38,patrolR:13,sightR:34,repair:300};
const TERR=['Water','Plains','Forest','Mountains','Desert','Tundra'];
const BT={city:{n:'City',ic:'city',c:150,max:10,d:'Troop capacity and income. Ten levels.'},
  castle:{n:'Castle',ic:'castle',c:120,max:5,d:'Fortifies the land around it. Five levels, each widening the zone.'},
  port:{n:'Port',ic:'anchor',c:180,max:5,d:'Sends merchant ships and launches fleets. Trade pays by the level of the port it reaches.'},
  cat:{n:'Catapult',ic:'treb',c:350,max:5,d:'Bombards enemy land at range. Higher levels reach further and hit wider.'}};
const SHIPS=[
  {n:'Cog',ic:'ship',c:150,cap:5000,v:.34,hp:80,atk:0,up:.1,bt:100,d:'Transport only. Carries up to 5,000 troops from your nearest port to any coast. Unarmed.',rq:''},
  {n:'War Galley',ic:'warship',c:500,v:.3,hp:220,atk:14,rng:12,up:.3,bt:200,d:'Patrols where you station it, fights enemy ships and seizes enemy merchantmen.',rq:'Needs 1 city',req:p=>p.city>=1},
  {n:'Great Carrack',ic:'warship',c:2000,v:.24,hp:700,atk:40,rng:15,up:1,bt:500,d:'Three times the hull and firepower of a galley, with a longer reach.',rq:'Needs 3 cities and 2 ports',req:p=>p.city>=3&&p.port>=2}];
/* realm modifiers: every stat starts at its base and the tables below add to it */
const M_BASE={atk:1,def:1,exp:1,grow:1,gold:1,build:1,cap:1,reload:1,sail:1,trade:1,navy:1,ally:1,blast:0,pacts:0,dip:0,guard:0};
const CULTURES={english:{n:'English',d:'Longbowmen, stone keeps and a sharp eye for the wool trade.'}};
const POLICY_CATS=['Military','Economy','Realm'];
const POLICIES={english:[
  {id:'m1',b:0,n:'Fyrd Levies',d:'+15% recruitment',c:100,m:{grow:.15}},
  {id:'m2',b:0,n:'Longbow Statute',d:'+0.15 attack',c:250,m:{atk:.15},req:'m1'},
  {id:'m3',b:0,n:'Standing Retinues',d:'+25% troop capacity',c:500,m:{cap:.25},req:'m2'},
  {id:'e1',b:1,n:'Market Charters',d:'+25% gold income',c:100,m:{gold:.25}},
  {id:'e2',b:1,n:'Guild Masons',d:'Buildings and upgrades cost 25% less',c:250,m:{build:-.25},req:'e1'},
  {id:'e3',b:1,n:'Wool Staple',d:'+40% trade profits and one more trade agreement',c:500,m:{trade:.4,pacts:1},req:'e2'},
  {id:'r1',b:2,n:'Stone Keeps',d:'+0.20 defence',c:100,m:{def:.2}},
  {id:'r2',b:2,n:'Cinque Ports',d:'Ships cost 25% less and sail 50% faster',c:250,m:{navy:-.25,sail:.5},req:'r1'},
  {id:'r3',b:2,n:'Siege Engineers',d:'Catapults reload twice as fast and hit a wider area',c:500,m:{reload:-.5,blast:2},req:'r2'}]};
const COURTIERS={english:{
  marshal:{n:'Marshal',ic:'swords',d:'+0.10 attack and +0.15 defence',c:120,m:{atk:.1,def:.15}},
  chancellor:{n:'Chancellor',ic:'coin',d:'+15% gold, +50% trade profits, two more trade agreements',c:120,m:{gold:.15,trade:.5,pacts:2}},
  envoy:{n:'Royal Envoy',ic:'scroll',d:'Realms accept your offers more readily; alliances last 5 minutes',c:120,m:{dip:1,ally:.667}},
  chamberlain:{n:'Lord Chamberlain',ic:'scales',d:'Events that shake stability hurt half as much',c:120,m:{guard:.5}},
  steward:{n:'Steward',ic:'city',d:'Buildings cost 15% less and troop capacity rises 10%',c:120,m:{build:-.15,cap:.1}},
  admiral:{n:'Lord Admiral',ic:'anchor',d:'Ships cost 20% less and sail 30% faster',c:160,m:{navy:-.2,sail:.3},shop:400},
  pathfinder:{n:'Pathfinder',ic:'banner',d:'+0.25 expansion speed',c:160,m:{exp:.25},shop:400},
  mason:{n:'Master Mason',ic:'castle',d:'+0.15 defence; buildings cost 15% less',c:160,m:{def:.15,build:-.15},shop:500}}};
/* events: two choices each; fx keys — stab, gold, troops (share of capacity), rel (with every realm), mod {k,v,t,n} = a timed bonus */
const EVENTS=[
  {id:'mongol',t:'Riders from the steppe',x:'A band of Mongol mercenaries offers its bows to your banner.',w:1,
    o:[{l:'Hire them',s:'150 gold: +0.70 expansion speed for 2 minutes',c:150,fx:{mod:{k:'exp',v:.7,t:1200,n:'Mongol mercenaries'}}},{l:'Send them away',s:'Nothing changes',fx:{}}]},
  {id:'harvest',t:'A golden harvest',x:'The barns are full and the villages are merry.',w:1,
    o:[{l:'Hold a feast',s:'+8 stability',fx:{stab:8}},{l:'Fill the treasury',s:'+120 gold',fx:{gold:120}}]},
  {id:'plague',t:'Sickness in the towns',x:'A fever spreads along the trade roads.',w:1,
    o:[{l:'Pay the physicians',s:'120 gold: −3 stability',c:120,fx:{stab:-3}},{l:'Close the gates and wait',s:'−10 stability and a tenth of your troops',fx:{stab:-10,troops:-.1}}]},
  {id:'tourney',t:'A grand tournament',x:'Knights from every shire ask leave to hold a tournament in your name.',w:1,
    o:[{l:'Sponsor it',s:'100 gold: +0.20 attack for 90 seconds, +4 stability',c:100,fx:{stab:4,mod:{k:'atk',v:.2,t:900,n:'Tournament champions'}}},{l:'Decline',s:'−2 stability',fx:{stab:-2}}]},
  {id:'unrest',t:'Peasant unrest',x:'Taxes are heavy and tempers short in the countryside.',w:1,
    o:[{l:'Lower the taxes',s:'−25% gold income for 90 seconds, +6 stability',fx:{stab:6,mod:{k:'gold',v:-.25,t:900,n:'Lowered taxes'}}},{l:'Send the sheriffs',s:'−8 stability, +80 gold',fx:{stab:-8,gold:80}}]},
  {id:'masons',t:'Master builders arrive',x:'A guild of travelling masons seeks a patron.',w:1,
    o:[{l:'Give them work',s:'80 gold: buildings cost 30% less for 2 minutes',c:80,fx:{mod:{k:'build',v:-.3,t:1200,n:'Travelling masons'}}},{l:'Let them pass',s:'Nothing changes',fx:{}}]},
  {id:'fair',t:'A travelling fair',x:'Jugglers, minstrels and merchants ask leave to pitch their tents in your towns.',w:1,
    o:[{l:'Pay for a great fair',s:'100 gold: +10 stability',c:100,fx:{stab:10}},{l:'Let them pitch their tents',s:'+3 stability',fx:{stab:3}}]},
  {id:'deserters',t:'Deserters on the roads',x:'Soldiers without pay have turned to banditry.',w:1,
    o:[{l:'Pay their arrears',s:'90 gold: they return to the ranks (+8% of capacity)',c:90,fx:{troops:.08}},{l:'Hunt them down',s:'−4 stability, +0.15 defence for 90 seconds',fx:{stab:-4,mod:{k:'def',v:.15,t:900,n:'Vigilant garrisons'}}}]},
  {id:'envoys',t:'Envoys from afar',x:'Foreign envoys arrive with gifts and long speeches.',w:1,
    o:[{l:'Receive them with honour',s:'60 gold: every realm thinks better of you',c:60,fx:{rel:10}},{l:'Keep it brief',s:'+40 gold from their gifts',fx:{gold:40}}]},
  {id:'levy',t:'The barons offer men',x:'Your barons will raise extra levies, at a price to the peace of the realm.',w:1,
    o:[{l:'Call the levies',s:'+15% of capacity in troops, −6 stability',fx:{troops:.15,stab:-6}},{l:'Let the fields be worked',s:'+3 stability',fx:{stab:3}}]}];
function realmPool(cfg,R){const B=cfg.b,src=cfg.r==='britain'?R.BRIT:cfg.r==='europe'?R.REALMS.concat(R.EURO):cfg.r==='med'?R.REALMS.concat(R.EURO,R.MEDX):cfg.r==='asia'?R.REALMS.concat(R.ASIAX):cfg.r==='all'?R.REALMS.concat(R.EURO,R.MEDX,R.ASIAX):R.REALMS,seen=new Set();
  return src.filter(r=>r[2]>B[0]+.4&&r[2]<B[1]-.4&&r[1]<B[2]-.4&&r[1]>B[3]+.3&&!seen.has(r[0])&&seen.add(r[0]))}
const bCost=(t,count,m)=>Math.round(BT[t].c*(1+CFG.buildStep*count)*m.build);
const uCost=(t,lv,m)=>Math.round(BT[t].c*CFG.upStep*(lv+1)*m.build);
const catRange=lv=>CFG.catRange+CFG.catRangeLv*(lv-1);
const catBlast=(lv,m)=>CFG.catBlast+(lv>=3?1:0)+(lv>=5?1:0)+(m?m.blast:0);
const fortRadius=lv=>CFG.fortR+lv-1;
const fortMult=lv=>CFG.fortBase+CFG.fortLv*(lv-1);
/*RULES*/
/* ================= one match: the same rules run in campaigns (inside the page) and in multiplayer (on the server) =================
   o: {W,H,terrain,land,B,map,reg,realms:[[name,lat,lon]],seats:[{name,color,conn,owned,culture,at}],bots,spawnTicks,diff:{gm,ag},rewardX,solo}
   a seat's conn gets send(object) and bin(code,typedArray). */
function createGame(o){
  const W=o.W,H=o.H,N=W*H,terrain=o.terrain,owner=new Uint8Array(N),fort=new Int32Array(N),fortL=new Uint8Array(N),B=o.B,landCount=o.land,solo=!!o.solo;
  const players=[],bfsPar=new Int32Array(N),bfsQ=new Int32Array(N),bfsSeen=new Uint32Array(N),pathCache=new Map(),spawns=[];
  const wars=new Map(),allyUntil=new Map(),allyWarned=new Set(),pacts=new Set(),truce=new Map(),pending=new Map();
  let buildings=[],armies=[],boats=[],trade=[],shots=[],warships=[],delta=[],events=[],clashes=[];
  let tick=0,phase='spawn',over=false,bfsBudget=0,bfsGen=0,P=0,adj=null,atk=null,rel=null,uid=1;
  const SPAWN=o.spawnTicks||0,DIFF=Object.assign({gm:1,ag:.85,grace:900,gang:2,hate:1,shield:.3,cap:1},o.diff||{});
  const pick=a=>a[Math.random()*a.length|0],rnd=(a,b)=>a+Math.random()*(b-a);
  const pk=(a,b)=>a<b?a*256+b:b*256+a;
  const allied=(a,b)=>a>0&&b>0&&a!==b&&allyUntil.has(pk(a,b));
  const war=(a,b)=>a>0&&b>0&&wars.has(pk(a,b));
  const pact=(a,b)=>pacts.has(pk(a,b));
  const send=(p,m)=>{if(p&&p.conn)p.conn.send(m)};
  const tell=(pid,s,k)=>{const p=players[pid];if(p&&p.conn)p.conn.send({t:'toast',s,k:k||''})};
  const tellAll=(s,k)=>{for(const p of players)if(p.conn)p.conn.send({t:'toast',s,k:k||''})};
  const boom=(x,y,r)=>events.push(['fx',x,y,r]);
  const clash=i=>{if(clashes.length<80)clashes.push(i)};
  const humans=()=>players.filter(p=>p.conn);
  const dist=(i,j)=>Math.hypot(i%W-j%W,((i/W)|0)-((j/W)|0));
  function nbs(i){const r=[],x=i%W;if(x>0)r.push(i-1);if(x<W-1)r.push(i+1);if(i>=W)r.push(i-W);if(i<N-W)r.push(i+W);return r}
  function setOwner(i,id){players[owner[i]].tiles--;owner[i]=id;players[id].tiles++;delta.push((i<<8|id)>>>0)}
  const addRel=(a,b,v)=>{if(a>0&&b>0&&a!==b){const x=Math.max(-100,Math.min(100,rel[a*P+b]+v));rel[a*P+b]=rel[b*P+a]=x}};

  /* ---------- realm modifiers, capacity, income ---------- */
  function recalc(p){
    const m=Object.assign({},M_BASE),ap=q=>{for(const k in q)m[k]+=q[k]};
    for(const d of POLICIES[p.culture])if(p.pol.has(d.id))ap(d.m);
    for(const k of p.court)ap(COURTIERS[p.culture][k].m);
    for(const x of p.mods)m[x.k]+=x.v;
    m.atk+=CFG.castleAtk*Math.min(5,p.castle);
    for(const k of['atk','def','exp','grow','gold','cap','sail','trade'])m[k]=Math.max(.2,m[k]);
    for(const k of['build','navy','reload'])m[k]=Math.max(.3,m[k]);
    m.pacts+=CFG.maxPacts;p.m=m}
  const stabF=p=>.5+p.stab/100;                                     // recruitment only: 0.5× at 0, 1× at 50, 1.5× at 100
  const maxTroops=p=>(CFG.capBase+CFG.capTile*Math.pow(Math.max(0,p.tiles),CFG.capPow)+p.cityCap+p.castleLv*CFG.castleCap)*p.m.cap;
  const upkeep=p=>p.fleet.length*SHIPS[0].up+p.wsUp;
  const income=p=>(CFG.taxBase+CFG.taxTile*Math.sqrt(Math.max(0,p.tiles))+p.cityLv*CFG.cityInc+p.portLv*CFG.portInc+p.nPact*CFG.pactInc*p.m.trade+p.nAlly*CFG.allyInc)*p.m.gold-upkeep(p);
  const costOf=(p,t)=>bCost(t,p[t],p.m);
  function addStab(p,v){if(v<0)v*=1-Math.min(.9,p.m.guard);p.stab=Math.max(0,Math.min(100,p.stab+v))}
  function addMod(p,x){p.mods.push({k:x.k,v:x.v,until:tick+x.t,n:x.n});recalc(p)}

  /* ---------- map helpers ---------- */
  function claimSpawn(p,cx,cy){
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){if(dx*dx+dy*dy>12)continue;const x=cx+dx,y=cy+dy;if(x<0||y<0||x>=W||y>=H)continue;
      const i=y*W+x;if(terrain[i]&&owner[i]===0)setOwner(i,p.id)}
    p.cx=cx;p.cy=cy;p.cap=cy*W+cx;p.spawned=true;spawns.push([cx,cy])}
  function nearLand(x,y){
    for(let r=0;r<14;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;const X=x+dx,Y=y+dy;if(X<1||Y<1||X>=W-1||Y>=H-1)continue;
      const i=Y*W+X;if(terrain[i]&&!owner[i])return i}
    return -1}
  const far=(x,y,m)=>spawns.every(s=>Math.hypot(s[0]-x,s[1]-y)>=m);
  function randomSpawn(p){for(let n=0;n<30000;n++){const x=4+(Math.random()*(W-8)|0),y=4+(Math.random()*(H-8)|0),i=y*W+x;
      if(terrain[i]&&terrain[i]!==3&&!owner[i]&&far(x,y,n<10000?12:n<20000?6:3)){claimSpawn(p,x,y);return true}}return false}
  function randOwn(p,test){const r=Math.sqrt(p.tiles)*.95+1;
    for(let n=0;n<50;n++){const x=Math.round(p.cx+(Math.random()*2-1)*r),y=Math.round(p.cy+(Math.random()*2-1)*r);
      if(x<0||y<0||x>=W||y>=H)continue;const i=y*W+x;if(owner[i]===p.id&&(!test||test(i)))return i}
    return -1}
  function randBorder(p,d){const r=Math.sqrt(p.tiles)*1.25+3;                // a tile of realm d near realm p, to aim an offensive at
    for(let n=0;n<40;n++){const x=Math.round(p.cx+(Math.random()*2-1)*r),y=Math.round(p.cy+(Math.random()*2-1)*r);
      if(x<1||y<1||x>=W-1||y>=H-1)continue;const i=y*W+x;if(!terrain[i]||owner[i]!==d)continue;
      for(let q=1;q<=3;q++)if(owner[i-q]===p.id||owner[i+q]===p.id||owner[i-q*W]===p.id||owner[i+q*W]===p.id)return i}
    return -1}
  function newCapital(p){let best=-1,bl=0;for(const b of buildings)if(b.t==='city'&&owner[b.i]===p.id&&b.lv>bl){bl=b.lv;best=b.i}if(best>=0)return best;
    const i=randOwn(p);if(i>=0)return i;for(let k=0;k<N;k++)if(owner[k]===p.id&&terrain[k])return k;return -1}
  function computeAdj(){
    adj.fill(0);const sx=new Float64Array(P),sy=new Float64Array(P);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(!terrain[i])continue;const oo=owner[i];sx[oo]+=x;sy[oo]+=y;
      if(x<W-1&&terrain[i+1]){const o2=owner[i+1];if(o2!==oo){adj[oo*P+o2]++;adj[o2*P+oo]++}}
      if(y<H-1&&terrain[i+W]){const o2=owner[i+W];if(o2!==oo){adj[oo*P+o2]++;adj[o2*P+oo]++}}}
    for(const p of players){if(p.id&&p.tiles>0){p.cx=sx[p.id]/p.tiles;p.cy=sy[p.id]/p.tiles}p.city=p.castle=p.port=p.cat=p.cityLv=p.portLv=p.castleLv=p.cityCap=0;p.nPact=p.nAlly=0}
    for(const b of buildings){const oo=owner[b.i];
      if(oo!==b.o){const big=b.t==='city'||b.t==='castle';if(b.o>0&&players[b.o].alive)addStab(players[b.o],big?CFG.stabLoseBig:CFG.stabLoseSmall);if(oo>0&&b.o>0&&big)addStab(players[oo],CFG.stabTake);b.o=oo}
      if(!oo)continue;const p=players[oo];p[b.t]++;
      if(b.t==='city'){p.cityLv+=b.lv;p.cityCap+=CFG.cityCap+CFG.cityCapLv*(b.lv-1)}else if(b.t==='port')p.portLv+=b.lv;else if(b.t==='castle')p.castleLv+=b.lv}
    for(const k of pacts){players[k>>8].nPact++;players[k&255].nPact++}
    for(const k of allyUntil.keys()){players[k>>8].nAlly++;players[k&255].nAlly++}
    for(const p of players)if(p.id&&p.alive)recalc(p)}
  function rebuildFort(){fort.fill(0);fortL.fill(0);
    for(const b of buildings){if(b.t!=='castle')continue;const cx=b.i%W,cy=(b.i/W)|0,R=fortRadius(b.lv);
      for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){if(dx*dx+dy*dy>R*R)continue;const x=cx+dx,y=cy+dy;if(x<0||y<0||x>=W||y>=H)continue;
        const i=y*W+x;if(b.lv>=fortL[i]){fort[i]=b.i+1;fortL[i]=b.lv}}}}
  function landLinked(tile,a){
    const d=owner[tile],g=++bfsGen,q=bfsQ;let qt=0;q[qt++]=tile;bfsSeen[tile]=g;
    for(let h=0;h<qt;h++){const i=q[h],x=i%W;
      for(let n=0;n<4;n++){const j=n===0?(x>0?i-1:-1):n===1?(x<W-1?i+1:-1):n===2?i-W:i+W;if(j<0||j>=N||!terrain[j])continue;
        if(owner[j]===a)return true;if(bfsSeen[j]!==g&&owner[j]===d){bfsSeen[j]=g;q[qt++]=j}}}
    return false}

  /* ---------- armies: every order raises its own army; armies sharing a front reinforce and merge ---------- */
  function addArmy(a,d,troops,focus){
    const f=focus>=0?focus:-1;
    for(const at of armies)if(at.a===a&&at.d===d&&!at.dead&&((f<0&&at.f<0)||(f>=0&&at.f>=0&&dist(f,at.f)<=Math.max(at.R,CFG.mergeR)))){at.troops+=troops;return at}
    const at={id:uid++,a,d,troops,f,R:CFG.sector,dead:0};armies.push(at);return at}
  function launchAttack(a,d,troops,focus,noShield){
    const A=players[a];troops=Math.min(Math.floor(troops),Math.floor(A.troops));if(troops<1)return false;
    if(d&&!war(a,d))return false;
    A.troops-=troops;addArmy(a,d,troops,focus);
    if(d&&!noShield){const D=players[d];                               // the shield: the defender meets the attack with an equal force
      if(D.shield&&D.alive){const c=Math.min(troops,Math.floor(D.troops*(D.isBot?DIFF.shield:CFG.shieldMax)));if(c>=20)launchAttack(d,a,c,focus,true)}}
    return true}
  function endArmy(at,loss){if(at.dead)return;at.dead=1;const A=players[at.a];if(A.alive)A.troops+=Math.max(0,at.troops*(1-(loss||0)))}
  function cancelArmy(p,id){const at=armies.find(x=>x.id===id&&x.a===p.id&&!x.dead);if(!at)return;
    const loss=at.d?rnd(CFG.cancelLoss[0],CFG.cancelLoss[1]):0;endArmy(at,loss);
    tell(p.id,at.d?`Your army is recalled; ${Math.round(at.troops*loss)} men are lost on the way home.`:'Your army is recalled.')}
  function processArmies(){
    for(const at of armies)if(!at.dead&&(!players[at.a].alive||(at.d&&!war(at.a,at.d))))endArmy(at,0);
    for(let k=armies.length-1;k>0;k--){const x=armies[k];if(x.dead)continue;                       // armies whose sectors meet become one
      for(let j=0;j<k;j++){const y=armies[j];if(y.dead||x.a!==y.a||x.d!==y.d)continue;
        if((x.f<0&&y.f<0)||(x.f>=0&&y.f>=0&&dist(x.f,y.f)<Math.min(x.R,y.R))){y.troops+=x.troops;y.R=Math.max(x.R,y.R);x.dead=1;x.troops=0;break}}}
    if(armies.some(a=>a.dead))armies=armies.filter(a=>!a.dead);
    if(!armies.length)return;
    atk.fill(-1);const def=new Uint8Array(P),pairs=[];
    for(const at of armies){let k=atk[at.a*P+at.d];if(k<0){k=pairs.length;pairs.push({c:[],l:[]});atk[at.a*P+at.d]=k}pairs[k].l.push(at);def[at.d]=1}
    for(let y=0;y<H;y++){const row=y*W;for(let x=0;x<W;x++){
      const i=row+x;if(!terrain[i])continue;const d=owner[i];if(!def[d])continue;
      let a,k,last=-1;
      if(x>0&&(a=owner[i-1])!==d&&a&&(k=atk[a*P+d])>=0){pairs[k].c.push(i);last=k}
      if(x<W-1&&(a=owner[i+1])!==d&&a&&(k=atk[a*P+d])>=0&&k!==last){pairs[k].c.push(i);last=k}
      if(y>0&&(a=owner[i-W])!==d&&a&&(k=atk[a*P+d])>=0&&k!==last){pairs[k].c.push(i);last=k}
      if(y<H-1&&(a=owner[i+W])!==d&&a&&(k=atk[a*P+d])>=0&&k!==last)pairs[k].c.push(i)}}
    for(const at of armies){if(!at.d||at.a>at.d)continue;const k2=atk[at.d*P+at.a];if(k2<0)continue;      // opposing armies on one front bleed each other
      for(const ot of pairs[k2].l){if(at.f>=0&&ot.f>=0&&dist(at.f,ot.f)>at.R+ot.R)continue;
        const l=Math.min(at.troops,ot.troops)*CFG.clash+.5,A=players[at.a],O=players[ot.a];
        at.troops=Math.max(0,at.troops-l*O.m.atk/A.m.def);ot.troops=Math.max(0,ot.troops-l*A.m.atk/O.m.def);
        if(at.f>=0&&Math.random()<.3)clash(at.f)}}
    for(const pr of pairs){const cand=pr.c;
      for(const at of pr.l){
        const a=at.a,d=at.d,A=players[a],D=players[d];
        if(!cand.length||at.troops<1){endArmy(at,0);continue}
        let front=cand;
        if(at.f>=0){                                        // only the sector around the ordered point is fought over; it widens slowly
          const fx0=at.f%W,fy0=(at.f/W)|0,ds=new Float32Array(cand.length);let dm=1e9;
          for(let n=0;n<cand.length;n++){const i=cand[n],dx=i%W-fx0,dy=((i/W)|0)-fy0,q=dx*dx+dy*dy;ds[n]=q;if(q<dm)dm=q}
          at.R=Math.min(CFG.sectorMax,at.R+CFG.sectorGrow);const r=Math.max(at.R,Math.sqrt(dm)+4),r2=r*r;front=[];
          for(let n=0;n<cand.length;n++)if(ds[n]<=r2)front.push(cand[n])}
        if(d){const k2=atk[d*P+a];let held=false;                 // a stronger army coming the other way holds this front: the line moves one way only
          if(k2>=0)for(const ot of pairs[k2].l)if(!ot.dead&&ot.troops>at.troops&&(at.f<0||ot.f<0||dist(at.f,ot.f)<=at.R+ot.R)){held=true;break}
          if(held){if(front.length&&Math.random()<.4)clash(front[Math.random()*front.length|0]);continue}}
        const dens=d?D.troops/Math.max(1,D.tiles):0,n=front.length,S=n>20?(n%7?7:n%11?11:13):1,start=Math.random()*n|0;
        let budget=Math.max(1,Math.round(n*Math.min(.5,.2*A.m.exp))),done=false;
        for(let pass=0;pass<2&&budget>0&&!done;pass++)for(let q=0;q<n&&budget>0;q++){   // dents in the line are filled first, so the front advances as a line
          const i=front[(start+q*S)%n];if(owner[i]!==d)continue;
          if(pass===0){const x=i%W;let na=0;if(x>0&&owner[i-1]===a)na++;if(x<W-1&&owner[i+1]===a)na++;if(i>=W&&owner[i-W]===a)na++;if(i<N-W&&owner[i+W]===a)na++;if(na<2)continue}
          let res=CFG.tile*CFG.terr[terrain[i]];
          if(d){const f=fort[i];res+=dens*1.05*(f&&owner[f-1]===d?fortMult(fortL[i]):1)*D.m.def}
          res/=A.m.atk;
          if(at.troops<res){done=true;break}
          at.troops-=res;if(d)D.troops=Math.max(0,D.troops-dens*.55);setOwner(i,a);budget--}
        if(done)endArmy(at,0)}}
    armies=armies.filter(a=>!a.dead)}

  /* ---------- the sea ---------- */
  function shipXY(path,k){const a=path[Math.min(k|0,path.length-1)],b=path[Math.min((k|0)+1,path.length-1)],f=k-(k|0);
    return[(a%W)+((b%W)-(a%W))*f,((a/W)|0)+(((b/W)|0)-((a/W)|0))*f]}
  function waterNear(i){if(i<0)return -1;if(!terrain[i])return i;for(const j of nbs(i))if(!terrain[j])return j;return -1}
  function waterPath(from,to,limit){
    if(from<0||to<0||terrain[from]||terrain[to])return null;
    const par=bfsPar,q=bfsQ,seen=bfsSeen,g=++bfsGen;let qt=0,qh=0;q[qt++]=to;seen[to]=g;par[to]=-2;
    while(qh<qt&&qh<limit){const i=q[qh++];
      if(i===from){const p=[];for(let j=from;j!==-2;j=par[j])p.push(j);return p}
      const x=i%W;
      for(let n=0;n<4;n++){const j=n===0?(x>0?i-1:-1):n===1?(x<W-1?i+1:-1):n===2?i-W:i+W;if(j<0||j>=N||terrain[j]||seen[j]===g)continue;seen[j]=g;par[j]=i;q[qt++]=j}}
    return null}
  function seaPath(from,to){const kk=from*N+to;if(pathCache.has(kk))return pathCache.get(kk);
    if(bfsBudget<=0)return undefined;bfsBudget--;
    const p=waterPath(waterNear(from),waterNear(to),220000);pathCache.set(kk,p);return p}
  const myPorts=id=>buildings.filter(b=>b.t==='port'&&owner[b.i]===id);
  function buildCog(p){
    const S=SHIPS[0],cost=Math.round(S.c*p.m.navy);
    if(p.port<1)return 'You need a port to build ships';if(p.gold<cost)return 'Not enough gold';
    p.gold-=cost;p.fleet.push({c:0,busy:tick+S.bt});return ''}
  function stationShip(p,c,port){
    const S=SHIPS[c];if(!S||c<1)return 'x';
    if(!buildings.some(b=>b.t==='port'&&b.i===port&&owner[b.i]===p.id))return 'Choose one of your own ports';
    if(S.req&&!S.req(p))return S.rq;const cost=Math.round(S.c*p.m.navy);if(p.gold<cost)return 'Not enough gold';
    const w=waterNear(port);if(w<0)return 'That port has no open water';
    p.gold-=cost;warships.push({id:uid++,a:p.id,c,hp:S.hp,x:w%W,y:(w/W)|0,home:port,ax:w%W,ay:(w/W)|0,st:'patrol',path:null,k:0,tg:null,wait:S.bt});return ''}
  function moveShip(p,id,tile){                           // galleys and carracks go where they are sent and patrol there
    const s=warships.find(w=>w.id===id&&w.a===p.id);if(!s)return 'That ship is gone';
    if(s.wait>0)return 'That ship is still being built';
    let t=tile;if(terrain[t])t=waterNear(t);if(t<0||terrain[t])return 'Ships can only sail on water';
    const path=waterPath(Math.round(s.y)*W+Math.round(s.x),t,120000);if(!path)return 'There is no sea route to that spot';
    s.path=path;s.k=0;s.st='move';s.tg=null;s.ax=t%W;s.ay=(t/W)|0;return ''}
  function launchBoat(p,tile,troops){                     // a Cog carries the landing force from the nearest friendly port
    troops=Math.min(Math.floor(troops),Math.floor(p.troops));if(troops<20)return 'Not enough troops';
    const S=SHIPS[0],d=owner[tile];
    if(d===p.id)return 'x';if(d&&!war(p.id,d))return 'Declare war before you land troops there';
    const ports=myPorts(p.id);if(!ports.length)return 'You need a port to send troops by sea';
    const fr=p.fleet.filter(f=>f.busy<=tick);
    if(!fr.length)return p.fleet.length?'All your Cogs are at sea or still on the slipway':'You need a Cog to carry troops by sea — build one in the Navy panel';
    troops=Math.min(troops,S.cap);let L=-1;
    {const g=++bfsGen,q=bfsQ;let qt=0;q[qt++]=tile;bfsSeen[tile]=g;
      for(let h=0;h<qt&&L<0&&h<60000;h++){const i=q[h];for(const j of nbs(i)){
        if(!terrain[j]){L=i;break}
        if(bfsSeen[j]!==g&&owner[j]===d){bfsSeen[j]=g;q[qt++]=j}}}}
    if(L<0)return 'That land has no coast to land on';
    const goalSet=new Set();for(const b of ports){const w=waterNear(b.i);if(w>=0)goalSet.add(w)}
    if(!goalSet.size)return 'Your ports have no open water';
    const par=bfsPar,q=bfsQ,seen=bfsSeen,g=++bfsGen;let qt=0,qh=0,goal=-1;
    for(const j of nbs(L))if(!terrain[j]){par[j]=-2;seen[j]=g;q[qt++]=j;if(goalSet.has(j))goal=j}
    while(qh<qt&&goal<0){const i=q[qh++],x=i%W;
      for(let n=0;n<4;n++){const j=n===0?(x>0?i-1:-1):n===1?(x<W-1?i+1:-1):n===2?i-W:i+W;if(j<0||j>=N||terrain[j]||seen[j]===g)continue;
        seen[j]=g;par[j]=i;q[qt++]=j;if(goalSet.has(j)){goal=j;break}}}
    if(goal<0)return 'There is no sea route from your ports to that land';
    const path=[];for(let i=goal;i!==-2;i=par[i])path.push(i);
    const v=S.v*p.m.sail,ship=fr[0];p.troops-=troops;ship.busy=tick+Math.ceil(path.length/v)*2+20;
    boats.push({a:p.id,troops,path,k:0,L,v,c:0,hp:S.hp,ship});return ''}
  function sinkBoat(b,by){
    const n=boats.indexOf(b);if(n<0)return;boats.splice(n,1);const q=shipXY(b.path,b.k);boom(q[0]|0,q[1]|0,2);
    const A=players[b.a];A.fleet=A.fleet.filter(f=>f!==b.ship);
    addStab(A,CFG.stabShip);tell(b.a,`Your Cog was sunk by ${players[by].name} with ${Math.round(b.troops)} troops aboard!`,'bad');tell(by,`Your fleet sank a troop ship of ${A.name}!`,'good')}
  function processBoats(){
    for(let n=boats.length-1;n>=0;n--){
      const b=boats[n];b.k+=b.v;if(b.k<b.path.length)continue;
      boats.splice(n,1);const A=players[b.a];if(!A.alive)continue;
      const d=owner[b.L];
      if(d===b.a||allied(b.a,d)||(d&&!war(b.a,d))){A.troops+=b.troops;continue}
      setOwner(b.L,b.a);const lx=b.L%W,ly=(b.L/W)|0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=lx+dx,y=ly+dy;if(x<0||y<0||x>=W||y>=H)continue;const i=y*W+x;if(terrain[i]&&owner[i]===d)setOwner(i,b.a)}
      addArmy(b.a,d,Math.max(0,b.troops-CFG.tile*CFG.terr[terrain[b.L]]),b.L);
      if(d)tell(d,`${A.name} has landed troops on your shore!`,'bad');tell(b.a,`Your Cog has landed ${Math.round(b.troops)} troops.`)}}
  function tickTrade(){
    for(let n=trade.length-1;n>=0;n--){const s=trade[n],A=players[s.a];s.k+=CFG.tradeV*A.m.sail;if(s.k<s.path.length)continue;trade.splice(n,1);
      if(!A.alive)continue;
      if(s.cap){A.gold+=s.val;A.tradeG+=s.val;tell(s.a,`The captured merchantman reached your port: +${Math.round(s.val)} gold.`,'coin');continue}
      const oo=owner[s.to];if(!oo||oo===s.a||war(s.a,oo))continue;
      const dp=buildings.find(b=>b.i===s.to&&b.t==='port'),lv=dp?dp.lv:1;
      const g=(CFG.tradeBase+s.path.length*CFG.tradeLen)*(1+CFG.tradePortLv*(lv-1))*A.m.trade*(pact(s.a,oo)||allied(s.a,oo)?1.5:1);
      A.gold+=g;A.tradeG+=g;players[oo].gold+=g*CFG.tradePartner;players[oo].tradeG+=g*CFG.tradePartner;events.push(['tp',s.a,s.to,Math.round(g)])}
    if(tick%10)return;bfsBudget=2;
    for(const b of buildings){if(b.t!=='port')continue;const oo=owner[b.i];if(!oo||tick<b.next)continue;
      b.next=tick+CFG.tradeGap;
      const bx=b.i%W,by=(b.i/W)|0;let best=null,bd=1e9;
      for(const p of buildings){if(p.t!=='port'||p===b)continue;const po=owner[p.i];if(!po||po===oo||war(oo,po))continue;
        const d=Math.hypot(p.i%W-bx,((p.i/W)|0)-by)*(.6+Math.random()*.8)/(1+.1*(p.lv-1));if(d<bd&&d<280){bd=d;best=p}}
      if(!best)continue;const path=seaPath(b.i,best.i);
      if(path===undefined){b.next=tick+10;continue}
      if(path){trade.push({a:oo,from:b.i,to:best.i,path,k:0,hp:CFG.tradeHp});b.next=tick+Math.ceil(path.length/CFG.tradeV*.45)+50+Math.random()*60}}}
  function nearPort(a,x,y){let best=-1,bd=1e9;for(const b of buildings){if(b.t!=='port'||owner[b.i]!==a)continue;const d=Math.hypot(b.i%W-x,((b.i/W)|0)-y);if(d<bd){bd=d;best=b.i}}return best}
  function tickNavy(){
    for(const p of players)p.wsUp=0;
    for(let n=warships.length-1;n>=0;n--){
      const s=warships[n],S=SHIPS[s.c],A=players[s.a];
      if(!A.alive||s.hp<=0){if(s.hp<=0){boom(s.x|0,s.y|0,2);tell(s.a,`Your ${S.n} has been sunk!`,'bad')}warships.splice(n,1);continue}
      A.wsUp+=S.up;
      if(s.wait>0){s.wait--;continue}
      const v=S.v*A.m.sail,here=Math.round(s.y)*W+Math.round(s.x);
      const sail=sp=>{s.k+=sp;const q=shipXY(s.path,s.k);s.x=q[0];s.y=q[1];return s.k>=s.path.length-1};
      if(owner[s.home]!==s.a||!buildings.some(b=>b.i===s.home&&b.t==='port')){const np=nearPort(s.a,s.x,s.y);if(np>=0)s.home=np}
      const homeOk=owner[s.home]===s.a;
      if(s.st==='repair'){s.hp=Math.min(S.hp,s.hp+S.hp/CFG.repair);if(s.hp>=S.hp||!homeOk){s.st='patrol';s.path=null}continue}
      if(s.st!=='return'&&s.hp<S.hp*.35&&homeOk){s.st='return';s.path=null;s.tg=null}
      if(s.st==='return'){
        if(!homeOk){s.st='patrol';s.path=null;continue}
        if(!s.path){s.path=waterPath(here,waterNear(s.home),60000);s.k=0;if(!s.path){s.st='patrol';continue}}
        if(sail(v)){s.st='repair';s.path=null}
        continue}
      if(s.st==='move'){if(!s.path||sail(v)){s.st='patrol';s.path=null}continue}
      if((tick+n)%5===0){                                 // look for prey: enemy warships first, then troop ships, then merchantmen
        let best=null,bd=S.rng;
        const see=(x,y,bias)=>{const d=Math.hypot(x-s.x,y-s.y)+bias;if(d<bd&&Math.hypot(x-s.ax,y-s.ay)<CFG.sightR){bd=d;return true}return false};
        for(const w of warships)if(w.wait<=0&&w.hp>0&&war(s.a,w.a)&&see(w.x,w.y,-3))best={k:'w',o:w};
        for(const w of boats)if(war(s.a,w.a)){const q=shipXY(w.path,w.k);if(see(q[0],q[1],-1))best={k:'b',o:w}}
        for(const w of trade)if(war(s.a,w.a)){const q=shipXY(w.path,w.k);if(see(q[0],q[1],0))best={k:'t',o:w}}
        s.tg=best;if(s.st==='chase'&&!best){s.st='patrol';s.path=null}}
      if(s.tg){
        const t=s.tg,w=t.o,ok=t.k==='w'?(w.hp>0&&warships.includes(w)&&war(s.a,w.a)):t.k==='b'?boats.includes(w):(trade.includes(w)&&w.a!==s.a);
        if(!ok){s.tg=null;s.st='patrol';s.path=null;continue}
        const q=t.k==='w'?[w.x,w.y]:shipXY(w.path,w.k),d=Math.hypot(q[0]-s.x,q[1]-s.y);
        if(d<=S.rng*CFG.shipRange){                         // in range: the ship holds its distance and fires
          if((tick+n)%4===0)events.push(['vol',Math.round(s.x*10),Math.round(s.y*10),Math.round(q[0]*10),Math.round(q[1]*10)]);
          if(t.k==='w'){w.hp-=S.atk/10;if(w.hp<=0)addStab(players[w.a],CFG.stabShip);if(!w.tg&&w.st!=='return'&&w.st!=='repair'&&SHIPS[w.c].atk)w.tg={k:'w',o:s}}
          else if(t.k==='b'){w.hp-=S.atk/10;if(w.hp<=0)sinkBoat(w,s.a)}
          else if((w.hp=(w.hp==null?CFG.tradeHp:w.hp)-S.atk/10)<=0){     // a crippled merchantman strikes its colours: it now sails for the captor's port and pays there
            const was=w.a,val=(CFG.tradeBase+w.path.length*CFG.tradeLen)*A.m.trade,tp=Math.round(q[1])*W+Math.round(q[0]),np=homeOk?waterPath(tp,waterNear(s.home),80000):null;
            tell(was,`${A.name} seized one of your merchant ships!`,'bad');addStab(players[was],CFG.stabTrade);w.hp=CFG.tradeHp;
            if(np){w.a=s.a;w.cap=1;w.val=val;w.to=s.home;w.path=np;w.k=0;tell(s.a,`Your ${S.n} seized a merchantman of ${players[was].name}. It is sailing to your port.`,'coin')}
            else{trade.splice(trade.indexOf(w),1);A.gold+=val*.5}
            s.tg=null}
          continue}
        s.st='chase';
        if(!s.path||(tick+n)%10===0){s.path=waterPath(here,Math.round(q[1])*W+Math.round(q[0]),6000);s.k=0}
        if(s.path)sail(v);else{s.tg=null;s.st='patrol'}
        continue}
      if(!s.path){                                        // patrol: wander between points of open water around the station
        for(let tr=0;tr<10&&!s.path;tr++){const x=Math.round(s.ax+(Math.random()*2-1)*CFG.patrolR),y=Math.round(s.ay+(Math.random()*2-1)*CFG.patrolR);
          if(x<0||y<0||x>=W||y>=H||terrain[y*W+x])continue;s.path=waterPath(here,y*W+x,5000);s.k=0}
        if(!s.path)s.wait=20}
      else if(sail(v*.6))s.path=null}}
  function annexPockets(){                                // enemy land that is cut off and ringed by one realm at war with it falls to that realm
    if(!wars.size)return;
    const lab=bfsPar,q=bfsQ,comps=[],big=new Int32Array(P).fill(-1);lab.fill(-1);let qe=0;
    for(let s0=0;s0<N;s0++){if(!terrain[s0]||lab[s0]>=0)continue;
      const oo=owner[s0],ci=comps.length,qs=qe;let nb=-2,open=false;q[qe++]=s0;lab[s0]=ci;
      for(let h=qs;h<qe;h++){const i=q[h],x=i%W;
        for(let n=0;n<4;n++){const j=n===0?(x>0?i-1:-1):n===1?(x<W-1?i+1:-1):n===2?i-W:i+W;
          if(j<0||j>=N||!terrain[j]){open=true;continue}
          const oj=owner[j];if(oj===oo){if(lab[j]<0){lab[j]=ci;q[qe++]=j}}else nb=nb===-2?oj:nb===oj?nb:-1}}
      comps.push({o:oo,qs,qe,nb,open});
      if(oo&&(big[oo]<0||qe-qs>comps[big[oo]].qe-comps[big[oo]].qs))big[oo]=ci}
    for(let ci=0;ci<comps.length;ci++){const c=comps[ci],size=c.qe-c.qs;
      if(c.o<=0||c.nb<=0||!war(c.nb,c.o))continue;
      // land ringed completely by one enemy falls at once, even a realm's heartland; a piece cut off against the sea falls too,
      // unless it is the realm's main body or a beach-head whose army is still fighting
      if(c.open&&(big[c.o]===ci||size>players[c.o].tiles*.5||armies.some(at=>at.a===c.o&&at.d===c.nb)))continue;
      const D=players[c.o];if(size>=15)addStab(players[c.nb],CFG.stabEncircle);D.troops=Math.max(0,D.troops-D.troops/Math.max(1,D.tiles)*size*.6);
      for(let h=c.qs;h<c.qe;h++)setOwner(q[h],c.nb);
      if(size>=15){tell(c.nb,`Encircled! ${size} tiles of ${D.name} fall to you.`,'good');tell(c.o,`${players[c.nb].name} encircled and annexed ${size} of your tiles!`,'bad')}}}

  /* ---------- buildings and catapults ---------- */
  const coastal=i=>nbs(i).some(j=>!terrain[j]);
  function build(p,t,i){
    if(!BT[t])return 'x';
    if(!(i>=0&&i<N))return 'x';
    if(t==='port'&&!(owner[i]===p.id&&coastal(i))){                    // a port snaps to the nearest stretch of your own coast
      const x0=i%W,y0=(i/W)|0,R=CFG.portSnap;let best=-1,bd=1e9;
      for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){const x=x0+dx,y=y0+dy;if(x<0||y<0||x>=W||y>=H)continue;const j=y*W+x;
        if(owner[j]===p.id&&terrain[j]&&coastal(j)){const d=dx*dx+dy*dy;if(d<bd){bd=d;best=j}}}
      if(best<0)return 'A port must be built on your own coast';i=best}
    if(owner[i]!==p.id||!terrain[i])return 'You can only build on your own land';
    const x=i%W,y=(i/W)|0,G=CFG.buildGap;
    for(const b of buildings)if(Math.abs(b.i%W-x)<G&&Math.abs(((b.i/W)|0)-y)<G)return 'Too close to another building';
    const c=costOf(p,t);if(p.gold<c)return 'Not enough gold';
    p.gold-=c;p[t]++;buildings.push({t,i,lv:1,o:p.id,cd:0,cm:CFG.catReload,next:tick+40});events.push(['b+',t,i,1]);if(t==='castle')rebuildFort();return ''}
  function upgrade(p,i){
    const b=buildings.find(b=>b.i===i);if(!b||owner[b.i]!==p.id)return 'That is not your building';
    if(b.lv>=BT[b.t].max)return `This ${BT[b.t].n.toLowerCase()} is already at its highest level`;
    const c=uCost(b.t,b.lv,p.m);if(p.gold<c)return 'Not enough gold';
    p.gold-=c;b.lv++;events.push(['bl',b.i,b.lv]);if(b.t==='castle')rebuildFort();return ''}
  function fire(p,bi,tile){
    if(p.gold<CFG.shot)return 'Not enough gold';
    const tx=tile%W,ty=(tile/W)|0;let best=null,far2=true;
    for(const b of buildings){if(b.t!=='cat'||owner[b.i]!==p.id||(bi>=0&&b.i!==bi))continue;
      if(Math.hypot(b.i%W-tx,((b.i/W)|0)-ty)>catRange(b.lv))continue;far2=false;if(b.cd<=tick){best=b;break}}
    if(!best)return far2?'The target is out of range':'That catapult is still reloading';
    p.gold-=CFG.shot;best.cm=Math.max(20,Math.round(CFG.catReload*p.m.reload));best.cd=tick+best.cm;
    const sx=best.i%W,sy=(best.i/W)|0,dur=Math.max(8,Math.hypot(sx-tx,sy-ty)*.5),r=catBlast(best.lv,p.m);
    shots.push({a:p.id,sx,sy,tx,ty,t:0,r,dur});events.push(['shot',p.id,sx,sy,tx,ty,Math.round(dur),r],['cd',best.i,best.cd,best.cm]);return ''}
  function impact(s){
    const hit=new Set(),R=s.r;
    for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){if(dx*dx+dy*dy>R*R+1)continue;const x=s.tx+dx,y=s.ty+dy;if(x<0||y<0||x>=W||y>=H)continue;
      const i=y*W+x,oo=owner[i];if(!terrain[i]||!oo)continue;                  // the stones do not ask whose land it is — your own burns too
      const Dp=players[oo];Dp.troops=Math.max(0,Dp.troops-Dp.troops/Math.max(1,Dp.tiles)*1.5);setOwner(i,0);hit.add(oo)}
    const gone=buildings.filter(b=>Math.hypot(b.i%W-s.tx,((b.i/W)|0)-s.ty)<=Math.max(2,R*.6));
    if(gone.length){buildings=buildings.filter(b=>!gone.includes(b));for(const b of gone){events.push(['b-',b.i]);if(b.o>0&&players[b.o].alive)addStab(players[b.o],b.t==='city'||b.t==='castle'?CFG.stabLoseBig:CFG.stabLoseSmall)}rebuildFort()}
    for(const oo of hit){if(oo===s.a)continue;if(players[oo].isBot&&Math.random()<.5)players[oo].grudge=s.a;
      if(!war(s.a,oo)){if(allied(s.a,oo))breakAlly(s.a,oo);truce.delete(pk(s.a,oo));declareWar(s.a,oo,true);     // bombarding anyone is an act of war
        tell(s.a,`Your bombardment of ${players[oo].name} means war.`,'war');tell(oo,`${players[s.a].name} bombarded your land. You are at war!`,'war')}
      else tell(oo,`${players[s.a].name} bombarded your land!`,'bad')}
    events.push(['fx',s.tx,s.ty,R])}

  /* ---------- diplomacy ---------- */
  function declareWar(a,b,quiet){
    if(a===b||!players[b]||!players[b].alive||war(a,b))return '';
    if(allied(a,b))return 'Break the alliance first';
    if((truce.get(pk(a,b))||0)>tick)return `A truce holds for another ${Math.ceil((truce.get(pk(a,b))-tick)/10)} seconds`;
    wars.set(pk(a,b),tick);addRel(a,b,-40);
    if(pacts.delete(pk(a,b))){for(const p of players)if(p.id&&p.id!==a&&p.id!==b)addRel(a,p.id,-4);tell(a,`Your trade agreement with ${players[b].name} is void, and other realms take note.`)}
    if(!quiet){tell(b,`${players[a].name} has declared war on you!`,'war');tell(a,`You are at war with ${players[b].name}.`,'war')}
    return ''}
  function makePeace(a,b){
    wars.delete(pk(a,b));truce.set(pk(a,b),tick+CFG.truce);
    for(const at of armies)if((at.a===a&&at.d===b)||(at.a===b&&at.d===a))endArmy(at,0);
    for(const s of warships)if(s.tg&&((s.a===a&&s.tg.o.a===b)||(s.a===b&&s.tg.o.a===a))){s.tg=null;s.st='patrol';s.path=null}
    tell(a,`Peace with ${players[b].name}. A truce holds for ${Math.round(CFG.truce/10)} seconds.`,'good');tell(b,`Peace with ${players[a].name}. A truce holds for ${Math.round(CFG.truce/10)} seconds.`,'good')}
  function ally(a,b){const A=players[a],Bp=players[b],dur=Math.round(CFG.allyTicks*Math.max(A.m.ally,Bp.m.ally));
    allyUntil.set(pk(a,b),tick+dur);allyWarned.delete(pk(a,b));addRel(a,b,10);
    const s=`${Math.floor(dur/600)}:${String(Math.round(dur/10)%60).padStart(2,'0')}`;
    tell(a,`You and ${Bp.name} are allies for ${s}.`,'good');tell(b,`You and ${A.name} are allies for ${s}.`,'good')}
  function breakAlly(a,b){allyUntil.delete(pk(a,b));addRel(a,b,-30);for(const p of players)if(p.id&&p.id!==a&&p.id!==b)addRel(a,p.id,-8);
    tell(a,`You broke your alliance with ${players[b].name}. Other realms trust you less.`);tell(b,`${players[a].name} has broken your alliance!`,'bad')}
  const strength=p=>p.troops+armies.reduce((s,at)=>s+(at.a===p.id?at.troops:0),0);
  function botAnswers(k,from,to){                         // rule-based answers of a bot realm `to` to an offer from `from`
    const A=players[from],T=players[to],r=rel[from*P+to]+A.m.dip*15,share=A.tiles/landCount;
    if(k==='ally')return !war(from,to)&&share<.3&&(allied(from,to)?r>-10:r>=-5&&Math.random()<.4+r/80);
    if(k==='pact')return !war(from,to)&&r>-20&&Math.random()<.6+r/100;
    if(k==='peace'){const since=tick-(wars.get(pk(from,to))||tick);return since>200&&(strength(T)<strength(A)*1.15||since>1500||Math.random()<.15+r/200)}
    if(k==='tribute')return strength(A)>=strength(T)*CFG.tributeNeed;
    return false}
  function settle(k,from,to,yes){                         // the outcome of an offer, whoever answered it
    const A=players[from],T=players[to];if(!A.alive||!T.alive)return;
    if(k==='ally'){if(yes&&!war(from,to))ally(from,to);else tell(from,`${T.name} declines an alliance.`)}
    else if(k==='pact'){if(yes&&!war(from,to)&&A.nPact<A.m.pacts&&T.nPact<T.m.pacts){pacts.add(pk(from,to));A.nPact++;T.nPact++;addRel(from,to,10);
        tell(from,`A trade agreement is signed with ${T.name}.`,'coin');tell(to,`A trade agreement is signed with ${A.name}.`,'coin')}else tell(from,`${T.name} declines a trade agreement.`)}
    else if(k==='peace'){if(yes&&war(from,to))makePeace(from,to);else tell(from,`${T.name} refuses to make peace.`)}
    else if(k==='tribute'){if(yes){const g=Math.round(T.gold*CFG.tribute);T.gold-=g;A.gold+=g;addRel(from,to,-25);
        tell(from,`${T.name} pays a tribute of ${g} gold.`,'coin');tell(to,`You paid ${g} gold in tribute to ${A.name}.`,'bad')}
      else{addRel(from,to,-10);tell(from,`${T.name} refuses to pay tribute.`)}}}
  function offer(p,k,id){
    const T=players[id];if(!T||!T.alive||id===p.id||!id)return;
    const ck=k+id;if(tick<(p.askCd[ck]||0))return tell(p.id,`${T.name}'s court asks for time — try again shortly.`);p.askCd[ck]=tick+150;
    if(k==='ally'){if(war(p.id,id))return tell(p.id,'Make peace first.');
      if(allied(p.id,id)&&allyUntil.get(pk(p.id,id))-tick>CFG.allyRenew)return tell(p.id,'The alliance can be renewed in its last minute.')}
    if(k==='pact'){if(pact(p.id,id))return;if(war(p.id,id))return tell(p.id,'Make peace first.');if(p.nPact>=p.m.pacts)return tell(p.id,`You can hold only ${p.m.pacts} trade agreements.`)}
    if(k==='peace'&&!war(p.id,id))return;
    if(k==='tribute'&&(allied(p.id,id)||T.gold<10))return tell(p.id,`${T.name} has nothing to give.`);
    if(T.conn){pending.set(k+'|'+p.id+'|'+id,tick+CFG.askTicks);send(T,{t:'ask',k,id:p.id,name:p.name});if(!p.isBot)tell(p.id,`Your envoys ride to ${T.name}.`)}
    else settle(k,p.id,id,botAnswers(k,p.id,id))}
  function answer(p,k,id,yes){const key=k+'|'+id+'|'+p.id;if(!(pending.get(key)>=tick))return;pending.delete(key);settle(k,id,p.id,!!yes)}
  function gift(p,id){const T=players[id];if(!T||!T.alive||id===p.id)return;const c=Math.max(50,Math.round(p.gold*.1));
    if(p.gold<c)return tell(p.id,'Not enough gold');p.gold-=c;T.gold+=c;addRel(p.id,id,CFG.giftRel);
    tell(p.id,`Your gift of ${c} gold pleases ${T.name}.`,'good');tell(id,`${p.name} sent you a gift of ${c} gold.`,'coin')}
  function diplo(p,a,id){
    id|=0;const T=players[id];if(!T||!id||id===p.id||!T.alive)return;
    if(a==='war'){const e=declareWar(p.id,id);if(e)tell(p.id,e)}
    else if(a==='unally'){if(allied(p.id,id))breakAlly(p.id,id)}
    else if(a==='unpact'){if(pacts.delete(pk(p.id,id))){p.nPact--;T.nPact--;tell(p.id,`You ended the trade agreement with ${T.name}.`);tell(id,`${p.name} ended your trade agreement.`)}}
    else if(a==='gift')gift(p,id);
    else if(a==='ally'||a==='pact'||a==='peace'||a==='tribute')offer(p,a,id)}

  /* ---------- realm policy, court, events ---------- */
  function policy(p,id){const d=POLICIES[p.culture].find(x=>x.id===id);if(!d||p.pol.has(id))return;
    if(p.polCur)return tell(p.id,'Your council is already at work on a policy.');
    if(d.req&&!p.pol.has(d.req))return tell(p.id,'Enact the earlier tier first.');
    if(p.gold<d.c)return tell(p.id,'Not enough gold');p.gold-=d.c;p.polCur={id,t:0};tell(p.id,`The council begins work on ${d.n}.`)}
  const hireCost=(p,k)=>Math.round(COURTIERS[p.culture][k].c*(1+.5*p.court.length));
  function hire(p,k){if(!p.offer.includes(k)||p.court.includes(k))return;
    if(p.court.length>=CFG.maxCourt)return tell(p.id,`Your court holds at most ${CFG.maxCourt} courtiers.`);
    const c=hireCost(p,k);if(p.gold<c)return tell(p.id,'Not enough gold');p.gold-=c;p.court.push(k);recalc(p);tell(p.id,`${COURTIERS[p.culture][k].n} joins your court.`,'good')}
  function dismiss(p,k){const n=p.court.indexOf(k);if(n<0)return;p.court.splice(n,1);recalc(p)}
  function applyFx(p,fx){
    if(fx.stab)addStab(p,fx.stab);if(fx.gold)p.gold=Math.max(0,p.gold+fx.gold);
    if(fx.troops)p.troops=Math.max(0,p.troops+maxTroops(p)*fx.troops);
    if(fx.rel)for(const q of players)if(q.id&&q.id!==p.id)addRel(p.id,q.id,fx.rel);
    if(fx.mod)addMod(p,fx.mod)}
  function resolveEvent(p,n){const e=p.evCur;if(!e)return;const ev=EVENTS[e.i];let oo=ev.o[n]||ev.o[ev.o.length-1];
    if(oo.c&&p.gold<oo.c)oo=ev.o[ev.o.length-1];if(oo.c)p.gold-=oo.c;p.evCur=null;applyFx(p,oo.fx);
    p.evNext=tick+rnd(CFG.eventEvery[0],CFG.eventEvery[1])}
  function tickRealm(p){
    if(p.polCur&&++p.polCur.t>=CFG.policyTicks){const d=POLICIES[p.culture].find(x=>x.id===p.polCur.id);p.pol.add(d.id);p.polCur=null;recalc(p);tell(p.id,`${d.n} is now the law of the realm.`,'good')}
    if(p.mods.length&&p.mods.some(x=>x.until<=tick)){for(const x of p.mods)if(x.until<=tick)tell(p.id,`${x.n} has ended.`);p.mods=p.mods.filter(x=>x.until>tick);recalc(p)}
    if(p.evCur){if(tick>=p.evCur.until)resolveEvent(p,-1)}
    else if(tick>=p.evNext){const i=Math.random()*EVENTS.length|0;p.evCur={i,until:tick+CFG.eventWait};
      if(p.conn)send(p,{t:'event',i,until:p.evCur.until});else resolveEvent(p,Math.random()*2|0)}}

  /* ---------- bots: plain rules, the same orders a player can give ---------- */
  function botNavy(p){
    if(p.port<1)return;
    if(p.fleet.length<1&&p.gold>=SHIPS[0].c*1.5){buildCog(p);return}
    let mine=0;for(const w of warships)if(w.a===p.id)mine++;
    if(mine>=Math.min(3,p.port))return;
    const c=SHIPS[2].req(p)&&p.gold>=SHIPS[2].c*1.3?2:SHIPS[1].req(p)&&p.gold>=SHIPS[1].c*1.4?1:0;if(!c)return;
    const ports=myPorts(p.id);if(ports.length)stationShip(p,c,pick(ports).i)}
  function botBuild(p){
    if(p.port<1&&p.gold>=costOf(p,'port')&&p.tiles>60){const i=randOwn(p,coastal);if(i>=0)build(p,'port',i);else if(p.gold>=costOf(p,'city')+180){const c=randOwn(p);if(c>=0)build(p,'city',c)}}
    else if(p.gold>=costOf(p,'city')&&p.city<1+p.tiles/300){const i=randOwn(p);if(i>=0)build(p,'city',i)}
    else if(p.port<2&&p.gold>=costOf(p,'port')){const i=randOwn(p,coastal);if(i>=0)build(p,'port',i)}
    else if(p.castle<1+p.tiles/500&&p.gold>=costOf(p,'castle')+60){const i=randOwn(p,i=>nbs(i).some(j=>terrain[j]&&owner[j]!==p.id));if(i>=0)build(p,'castle',i)}
    else if(p.cat<2&&p.tiles>300&&p.gold>=costOf(p,'cat')+150){const i=randOwn(p);if(i>=0)build(p,'cat',i)}
    else if(p.gold>400){const mine=buildings.filter(b=>owner[b.i]===p.id&&b.lv<BT[b.t].max);if(mine.length){const b=pick(mine);if(p.gold>=uCost(b.t,b.lv,p.m)*1.6)upgrade(p,b.i)}}
    if(!p.polCur){const d=POLICIES[p.culture].find(x=>!p.pol.has(x.id)&&(!x.req||p.pol.has(x.req)));if(d&&p.gold>=d.c*2.2)policy(p,d.id)}
    if(p.court.length<CFG.maxCourt){const k=pick(p.offer);if(!p.court.includes(k)&&p.gold>=hireCost(p,k)*3)hire(p,k)}}
  function botThink(p){
    botNavy(p);botBuild(p);
    const opts=[],foes=[];for(let d=0;d<P;d++)if(d!==p.id&&adj[p.id*P+d]>0&&!allied(p.id,d)){opts.push(d);if(d&&war(p.id,d))foes.push(d)}
    let nWar=0;for(let d=1;d<P;d++)if(war(p.id,d)){nWar++;const E=players[d],since=tick-wars.get(pk(p.id,d));
      if(since>300&&(strength(p)<strength(E)*.6||(since>1800&&adj[p.id*P+d]===0))&&Math.random()<.2)offer(p,'peace',d)}
    if(p.cat>0&&p.gold>=CFG.shot+60&&foes.length&&Math.random()<.35){const E=players[pick(foes)],r=Math.sqrt(E.tiles);
      for(let n=0;n<10;n++){const x=Math.round(E.cx+(Math.random()*2-1)*r),y=Math.round(E.cy+(Math.random()*2-1)*r);
        if(x<0||y<0||x>=W||y>=H)continue;const i=y*W+x;if(owner[i]===E.id&&!fire(p,-1,i))break}}
    p.shield=p.troops>maxTroops(p)*.3;
    const mxT=maxTroops(p),bold=p.troops>=mxT*Math.min(.75,.47/DIFF.ag);       // aggression decides how readily a bot fights; every bot settles free land at the same pace
    if(p.troops<mxT*.5||p.tiles/landCount>DIFF.cap)return;                   // past its cap a bot realm only holds what it has
    if(foes.length&&(bold||p.troops>=mxT*.6)){let best=-1,bs=1e9;for(const d of foes){const s=players[d].troops*(.7+Math.random()*.6);if(s<bs){bs=s;best=d}}
      launchAttack(p.id,best,p.troops*(.35+Math.random()*.25),Math.random()<.5?players[best].cap:randBorder(p,best));return}
    if(opts.includes(0)&&Math.random()<.85){launchAttack(p.id,0,p.troops*.4,Math.random()<.6?randBorder(p,0):-1);return}
    if(!bold)return;
    if(!opts.length||(!opts.includes(0)&&Math.random()<.1)){                // nothing left to take by land: look across the water
      if(p.port>0&&p.fleet.some(f=>f.busy<=tick))for(let n=0;n<40;n++){
        const R=n<25?70:9999,x=Math.round(p.cx+(Math.random()*2-1)*R),y=Math.round(p.cy+(Math.random()*2-1)*R);
        const i=R>999?Math.random()*N|0:(x<0||y<0||x>=W||y>=H?-1:y*W+x);if(i<0||!terrain[i])continue;const oo=owner[i];
        if(oo===p.id||allied(p.id,oo))continue;if(oo&&!war(p.id,oo)){if(nWar>=1||(!players[oo].isBot&&(tick<DIFF.grace||DIFF.gang<2))||declareWar(p.id,oo))continue}
        launchBoat(p,i,p.troops*.4);break}
      if(!opts.length)return}
    if(nWar>=2||tick<CFG.graceTicks||p.tiles/landCount>DIFF.cap)return;      // past its cap a bot realm stops starting wars
    const foesOf=d=>{let c=0;for(let q=1;q<P;q++)if(players[q].isBot&&war(q,d))c++;return c};
    let best=-1,bs=1e9;                                     // choose a neighbour worth a war: the weak, the hated, and whoever is running away with the map
    for(const d of opts){if(!d)continue;const E=players[d];if((truce.get(pk(p.id,d))||0)>tick)continue;
      const hum=!E.isBot;if(hum&&(tick<DIFF.grace||foesOf(d)>=DIFF.gang))continue;
      let s=strength(E)/(p.troops+1)*(.7+Math.random()*.6);
      if(d===p.grudge)s*=.55;s*=1+rel[p.id*P+d]/120;if(pact(p.id,d))s*=1.6;
      const sh=E.tiles/landCount;if(sh>.2)s*=sh>.32?.25:.5;
      if(hum)s*=DIFF.hate;
      if(s<bs){bs=s;best=d}}
    if(best>0&&(bs<.75*DIFF.ag/.85||Math.random()<.03)&&!declareWar(p.id,best))
      launchAttack(p.id,best,p.troops*(.35+Math.random()*.25),Math.random()<.5?players[best].cap:randBorder(p,best))}

  /* ---------- players and the opening ---------- */
  players.push({id:0,name:'Unclaimed land',tiles:0,alive:false,troops:0,conn:null,isBot:false,fleet:[],cap:-1,m:Object.assign({},M_BASE),stab:50,shield:false});
  function mk(name,rgb,isBot,conn,seat){const cul=seat&&CULTURES[seat.culture]?seat.culture:'english',C=COURTIERS[cul];
    const owned=Object.keys(C).filter(k=>C[k].shop&&seat&&Array.isArray(seat.owned)&&seat.owned.includes(k)),base=Object.keys(C).filter(k=>!C[k].shop);
    const p={id:players.length,name,rgb,isBot,conn,culture:cul,m:null,wsUp:0,troops:400,gold:80,tiles:0,alive:true,spawned:false,shield:false,stab:CFG.stabStart,
      city:0,castle:0,port:0,cat:0,cityLv:0,portLv:0,castleLv:0,cityCap:0,nPact:0,nAlly:0,cx:0,cy:0,cap:-1,fleet:[],
      pol:new Set(),polCur:null,court:[],offer:owned.concat(base).slice(0,CFG.courtShown),mods:[],evCur:null,evNext:rnd(400,900),
      nextThink:SPAWN+Math.random()*30,grudge:-1,askCd:{},tradeG:0,peak:0,kills:0,sacks:0,sackCd:0,cmds:0,acc:0,spect:false};
    recalc(p);players.push(p);return p}
  const kx=W/(B[1]-B[0]),ky=H/(B[2]-B[3]);
  const spot=r=>nearLand(Math.round((r[2]-B[0])*kx),Math.round((B[2]-r[1])*ky));
  const taken=new Set();
  for(const s of o.seats){const p=mk(s.name,s.color,false,s.conn,s);if(s.conn)s.conn.pid=p.id;taken.add(s.name);
    if(s.at){const i=spot(['',s.at[0],s.at[1]]);if(i>=0)claimSpawn(p,i%W,(i/W)|0);else randomSpawn(p)}}
  {const pool=o.realms.slice().sort(()=>Math.random()-.5),h0=Math.random()*360,gap=o.reg?10:Math.max(7,kx*4.2);let made=0;
    const add=(name,x,y)=>{const k=players.length,p=mk(name,hsl3((h0+k*137.5)%360,.5+(k%3)*.1,.36+(k%4)*.06),true,null,null);claimSpawn(p,x,y);made++};
    for(const r of pool){if(made>=o.bots||players.length>=250)break;if(taken.has(r[0]))continue;
      const i=spot(r);if(i<0)continue;const x=i%W,y=(i/W)|0;if(far(x,y,gap)){taken.add(r[0]);add(r[0],x,y)}}
    let minD=Math.min(W,H)/4,fails=0;const A1=['Ash','Oak','Stone','Raven','Wolf','Storm','Iron','Thorn'],A2=['ford','mark','hold','vale','mere','wick','by'];
    while(made<o.bots&&fails<20000&&players.length<250){const x=4+(Math.random()*(W-8)|0),y=4+(Math.random()*(H-8)|0),i=y*W+x;
      if(terrain[i]&&terrain[i]!==3&&!owner[i]&&far(x,y,minD)){let nm=A1[players.length%8]+A2[(players.length*3)%7];while(taken.has(nm))nm+='e';taken.add(nm);add(nm,x,y)}
      else if(++fails%80===0&&minD>6)minD-=2}}
  function hsl3(h,s,l){const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))))};return[f(0),f(8),f(4)]}
  P=players.length;adj=new Int32Array(P*P);atk=new Int16Array(P*P);rel=new Int16Array(P*P);delta=[];
  for(const p of players)if(p.isBot){p.gm=DIFF.gm}else p.gm=1;

  /* ---------- what each seat is told ---------- */
  function sendStart(p){
    send(p,{t:'start',you:p.id,W,H,b:B,map:o.map,land:landCount,spawn:SPAWN,solo:solo?1:0,spawned:p.spawned?1:0,
      players:players.slice(1).map(q=>({id:q.id,name:q.name,rgb:q.rgb,bot:q.isBot?1:0})),bld:buildings.map(b=>[b.t,b.i,b.lv])});
    p.conn.bin(84,terrain);p.conn.bin(79,owner)}
  for(const p of humans())sendStart(p);
  function snapshot(p){
    const ar=[],inc=[];for(const at of armies){if(at.a===p.id)ar.push([at.id,at.d,Math.round(at.troops),at.f,+at.R.toFixed(1)]);else if(at.d===p.id)inc.push([at.a,Math.round(at.troops),at.f])}
    const w=[],al=[],pc=[],tr=[];for(let d=1;d<P;d++){if(d===p.id)continue;const k=pk(p.id,d);if(wars.has(k))w.push(d);if(allyUntil.has(k))al.push([d,allyUntil.get(k)]);if(pacts.has(k))pc.push(d);if((truce.get(k)||0)>tick)tr.push([d,truce.get(k)])}
    return{t:'me',g:Math.round(p.gold),inc:+income(p).toFixed(2),max:Math.round(maxTroops(p)),st:Math.round(p.stab),m:[+p.m.atk.toFixed(2),+p.m.def.toFixed(2),+p.m.exp.toFixed(2)],
      mm:p.m,ar,ic:inc,w,al,pc,tr,rel:Array.from(rel.subarray(p.id*P,p.id*P+P)),fl:p.fleet.map(f=>[f.c,f.busy]),tg:Math.round(p.tradeG),
      pol:[...p.pol],pcur:p.polCur?[p.polCur.id,p.polCur.t]:null,ct:p.court,of:p.offer,mods:p.mods.map(x=>[x.n,x.until,x.k,x.v]),sh:p.shield?1:0,
      n:[p.city,p.castle,p.port,p.cat],k:p.kills,sk:p.sacks,pay:CFG.incomeEvery-(tick%CFG.incomeEvery)}}
  function broadcast(){
    const hs=humans();if(!hs.length){delta=[];events=[];clashes=[];return}
    if(delta.length){const d=Uint32Array.from(delta);for(const p of hs)p.conn.bin(68,d)}
    delta=[];
    const e={t:'e',k:tick,ph:phase,b:boats.map(b=>{const q=shipXY(b.path,b.k);return[b.a,0,Math.round(q[0]*10),Math.round(q[1]*10)]}),
      w:warships.map(w=>[w.id,w.a,w.c,Math.round(w.x*10),Math.round(w.y*10),Math.max(0,Math.round(w.hp/SHIPS[w.c].hp*100)),['patrol','chase','return','repair','move'].indexOf(w.st)|(w.wait>0?8:0)]),cl:clashes,
      tr:trade.map(s=>{const q=shipXY(s.path,s.k);return[s.a,Math.round(q[0]*10),Math.round(q[1]*10)]}),ev:events};events=[];clashes=[];
    for(const p of hs)send(p,e);
    if(tick%5===0){const pl={t:'p',pl:players.slice(1).map(p=>[p.id,Math.round(p.troops),p.tiles,p.alive?1:0,Math.round(p.cx),Math.round(p.cy),p.cap,p.city,p.castle,p.port,p.cat])};
      for(const p of hs){send(p,pl);send(p,snapshot(p))}}}

  /* ---------- the tick ---------- */
  const reward=(p,win)=>tick<900&&!win?0:Math.max(2,Math.round((2+p.peak*8+p.kills*.2+p.sacks*.1+(win?5:0))*(o.rewardX||1)));
  const score=(p,win)=>Math.round(p.peak*1000+p.kills*25+p.sacks*10+(win?500:0));
  function sendOver(p,win,winner){if(!p.conn)return;const c=p.conn;
    send(p,{t:'over',win:win?1:0,winner:winner?winner.name:'',peak:+p.peak.toFixed(3),reward:p.spect?0:reward(p,win),score:p.spect?0:score(p,win),kills:p.kills,sacks:p.sacks,trade:Math.round(p.tradeG),ticks:tick});
    if(o.onResult&&!p.spect)o.onResult(p.name,score(p,win),win);p.conn=null;c.game=null;c.pid=0;p.isBot=true}
  function finish(winner){over=true;for(const p of humans())sendOver(p,winner&&winner.id===p.id,winner)}
  function startPlay(){for(const p of players){if(!p.id||p.spawned)continue;
      if(p.conn){p.alive=false;p.spect=true;tell(p.id,'You did not choose a starting place in time. You are watching this match as a spectator.')}else if(!randomSpawn(p))p.alive=false}
    phase='play';computeAdj()}
  function step(){
    if(over)return;tick++;
    if(phase==='spawn'){for(const p of players)p.cmds=0;
      if(SPAWN?tick>=SPAWN:humans().every(p=>p.spawned))startPlay();
      broadcast();return}
    const pay=tick%CFG.incomeEvery===0;
    for(const p of players){if(!p.alive)continue;const mx=maxTroops(p),ov=1-Math.min(CFG.overextMax,p.tiles/landCount*CFG.overext);
      p.troops=Math.max(0,p.troops+(CFG.growBase+p.troops*CFG.growRate)*(1-p.troops/mx)*ov*p.m.grow*stabF(p)*p.gm);
      if(p.stab<CFG.stabLow)p.troops*=1-CFG.stabDrain;                                    // an unstable realm bleeds men
      p.acc+=income(p)/10;if(pay){p.gold=Math.max(0,p.gold+p.acc);p.acc=0}
      tickRealm(p)}
    processArmies();processBoats();tickTrade();tickNavy();
    for(let n=shots.length-1;n>=0;n--){const s=shots[n];if(++s.t>=s.dur){shots.splice(n,1);impact(s)}}
    if(tick%10===0)annexPockets();
    if(tick%5===0)computeAdj();
    for(const p of players){if(!p.alive)continue;
      if(p.tiles<=0){p.alive=false;
        for(let d=1;d<P;d++){const k=pk(p.id,d);if(wars.has(k)&&players[d].alive){players[d].kills++;addStab(players[d],CFG.stabConquer)}wars.delete(k);allyUntil.delete(k);pacts.delete(k)}
        tellAll(`${p.name} has fallen.`,'fall');if(p.conn){if(solo){finish(null);return}sendOver(p,false,null)}continue}
      if(p.cap<0||owner[p.cap]!==p.id){const c=p.cap<0?0:owner[p.cap];
        if(c>0&&tick>=p.sackCd){const C=players[c],loot=Math.round(p.gold*CFG.sackLoot+40);p.gold*=1-CFG.sackLoot;p.troops*=.75;C.gold+=loot;C.sacks++;addStab(p,CFG.stabSack);addStab(C,CFG.stabTake);p.sackCd=tick+CFG.sackCd;
          tell(c,`You sacked the capital of ${p.name}: +${loot} gold!`,'coin');tell(p.id,`Your capital has fallen to ${C.name}!`,'bad')}
        p.cap=newCapital(p)}
      p.peak=Math.max(p.peak,p.tiles/landCount);p.cmds=0;
      if(p.isBot&&tick>=p.nextThink){p.nextThink=tick+8+Math.random()*14;botThink(p)}}
    if(tick%10===0){
      for(const[k,t]of allyUntil){const a=k>>8,b=k&255;
        if(tick>=t){allyUntil.delete(k);tell(a,`Your alliance with ${players[b].name} has run its course.`);tell(b,`Your alliance with ${players[a].name} has run its course.`)}
        else if(t-tick<=CFG.allyWarn&&!allyWarned.has(k)){allyWarned.add(k);tell(a,`Your alliance with ${players[b].name} ends in 30 seconds. Renew it from the diplomacy panel.`,'warn');tell(b,`Your alliance with ${players[a].name} ends in 30 seconds. Renew it from the diplomacy panel.`,'warn')}}
      for(const[k,t]of pending)if(t<tick){pending.delete(k);const q=k.split('|');settle(q[0],+q[1],+q[2],false)}
      if(tick%100===0)for(const p of players){if(!p.id||!p.alive)continue;if(p.tiles<(p.t100||0)*.85)addStab(p,CFG.stabLand);p.t100=p.tiles}     // losing land fast shakes the realm
      if(tick%100===0)for(let a=1;a<P;a++)for(let b=a+1;b<P;b++){const v=rel[a*P+b];if(v)rel[a*P+b]=rel[b*P+a]=v>0?v-1:v+1}}
    broadcast();
    const alive=players.filter(p=>p.alive),lord=alive.find(p=>p.tiles/landCount>=CFG.win);
    if(lord)finish(lord);else if(alive.length<=1)finish(alive[0]||null);
    else if(!humans().length)over=true}

  /* ---------- orders ---------- */
  function cmd(c,m){
    const p=players[c.pid];if(!p||p.conn!==c||over||!m)return;if(++p.cmds>25)return;
    const tile=m.i|0,okTile=tile>=0&&tile<N;
    if(m.t==='surrender'){if(solo)finish(null);else{tellAll(`${p.name} has laid down the crown.`);sendOver(p,false,null);p.nextThink=tick+20}return}
    if(m.t==='spawn'){if(phase!=='spawn'||p.spawned||!okTile)return;
      if(!terrain[tile])return tell(p.id,'Pick a spot on land');if(owner[tile])return tell(p.id,'That land is already taken');
      const x=tile%W,y=(tile/W)|0;if(!far(x,y,7))return tell(p.id,'Too close to another realm');
      claimSpawn(p,x,y);send(p,{t:'spawned',i:p.cap});return}
    if(phase!=='play'||!p.alive)return;
    const e=(()=>{switch(m.t){
      case 'atk':{if(!okTile||!terrain[tile])return;const d=owner[tile];if(d===p.id)return;
        if(allied(p.id,d))return 'You cannot attack an ally';
        if(d&&!war(p.id,d))return `You are not at war with ${players[d].name} — declare war first`;
        const troops=Math.floor(p.troops*Math.max(.05,Math.min(1,+m.r||CFG.deploy)));if(troops<10)return 'Not enough troops';
        if(!m.sea&&landLinked(tile,p.id)){launchAttack(p.id,d,troops,tile);return}
        const er=launchBoat(p,tile,troops);if(!er)tell(p.id,'A Cog has set sail.','sail');return er}
      case 'cancel':cancelArmy(p,m.id|0);return;
      case 'build':return okTile?build(p,String(m.k),tile):'';
      case 'up':return okTile?upgrade(p,tile):'';
      case 'fire':return okTile?fire(p,m.b==null?-1:m.b|0,tile):'';
      case 'ship':{const k=m.c|0;if(k<0||k>2)return;const er=k===0?buildCog(p):stationShip(p,k,okTile?tile:-1);if(!er)tell(p.id,`A ${SHIPS[k].n} is laid down.`,'build');return er}
      case 'move':return okTile?moveShip(p,m.w|0,tile):'';
      case 'dip':diplo(p,String(m.a),m.id);return;
      case 'ans':answer(p,String(m.k),m.id|0,m.y);return;
      case 'policy':policy(p,String(m.id));return;
      case 'hire':hire(p,String(m.k));return;
      case 'dismiss':dismiss(p,String(m.k));return;
      case 'ev':if(p.evCur)resolveEvent(p,m.n|0);return;
      case 'shield':p.shield=!!m.on;return}})();
    if(e&&e!=='x')tell(p.id,e,'no')}
  function drop(c){const p=players[c.pid];if(!p||p.conn!==c)return;p.conn=null;p.isBot=true;p.nextThink=tick+20;c.game=null;c.pid=0;
    if(!p.spawned&&phase==='spawn'&&!randomSpawn(p))p.alive=false;if(!humans().length)over=true}
  const debug=()=>({tick,phase,alive:players.filter(p=>p.alive).length,armies:armies.length,wars:wars.size,ws:warships.length,cogs:boats.length,trade:trade.length,bld:buildings.length,
    top:players.filter(p=>p.alive).sort((a,b)=>b.tiles-a.tiles).slice(0,3).map(p=>p.name+' '+(p.tiles/landCount*100).toFixed(0)+'%').join(', ')});
  return{step,cmd,drop,debug,players,get over(){return over},get tick(){return tick},get humans(){return humans().length},_:{armies:()=>armies,randBorder,randOwn,adj:()=>adj,war,costOf,maxTroops,buildings:()=>buildings,warships:()=>warships,wars,owner,declareWar,launchAttack,computeAdj}};
}

const MAX_HUMANS=CFG.maxHumans;
const MP_DIFF={gm:.55,ag:.55,grace:1800,gang:1,hate:1.8,shield:.1,cap:.4};       // multiplayer bots: beatable by a new player
const DIFFS=[{gm:.55,ag:.35,grace:4800,gang:1,hate:3,shield:0,cap:.12},{gm:.75,ag:.7,grace:1800,gang:1,hate:1.4,shield:.2,cap:.45},{gm:1.2,ag:1.35,grace:900,gang:3,hate:.75,shield:.45}];

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const pick=a=>a[Math.random()*a.length|0];
function hsl(h,s,l){const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))))};return[f(0),f(8),f(4)]}
function makeNoise(rnd){
  const T=new Float32Array(65536);for(let i=0;i<65536;i++)T[i]=rnd();
  const noise=(x,y)=>{const xi=Math.floor(x),yi=Math.floor(y);let fx=x-xi,fy=y-yi;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);
    const a=T[((yi&255)<<8)|(xi&255)],b=T[((yi&255)<<8)|((xi+1)&255)],c=T[(((yi+1)&255)<<8)|(xi&255)],d=T[(((yi+1)&255)<<8)|((xi+1)&255)];
    return a+(b-a)*fx+(c-a)*fy+(a-b-c+d)*fx*fy};
  return(x,y,o)=>{let s=0,amp=1,f=1,t=0;for(let k=0;k<o;k++){s+=noise(x*f+k*37.1,y*f+k*91.7)*amp;t+=amp;amp*=.5;f*=2}return s/t};
}
function segDist(px,py,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy;let t=l?((px-ax)*dx+(py-ay)*dy)/l:0;t=t<0?0:t>1?1:t;return Math.hypot(px-ax-dx*t,py-ay-dy*t)}
function edgeMid(a,b){let p=a,q=b;if(a[0]>b[0]||(a[0]===b[0]&&a[1]>b[1])){p=b;q=a}
  const v=Math.sin(p[0]*12.9898+p[1]*78.233+q[0]*37.719+q[1]*4.581)*43758.5453,o=(v-Math.floor(v)-.5)*.24;
  return[(p[0]+q[0])/2-(q[1]-p[1])*o,(p[1]+q[1])/2+(q[0]-p[0])*o]}
const POLYS=D.COAST.map(s=>s.split('|').map(r=>r.trim().split(' ').map(p=>p.split(',').map(Number))));

/* ============================ map: the same coastline data the game page uses ============================ */
function genMap(mapKey){
  const cfg=D.MAPS[mapKey],B=cfg.b,W=cfg.w,H=cfg.h,N=W*H,terrain=new Uint8Array(N);let landCount=0;
    const rnd=mulberry32((Math.random()*1e9)|0),fbm=makeNoise(rnd),kx=W/(B[1]-B[0]),ky=H/(B[2]-B[3]),whole=B[1]-B[0]>=359,mask=new Uint8Array(N);
  for(const poly of POLYS){
    let vis=false;
    const rings=poly.map(r=>{let pts=r.map(p=>{const x=(p[0]-B[0])*kx,y=(B[2]-p[1])*ky;if(y>-H&&y<2*H&&(whole||(x>-W&&x<2*W)))vis=true;return[x,y]});
      for(let it=0;it<4;it++){const out=[];let ch=false;for(let q=0;q<pts.length;q++){const a=pts[q],b=pts[(q+1)%pts.length];out.push(a);
          const l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(l>5&&l<W*.4){out.push(edgeMid(a,b));ch=true}}pts=out;if(!ch)break}
      return pts});
    if(!vis)continue;
    const row=new Uint8Array(W);let y0=1e9,y1=-1e9;for(const r of rings)for(const p of r){if(p[1]<y0)y0=p[1];if(p[1]>y1)y1=p[1]}
    for(let y=Math.max(0,Math.floor(y0));y<=Math.min(H-1,Math.ceil(y1));y++){const sy=y+.5,xs=[];
      for(const r of rings)for(let q=0;q<r.length;q++){const a=r[q],b=r[(q+1)%r.length];
        if((a[1]<=sy&&b[1]>sy)||(b[1]<=sy&&a[1]>sy))xs.push(a[0]+(sy-a[1])/(b[1]-a[1])*(b[0]-a[0]))}
      xs.sort((a,b)=>a-b);
      for(let k=0;k+1<xs.length;k+=2)for(let x=Math.max(0,Math.ceil(xs[k]-.5));x<=Math.min(W-1,Math.floor(xs[k+1]-.5));x++)mask[y*W+x]=1}
  }
  const f1=Math.min(kx*4.5,42),f2=Math.min(kx*1.6,15);
  for(let y=0;y<H;y++){const lat=B[2]-(y+.5)/ky;
    for(let x=0;x<W;x++){const i=y*W+x;if(!mask[i])continue;landCount++;
      const lon=B[0]+(x+.5)/kx,n=fbm(x/f1,y/f1,4),n2=fbm(x/f2+50,y/f2+50,3);let t=1;
      const green=lon>-56||(lat>76&&lon>-74);
      if(lat>67+(n-.5)*9||(lat>59.7&&lon<-11&&lon>-74&&green&&!(lat<67.5&&lon>-26)))t=5;
      else{
        for(const r of D.RIDGES){const rad=r[0]*(.55+n2*.9);let hit=false;
          for(let q=1;q<r.length-1;q++)if(segDist(lon,lat,r[q][0],r[q][1],r[q+1][0],r[q+1][1])<rad){hit=true;break}
          if(hit){t=3;break}}
        if(t===1)for(const e of D.DESERTS){const dx=(lon-e[0])/e[2],dy=(lat-e[1])/e[3];if(dx*dx+dy*dy<.75+n*.5){t=4;break}}
        if(t===1){const a=Math.abs(lat);if(n2>(a<12||(lat>48&&lat<67)?.5:.62))t=2}
      }
      terrain[i]=t}}
  return{W,H,terrain,land:landCount,B,cfg}}

/* ============================ one match ============================ */
function newMatch(gid,mapKey,conns){
  const M=genMap(mapKey);
  const g=createGame({W:M.W,H:M.H,terrain:M.terrain,land:M.land,B:M.B,map:M.cfg.n,reg:M.cfg.reg,realms:realmPool(M.cfg,D),
    seats:conns.map(c=>({name:c.name,color:c.color,conn:c,owned:c.owned,culture:c.culture})),bots:Math.max(4,CFG.realmsMP-conns.length),
    spawnTicks:SPAWN_TICKS||CFG.spawnMP,diff:MP_DIFF,rewardX:2,onResult:addScore});
  g.id=gid;return g}

/* ============================ leaderboard (kept in a small file next to the server) ============================ */
const SCORE_FILE=path.join(__dirname,'scores.json');let scores={};
try{scores=JSON.parse(fs.readFileSync(SCORE_FILE,'utf8'))||{}}catch(e){}
let scoreDirty=false;
function addScore(name,pts,win){const k=String(name).slice(0,16);const r=scores[k]||(scores[k]={s:0,w:0,g:0});r.s+=pts|0;r.g++;if(win)r.w++;scoreDirty=true}
const topScores=()=>Object.entries(scores).map(([n,r])=>[n,r.s,r.w,r.g]).sort((a,b)=>b[1]-a[1]).slice(0,50);
if(!process.env.SOAK)setInterval(()=>{if(scoreDirty){scoreDirty=false;fs.writeFile(SCORE_FILE,JSON.stringify(scores),()=>{})}},30000);

/* ============================ lobbies ============================ */
if(process.env.SOAK){                                 // self-test: `SOAK=1 node server.js` plays every map with bots only and exits
  if(process.env.SOAK_HUMAN){                           // balance check: a plain, patient scripted player against each difficulty
    const dk=process.env.SOAK_HUMAN,runs=+process.env.RUNS||4,mk=process.env.MAP||'william',res=[];
    for(let r=0;r<runs;r++){let out=null;const c={name:'Tester',color:[128,84,46],pid:0,game:null,bin(){},send(m){if(m.t==='over')out=m;if(m.t==='ask')asks.push(m);if(m.t==='event')evs++}},asks=[];let evs=0;
      const M=genMap(mk),g=createGame({W:M.W,H:M.H,terrain:M.terrain,land:M.land,B:M.B,map:mk,reg:M.cfg.reg,realms:realmPool(M.cfg,D),seats:[{name:'Tester',color:[1,1,1],conn:c}],bots:dk==='mp'?29:18,spawnTicks:dk==='mp'?100:0,diff:dk==='mp'?MP_DIFF:DIFFS[+dk],rewardX:1,solo:dk!=='mp'});
      c.game=g;const p=g.players[c.pid],P=g.players.length,U=g._;
      for(let n=0;n<40000&&!p.spawned;n++){const i=Math.random()*M.W*M.H|0;g.cmd(c,{t:'spawn',i});p.cmds=0}
      for(let n=0;n<(+process.env.MAXT||24000)&&!out&&!g.over;n++){g.step();if(evs){evs=0;g.cmd(c,{t:'ev',n:Math.random()*2|0})}while(asks.length){const a=asks.pop();g.cmd(c,{t:'ans',k:a.k,id:a.id,y:a.k!=='tribute'})}
        if(n%20||!p.alive||g.debug().phase!=='play')continue;const adj=U.adj(),mx=U.maxTroops(p);
        if(p.gold>=U.costOf(p,'city')&&p.city<6){const i=U.randOwn(p);if(i>=0)g.cmd(c,{t:'build',k:'city',i})}
        if(!p.polCur){const d=POLICIES.english.find(x=>!p.pol.has(x.id)&&(!x.req||p.pol.has(x.req)));if(d&&p.gold>=d.c+150)g.cmd(c,{t:'policy',id:d.id})}
        if(p.troops<mx*.45)continue;
        const foes=[];for(let d=1;d<P;d++)if(U.war(p.id,d)&&adj[p.id*P+d]>0)foes.push(d);
        if(foes.length){const d=foes.sort((a,b)=>g.players[a].troops-g.players[b].troops)[0],i=U.randBorder(p,d);g.cmd(c,{t:'atk',i:i>=0?i:g.players[d].cap,r:.5})}
        else if(adj[p.id*P]>0){for(let k=0;k<3;k++){const i=U.randBorder(p,0);if(i>=0){g.cmd(c,{t:'atk',i,r:.25});}}}
        else{let best=0,bt=1e12;for(let d=1;d<P;d++)if(adj[p.id*P+d]>0&&g.players[d].troops<bt){bt=g.players[d].troops;best=d}
          if(best&&bt<p.troops*1.1)g.cmd(c,{t:'dip',a:'war',id:best})}}
      res.push(out?(out.win?'WIN':'loss')+'@'+Math.round(out.ticks/600)+'m peak '+Math.round(out.peak*100)+'%':'unfinished peak '+Math.round(p.peak*100)+'% t'+g.tick+' bots: '+g.debug().top)}
    console.log('diff',dk,mk,res.join(' | '));process.exit(0)}
  for(const m of ROT){const c={name:'Tester',color:[128,84,46],pid:0,game:null,send(){},bin(){}},g=newMatch(1,m,[c]);let mx=0;const t0=Date.now();
    for(let n=0;n<(+process.env.SOAK_TICKS||6000)&&!g.over;n++){g.step();if(n%50===0)mx=Math.max(mx,g.debug().ws)}
    console.log(m,JSON.stringify(g.debug()),'max warships',mx,((Date.now()-t0)/g.debug().tick).toFixed(2)+' ms/tick')}
  process.exit(0)}
let lobbies=[],games=[],conns=new Set(),rot=0,nextId=1;
function openLobby(delay){const m=ROT[rot++%ROT.length];lobbies.push({id:nextId++,map:m,startsAt:Date.now()+delay*1000,players:[]})}
for(let k=1;k<=3;k++)openLobby(LOBBY_SECS*k/3);
function lobbyList(){const now=Date.now();return({t:'lobbies',online:conns.size,games:games.length,
  list:lobbies.map(l=>({id:l.id,map:D.MAPS[l.map].n,n:l.players.length,max:MAX_HUMANS,s:Math.max(0,Math.ceil((l.startsAt-now)/1000)),names:l.players.map(c=>c.name)}))})}
function leaveLobby(c){if(!c.lobby)return;c.lobby.players=c.lobby.players.filter(x=>x!==c);c.lobby=null}
setInterval(()=>{
  const now=Date.now();
  for(const l of lobbies.slice()){if(now<l.startsAt)continue;
    lobbies=lobbies.filter(x=>x!==l);openLobby(LOBBY_SECS);                         // every lobby that closes is replaced by a fresh one
    if(!l.players.length)continue;                                                    // nobody joined: it simply disappears
    if(games.length>=MAX_GAMES){for(const c of l.players){c.lobby=null;c.send({t:'toast',s:'All match servers are busy — please join the next lobby.'})}continue}
    for(const c of l.players)c.lobby=null;
    try{const g=newMatch(nextId++,l.map,l.players);for(const c of l.players)c.game=g;games.push(g);console.log(`match ${g.id} on ${l.map}: ${l.players.length} human(s)`)}
    catch(e){console.error('match failed',e);for(const c of l.players)c.send({t:'toast',s:'The match could not start. Please try again.'})}}
  const msg=lobbyList();for(const c of conns)if(!c.game)c.send(msg);
},1000);
setInterval(()=>{for(const g of games){try{g.step()}catch(e){console.error('step',e)}}games=games.filter(g=>!g.over)},100);

/* ============================ HTTP + WebSocket ============================ */
const page=()=>{try{return fs.readFileSync(path.join(__dirname,'index.html'))}catch(e){return null}};
const srv=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,online:conns.size,games:games.length}));return}
  const p=req.url.split('?')[0];if(p==='/'||p==='/index.html'){const b=page();if(b){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(b);return}}
  res.writeHead(404);res.end('Not found')});
srv.on('upgrade',(req,sock)=>{
  const k=req.headers['sec-websocket-key'];if(!k||conns.size>=2000){sock.destroy();return}
  const acc=crypto.createHash('sha1').update(k+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');sock.setNoDelay(true);
  const c={open:true,buf:Buffer.alloc(0),lobby:null,game:null,pid:0,name:'Player',color:[128,84,46],owned:[],culture:'english',
    bin(code,arr){const b=Buffer.alloc((code===68?4:1)+arr.byteLength);b[0]=code;Buffer.from(arr.buffer,arr.byteOffset,arr.byteLength).copy(b,code===68?4:1);c.send(b)},
    send(d){if(!c.open)return;if(sock.writableLength>8e6){c.close();return}
      const bin=Buffer.isBuffer(d),pl=bin?d:Buffer.from(typeof d==='string'?d:JSON.stringify(d)),n=pl.length;let h;
      if(n<126){h=Buffer.alloc(2);h[1]=n}else if(n<65536){h=Buffer.alloc(4);h[1]=126;h.writeUInt16BE(n,2)}else{h=Buffer.alloc(10);h[1]=127;h.writeUInt32BE(0,2);h.writeUInt32BE(n,6)}
      h[0]=0x80|(bin?2:1);try{sock.write(h);sock.write(pl)}catch(e){}},
    close(){if(!c.open)return;c.open=false;conns.delete(c);leaveLobby(c);if(c.game)c.game.drop(c);try{sock.destroy()}catch(e){}}};
  conns.add(c);c.send(lobbyList());
  sock.on('data',d=>{c.buf=Buffer.concat([c.buf,d]);
    while(c.open&&c.buf.length>=2){const b1=c.buf[1],op=c.buf[0]&15,masked=b1&128;let len=b1&127,off=2;
      if(len===126){if(c.buf.length<4)return;len=c.buf.readUInt16BE(2);off=4}else if(len===127){c.close();return}
      if(len>4096){c.close();return}
      const need=off+(masked?4:0)+len;if(c.buf.length<need)return;
      let pl=Buffer.from(c.buf.subarray(off+(masked?4:0),need));if(masked){const mk=c.buf.subarray(off,off+4);for(let i=0;i<pl.length;i++)pl[i]^=mk[i&3]}
      c.buf=c.buf.subarray(need);
      if(op===8){c.close();return}
      if(op===9){try{sock.write(Buffer.concat([Buffer.from([0x8A,pl.length]),pl]))}catch(e){}continue}
      if(op!==1)continue;let m;try{m=JSON.parse(pl.toString())}catch(e){continue}
      if(!m||typeof m!=='object')continue;
      try{
        if(c.game){if(m.t==='leave')c.game.drop(c);else c.game.cmd(c,m)}
        else if(m.t==='join'){const l=lobbies.find(x=>x.id===(m.id|0));if(!l||l.players.length>=MAX_HUMANS)continue;leaveLobby(c);
          c.name=String(m.name||'Player').replace(/[<>&"]/g,'').trim().slice(0,16)||'Player';
          if(Array.isArray(m.color)&&m.color.length===3)c.color=m.color.map(v=>Math.max(0,Math.min(255,v|0)));
          c.owned=Array.isArray(m.owned)?m.owned.slice(0,12).map(String):[];c.culture=String(m.culture||'english');
          l.players.push(c);c.lobby=l;c.send({t:'joined',id:l.id});c.send(lobbyList())}
        else if(m.t==='lb')c.send({t:'lb',list:topScores()});
        else if(m.t==='unjoin'){leaveLobby(c);c.send({t:'joined',id:0});c.send(lobbyList())}
      }catch(e){console.error('msg',e)}}});
  sock.on('close',()=>c.close());sock.on('error',()=>c.close())});
srv.listen(PORT,()=>console.log(`Castle & Frontier server on port ${PORT} (lobbies every ${LOBBY_SECS}s)`));

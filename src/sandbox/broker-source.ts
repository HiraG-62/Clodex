export const brokerSource = String.raw`
const {spawn}=require('node:child_process');
const {connect}=require('node:net');
const {createInterface}=require('node:readline');
const {timingSafeEqual}=require('node:crypto');
const {existsSync}=require('node:fs');
const {join,isAbsolute}=require('node:path');
const [port,sid]=process.argv.slice(2);
const input=createInterface({input:process.stdin});
input.once('line',token=>{input.close();process.stdin.destroy();
const IDLE_TIMEOUT_MS=30000;
const INFINITE_WAIT='4294967295';
const helper=join(__dirname,'token-helper.exe');
const children=new Map();
const socket=connect(Number(port),'127.0.0.1');
const send=message=>{if(!socket.destroyed)socket.write(JSON.stringify(message)+'\n')};
let authenticated=false,closing=false;
const kill=child=>{try{child.kill()}catch{}};
const cleanup=()=>{if(closing)return;closing=true;for(const child of children.values())kill(child);socket.destroy();};
socket.setTimeout(IDLE_TIMEOUT_MS,cleanup);
socket.on('connect',()=>send({type:'hello',token}));
socket.on('error',cleanup);socket.on('end',cleanup);socket.on('close',()=>{cleanup();process.exit(0)});
process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
function resolveCommand(command,args){
  if(command==='claude')return [join(process.env.APPDATA,'npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe'),args];
  if(command==='codex')return [process.execPath,[join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js'),...args]];
  if(command==='pnpm'){
    const directory=join(process.env.APPDATA,'npm','node_modules','pnpm','bin');
    const script=['pnpm.cjs','pnpm.mjs'].map(name=>join(directory,name)).find(existsSync);
    if(!script)throw new Error('pnpm の実行ファイルなし');
    return [process.execPath,[script,...args]];
  }
  if(command==='node')return [process.execPath,args];
  if(command==='__inspect')return [helper,['--inspect']];
  if(isAbsolute(command)&&existsSync(command)&&command.toLowerCase().endsWith('.exe'))return [command,args];
  for(const directory of (process.env.PATH||'').split(';')){
    const path=join(directory,command.toLowerCase().endsWith('.exe')?command:command+'.exe');
    if(existsSync(path))return [path,args];
  }
  throw new Error('実行ファイルなし: '+command);
}
createInterface({input:socket}).on('error',cleanup).on('line',line=>{
  let m;try{m=JSON.parse(line)}catch{cleanup();return}
  if(!authenticated){
    const supplied=Buffer.from(String(m.token||'')),expected=Buffer.from(token);
    if(m.type!=='welcome'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){cleanup();return}
    authenticated=true;return;
  }
  if(m.type==='ping'){send({type:'pong'});return}
  if(m.type==='close'){cleanup();return}
  if(m.type==='kill'){const child=children.get(m.id);if(child)kill(child);return}
  if(m.type==='write'){children.get(m.id)?.stdin.write(m.data);return}
  if(m.type!=='start'||!Number.isSafeInteger(m.id)||children.has(m.id))return;
  try{
    if(typeof m.command!=='string'||!Array.isArray(m.args)||!m.args.every(arg=>typeof arg==='string')||typeof m.cwd!=='string')throw new Error('起動引数が不正');
    const [command,args]=resolveCommand(m.command,m.args);
    const env={...process.env};
    if(m.agent==='claude'||m.agent==='codex')env.CLODEX_AGENT=m.agent;
    const child=spawn(helper,[sid,m.cwd,INFINITE_WAIT,command,...args],{cwd:m.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    children.set(m.id,child);child.stdin.on('error',()=>{});
    child.on('spawn',()=>send({type:'spawn',id:m.id}));
    child.stdout.on('data',data=>send({type:'stdout',id:m.id,data:data.toString('base64')}));
    child.stderr.on('data',data=>send({type:'stderr',id:m.id,data:data.toString('base64')}));
    child.on('error',error=>send({type:'error',id:m.id,message:error.message}));
    child.on('close',code=>{children.delete(m.id);send({type:'exit',id:m.id,code})});
  }catch(error){send({type:'error',id:m.id,message:error.message});send({type:'exit',id:m.id,code:null})}
});
});
`;

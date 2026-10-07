import { expect, it } from "vitest";
import { profileRemovalSource } from "./profile-removal.js";
import { runHost, psQuote } from "./powershell.js";

const cases = [
  {name:"保存したSID",agent:"agent",path:"C:\\Users\\renamed",existing:[],loaded:false,special:false,fail:false,removed:["agent"],error:false},
  {name:"stateなしの孤立プロファイル",agent:null,path:"C:\\Users\\clodex-agent",existing:[],loaded:false,special:false,fail:false,removed:["agent"],error:false},
  {name:"別ユーザーのパス",agent:null,path:"C:\\Users\\other",existing:[],loaded:false,special:false,fail:false,removed:[],error:false},
  {name:"存在するユーザー",agent:null,path:"C:\\Users\\clodex-agent",existing:["agent"],loaded:false,special:false,fail:false,removed:[],error:false},
  {name:"読み込み中",agent:"agent",path:"C:\\Users\\clodex-agent",existing:[],loaded:true,special:false,fail:false,removed:[],error:true},
  {name:"特殊プロファイル",agent:"agent",path:"C:\\Users\\clodex-agent",existing:[],loaded:false,special:true,fail:false,removed:[],error:true},
  {name:"CIM削除失敗",agent:"agent",path:"C:\\Users\\clodex-agent",existing:[],loaded:false,special:false,fail:true,removed:[],error:true},
  {name:"人のSIDは拒否",agent:"agent",path:"C:\\Users\\clodex-agent",existing:[],loaded:false,special:false,fail:false,humanSid:"agent",removed:[],error:true},
  {name:"プロファイル除去済みの再実行",agent:null,path:"C:\\Users\\clodex-agent",existing:[],loaded:false,special:false,fail:false,missing:true,removed:[],error:false},
] as const;

it.runIf(process.platform === "win32").each(cases)("プロファイル除去: $name",async fixture=>{
  const data=Buffer.from(JSON.stringify(fixture),"utf8").toString("base64");
  const output=await runHost(`
$env:SystemDrive='C:'
$Fixture=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(data)}))|ConvertFrom-Json
$Removed=[Collections.Generic.List[string]]::new()
function Get-LocalUser {foreach($Sid in $Fixture.existing){[pscustomobject]@{SID=[pscustomobject]@{Value=$Sid}}}}
function Get-ChildItem {param($LiteralPath) [pscustomobject]@{PSPath='fixture';PSChildName='agent'}}
function Get-ItemProperty {param($LiteralPath) [pscustomobject]@{ProfileImagePath=$Fixture.path}}
function Get-CimInstance {param($ClassName,$InputObject,$ErrorAction) if($ClassName -eq 'Win32_Process'){return};if(-not $Fixture.missing){[pscustomobject]@{SID='agent';Loaded=$Fixture.loaded;Special=$Fixture.special}}}
function Start-Sleep {param($Milliseconds)}
function Remove-CimInstance {param($InputObject,$ErrorAction) if($Fixture.fail){throw 'CIM failure'};$Removed.Add($InputObject.SID)}
${profileRemovalSource}
$Human=if($Fixture.humanSid){$Fixture.humanSid}else{'human'}
$Failure=$null;try{Remove-AgentProfiles $Fixture.agent $Human}catch{$Failure=$_.Exception.Message}
@{removed=@($Removed.ToArray());error=$Failure}|ConvertTo-Json -Compress
`);
  const result=JSON.parse(output) as {removed:string[];error:string|null};
  expect(result.removed).toEqual(fixture.removed);
  expect(result.error!==null).toBe(fixture.error);
});

it.runIf(process.platform === "win32").each(["unload","timeout","terminate-failure"] as const)("SID限定の停止と待機: %s",async mode=>{
  const output=await runHost(`
$env:SystemDrive='C:';$Mode=${psQuote(mode)}
$Events=[Collections.Generic.List[string]]::new();$script:Waits=0
function Get-LocalUser {}
function Get-ChildItem {param($LiteralPath)}
function Get-CimInstance {
  param($ClassName,$InputObject,$Filter,$ErrorAction)
  if($ClassName -eq 'Win32_Process'){
    if($Filter){return [pscustomobject]@{ProcessId=101}}
    foreach($Id in @(101,102,103)){[pscustomobject]@{ProcessId=$Id}};return
  }
  [pscustomobject]@{SID='agent';Special=$false;Loaded=($Mode -ne 'unload' -or $script:Waits -lt 2)}
}
function Invoke-CimMethod {
  param($InputObject,$MethodName,$ErrorAction)
  if($MethodName -eq 'GetOwnerSid'){
    if($InputObject.ProcessId -eq 103){throw 'owner unavailable'}
    return [pscustomobject]@{ReturnValue=0;Sid=$(if($InputObject.ProcessId -eq 101){'agent'}else{'human'})}
  }
  $Events.Add('stop:'+$InputObject.ProcessId)
  [pscustomobject]@{ReturnValue=$(if($Mode -eq 'terminate-failure'){2}else{0})}
}
function Start-Sleep {param($Milliseconds) $script:Waits++;$Events.Add('wait:'+$Milliseconds)}
function Remove-CimInstance {param($InputObject,$ErrorAction) $Events.Add('remove:'+$InputObject.SID)}
${profileRemovalSource}
$Failure=$null;try{Remove-AgentProfiles 'agent' 'human'}catch{$Failure=$_.Exception.Message}
@{events=@($Events.ToArray());error=$Failure;waits=$script:Waits}|ConvertTo-Json -Compress
`);
  const result=JSON.parse(output) as {events:string[];error:string|null;waits:number};
  expect(result.events.filter(event=>event.startsWith("stop:"))).toEqual(["stop:101"]);
  if(mode==="unload"){
    expect(result.events).toEqual(["stop:101","wait:500","wait:500","remove:agent"]);
    expect(result.error).toBeNull();
  }else{
    expect(result.events).not.toContain("remove:agent");
    expect(result.error).not.toBeNull();
    expect(result.waits).toBe(mode==="timeout"?10:0);
  }
});

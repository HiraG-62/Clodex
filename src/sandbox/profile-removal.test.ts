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
function Get-CimInstance {param($ClassName) if(-not $Fixture.missing){[pscustomobject]@{SID='agent';Loaded=$Fixture.loaded;Special=$Fixture.special}}}
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

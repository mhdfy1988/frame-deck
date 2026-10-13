import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw new Error(`${command} failed (${result.status})`);}
const python=resolve(root,'.venv/Scripts/python.exe');
if(!existsSync(python))run('py',['-3.12','-m','venv',resolve(root,'.venv')]);
run(python,['-m','pip','install','-r',process.argv.includes('--dev')?'requirements-dev.txt':'requirements.txt']);
writeFileSync(resolve(root,'.venv/frame-deck-ready.json'),JSON.stringify({formatVersion:1}),'utf8');

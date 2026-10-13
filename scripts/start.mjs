import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),python=resolve(root,'.venv/Scripts/python.exe');
if(!existsSync(python)||!existsSync(resolve(root,'.venv/frame-deck-ready.json'))){const setup=spawnSync(process.execPath,[resolve(root,'scripts/setup.mjs')],{cwd:root,stdio:'inherit',windowsHide:true});if(setup.status!==0){console.error('Initial backend setup failed.');process.exitCode=1;}}
if(!process.exitCode){const child=spawn(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8902','--no-access-log'],{cwd:root,stdio:'inherit',windowsHide:true});child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});process.on('SIGINT',()=>child.kill('SIGINT'));}

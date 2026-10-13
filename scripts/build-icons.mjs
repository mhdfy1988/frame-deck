import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const names=['video','camera','layers','film','layout-grid','play','pause','download','undo-2','redo-2','rotate-ccw','repeat-2','repeat-1','scan','scissors','square','trash-2','chevron-left','chevron-right','plus','minus','x','maximize','upload','move','eraser','brush','wand-sparkles','check','image','gamepad-2','folder','chevron-down','search','ellipsis','panel-left-close','panel-right-close'];
const icons={};
for(const name of names){
  const svg=await readFile(resolve(root,'node_modules/lucide-static/icons',`${name}.svg`),'utf8');
  icons[name]=svg.replace(/<!--[^]*?-->/g,'').replace('<svg','<svg aria-hidden="true" focusable="false"').trim();
}
await writeFile(resolve(root,'web/icons-data.js'),`// Generated from lucide-static; see licenses/lucide.txt.\nexport const icons=${JSON.stringify(icons)};\n`,'utf8');
await mkdir(resolve(root,'web/licenses'),{recursive:true});
await writeFile(resolve(root,'web/licenses/lucide.txt'),await readFile(resolve(root,'node_modules/lucide-static/LICENSE'),'utf8'),'utf8');
console.log(`Built ${names.length} local icons`);

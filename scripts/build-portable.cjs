// 2026-10-16 김기덕: 개발용 pnpm 실행기와 무관하게 런타임 파일만 분리하여 포터블 exe를 만든다.
const fs=require('node:fs/promises');
const path=require('node:path');
const {build,Platform}=require('electron-builder');
async function main(){
  const root=path.resolve(__dirname,'..'),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  // This application uses Electron and Node built-ins only. Fail rather than
  // accidentally omitting a future runtime dependency from the staged app.
  if(Object.keys(pkg.dependencies||{}).length||Object.keys(pkg.optionalDependencies||{}).length)throw Error('런타임 의존성 추가됨: 분리 빌드 구성을 갱신하세요.');
  const parent=path.join(root,'.test-data');await fs.mkdir(parent,{recursive:true});
  const stage=await fs.mkdtemp(path.join(parent,'portable-build-'));
  await fs.mkdir(path.join(stage,'node_modules'));
  await fs.cp(path.join(root,'src'),path.join(stage,'src'),{recursive:true});
  const {devDependencies,scripts,build:config,...runtime}=pkg;
  await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(runtime,null,2));
  const priorAgent=process.env.npm_config_user_agent;
  process.env.npm_config_user_agent='traversal';
  try{
    const artifacts=await build({projectDir:stage,targets:Platform.WINDOWS.createTarget('portable'),config:{...config,npmRebuild:false,
      electronVersion:pkg.devDependencies.electron,electronDist:path.join(root,'node_modules/electron/dist'),
      directories:{output:path.join(root,'release')}
    }});
    for(const artifact of artifacts)console.log(artifact);
  }finally{if(priorAgent===undefined)delete process.env.npm_config_user_agent;else process.env.npm_config_user_agent=priorAgent;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

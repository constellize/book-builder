/**
 * Tests for font-embed.js. Run with:  node scripts/lib/font-embed.test.js
 *
 * Fixtures come from pandoc's own default reference.docx, unpacked into a temp
 * directory, so the tests exercise the real XML the module has to patch.
 */
const fs=require('fs'),assert=require('assert'),cp=require('child_process'),os=require('os');
const path=require('path');
const FE=require('./font-embed.js');
const F=path.resolve(__dirname,'../../fonts');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'font-embed-test-'));
cp.execSync(`pandoc -o ${JSON.stringify(path.join(TMP,'ref.docx'))} --print-default-data-file reference.docx`);
cp.execSync(`unzip -q -o ${JSON.stringify(path.join(TMP,'ref.docx'))} -d ${JSON.stringify(TMP)}`);
const fixture=(p)=>fs.readFileSync(path.join(TMP,p),'utf8');

let n=0,f=0; const t=(name,fn)=>{n++;try{fn();console.log('  [ OK ] '+name);}catch(e){f++;console.log('  [FAIL] '+name+' -- '+e.message);}};

console.log('=== unit tests ===');

t('guidToKey reverses the GUID bytes', ()=>{
  const k=FE.guidToKey('{00112233-4455-6677-8899-AABBCCDDEEFF}');
  assert.strictEqual(k.toString('hex').toUpperCase(),'FFEEDDCCBBAA99887766554433221100');
});

t('obfuscation is self-inverse and touches exactly 32 bytes', ()=>{
  const src=fs.readFileSync(`${F}/AtkinsonHyperlegibleMono-Regular.ttf`);
  const g=FE.makeFontGuid({fontData:src,seed:'x'});
  const ob=FE.obfuscateFont(src,g);
  assert.ok(Buffer.compare(ob.subarray(0,32),src.subarray(0,32))!==0,'first 32 unchanged');
  assert.strictEqual(Buffer.compare(ob.subarray(32),src.subarray(32)),0,'tail changed');
  assert.strictEqual(Buffer.compare(FE.deobfuscateFont(ob,g),src),0,'round trip');
});

t('obfuscateFont does not mutate the input buffer', ()=>{
  const src=fs.readFileSync(`${F}/AtkinsonHyperlegibleMono-Bold.ttf`);
  const copy=Buffer.from(src);
  FE.obfuscateFont(src,FE.makeFontGuid({fontData:src}));
  assert.strictEqual(Buffer.compare(src,copy),0);
});

t('GUIDs are deterministic by content, and differ per style', ()=>{
  const a=FE.buildFontEmbedding({faces:[{family:'X',style:'regular',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}]});
  const b=FE.buildFontEmbedding({faces:[{family:'X',style:'regular',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}]});
  assert.strictEqual(a.parts[0].guid,b.parts[0].guid,'stable across runs');
  const c=FE.buildFontEmbedding({faces:[{family:'X',style:'bold',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}]});
  assert.notStrictEqual(a.parts[0].guid,c.parts[0].guid,'seed varies by style');
});

t('randomGuids produces distinct GUIDs', ()=>{
  const o={faces:[{family:'X',style:'regular',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}],randomGuids:true};
  assert.notStrictEqual(FE.buildFontEmbedding(o).parts[0].guid,FE.buildFontEmbedding(o).parts[0].guid);
});

t('metadata: Mono detected as fixed pitch / modern, Next as variable', ()=>{
  const m=FE.readFontMetadata(`${F}/AtkinsonHyperlegibleMono-Regular.ttf`);
  const x=FE.readFontMetadata(`${F}/AtkinsonHyperlegibleNext-Regular.ttf`);
  assert.strictEqual(m.wordPitch,'fixed'); assert.strictEqual(m.wordFamily,'modern');
  assert.strictEqual(x.wordPitch,'variable'); assert.strictEqual(x.wordFamily,'auto');
  assert.strictEqual(m.familyName,'Atkinson Hyperlegible Mono');
  assert.strictEqual(x.familyName,'Atkinson Hyperlegible Next');
});

t('rejects a Restricted-License font (fsType bit 1)', ()=>{
  const src=Buffer.from(fs.readFileSync(`${F}/AtkinsonHyperlegibleMono-Regular.ttf`));
  // locate OS/2 and set fsType = 2 (Restricted)
  const num=src.readUInt16BE(4);
  for(let i=0;i<num;i++){const o=12+i*16;
    if(src.toString('latin1',o,o+4)==='OS/2'){src.writeUInt16BE(2,src.readUInt32BE(o+8)+8);break;}}
  assert.strictEqual(FE.readFontMetadata(src).fsType,2);
  assert.throws(()=>FE.buildFontEmbedding({faces:[{family:'R',style:'regular',data:src}]}),/forbids embedding/);
});

t('rejects Preview&Print-only when the doc is editable, allows when not', ()=>{
  const src=Buffer.from(fs.readFileSync(`${F}/AtkinsonHyperlegibleMono-Regular.ttf`));
  const num=src.readUInt16BE(4);
  for(let i=0;i<num;i++){const o=12+i*16;
    if(src.toString('latin1',o,o+4)==='OS/2'){src.writeUInt16BE(4,src.readUInt32BE(o+8)+8);break;}}
  assert.throws(()=>FE.buildFontEmbedding({faces:[{family:'P',style:'regular',data:src}]}),/preview\/print/);
  assert.ok(FE.buildFontEmbedding({faces:[{family:'P',style:'regular',data:src}],requireEditable:false}));
});

t('rejects duplicate style and unknown style', ()=>{
  const p=`${F}/AtkinsonHyperlegibleMono-Regular.ttf`;
  assert.throws(()=>FE.buildFontEmbedding({faces:[{family:'D',style:'regular',ttfPath:p},{family:'D',style:'regular',ttfPath:p}]}),/duplicate style/);
  assert.throws(()=>FE.buildFontEmbedding({faces:[{family:'D',style:'heavy',ttfPath:p}]}),/unknown style/);
});

t('rejects non-sfnt input', ()=>{
  assert.throws(()=>FE.readFontMetadata(Buffer.alloc(64)),/not an sfnt font/);
});

t('injectFontTableEntries is idempotent (no duplicate w:font blocks)', ()=>{
  const emb=FE.buildFontEmbedding({faces:[{family:'Atkinson Hyperlegible Mono',style:'regular',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}]});
  let xml=fixture('word/fontTable.xml');
  xml=FE.injectFontTableEntries(xml,emb.fontTableEntries,['Atkinson Hyperlegible Mono']);
  xml=FE.injectFontTableEntries(xml,emb.fontTableEntries,['Atkinson Hyperlegible Mono']);
  const count=(xml.match(/w:name="Atkinson Hyperlegible Mono"/g)||[]).length;
  assert.strictEqual(count,1,`expected 1 block, got ${count}`);
  assert.ok(xml.trim().endsWith('</w:fonts>'));
});

t('injectSettingsFlags is idempotent', ()=>{
  let s=fixture('word/settings.xml');
  s=FE.injectSettingsFlags(s); s=FE.injectSettingsFlags(s);
  assert.strictEqual((s.match(/<w:embedTrueTypeFonts/g)||[]).length,1);
});

t('XML special characters in a family name are escaped', ()=>{
  const e=FE.buildFontEmbedding({faces:[{family:'A & B "C"',style:'regular',ttfPath:`${F}/AtkinsonHyperlegibleMono-Regular.ttf`}]});
  assert.ok(e.fontTableEntries.includes('w:name="A &amp; B &quot;C&quot;"'));
});

console.log(`\n${f===0?'ALL '+n+' UNIT TESTS PASSED':f+' of '+n+' FAILED'}`);
fs.rmSync(TMP,{recursive:true,force:true});
process.exit(f?1:0);

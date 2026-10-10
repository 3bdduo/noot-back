import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { applyPersonalizationEdit, buildSnapshot, evaluateCustomization, snapshotToInput, validateText } from '../src/modules/customization/customization.engine.js';


const base = { exclusiveWithinStep:false, minSelect:0, maxSelect:null, minLength:null, maxLength:null, allowedCharsets:[], pattern:null, allowedMimeTypes:[], maxFileSizeBytes:null, minWidthPx:null, minHeightPx:null, maxWidthPx:null, maxHeightPx:null, priceDelta:0, active:true };
const opt = (code:string, priceDelta=0, extra:any={}) => ({ id:code, code, priceDelta, active:true, isDefault:false, name:{ar:code,en:code}, ...extra });
const groups:any[] = [
  { ...base, id:'g1', code:'size', stepKey:'size', type:'SINGLE_CHOICE', required:true, name:{ar:'s',en:'s'}, options:[opt('a6',0),opt('a5',5000,{isDefault:true}),opt('b5',9000)] },
  { ...base, id:'g2', code:'cover', stepKey:'cover', type:'SINGLE_CHOICE', required:true, name:{ar:'c',en:'c'}, options:[opt('burgundy',2000),opt('sage',2000,{active:false})] },
  { ...base, id:'g3', code:'accessories', stepKey:'accessories', type:'MULTI_CHOICE', required:false, maxSelect:2, name:{ar:'a',en:'a'}, options:[opt('bookmark',1000),opt('charm',3000),opt('pen',4000)] },
  { ...base, id:'g4', code:'initials', stepKey:'personalization', type:'TEXT', required:true, exclusiveWithinStep:true, maxLength:3, allowedCharsets:['LATIN','ARABIC'], priceDelta:1500, name:{ar:'i',en:'i'}, options:[] },
  { ...base, id:'g5', code:'name', stepKey:'personalization', type:'TEXT', required:true, exclusiveWithinStep:true, maxLength:12, allowedCharsets:['LATIN','ARABIC','SPACE'], priceDelta:2500, name:{ar:'n',en:'n'}, options:[] },
  { ...base, id:'g6', code:'upload', stepKey:'personalization', type:'FILE', required:true, exclusiveWithinStep:true, allowedMimeTypes:['image/png'], maxFileSizeBytes:1000000, minWidthPx:500, priceDelta:5000, name:{ar:'u',en:'u'}, options:[] },
];


describe('customization engine', () => {
  it('validates, prices, hashes and edits personalization', () => {
    // happy path, default size is applied
    let r = evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['burgundy']},{groupCode:'initials',text:'TA'},{groupCode:'accessories',optionCodes:['bookmark','charm']}]);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    assert.equal(r.priceDelta, 5000+2000+1500+1000+3000);
    assert.deepEqual(r.summary, { size:'a5', cover:'burgundy', accessories:['bookmark','charm'], personalization:{type:'initials',value:'TA'} });
    const h1 = r.configHash;
    // order of input must not change the hash
    r = evaluateCustomization(groups, [{groupCode:'accessories',optionCodes:['charm','bookmark']},{groupCode:'initials',text:' TA '},{groupCode:'cover',optionCodes:['burgundy']}]);
    assert.equal(r.configHash, h1);

    // inactive option
    r = evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['sage']},{groupCode:'initials',text:'TA'}]);
    assert.ok(r.issues.some(i=>i.code==='CUSTOM_OPTION_INACTIVE'));
    // unknown group & option
    r = evaluateCustomization(groups, [{groupCode:'nope',optionCodes:['x']},{groupCode:'cover',optionCodes:['zzz']},{groupCode:'initials',text:'TA'}]);
    assert.ok(r.issues.some(i=>i.code==='CUSTOM_UNKNOWN_GROUP'));
    assert.ok(r.issues.some(i=>i.code==='CUSTOM_UNKNOWN_OPTION'));
    // required cover missing, step personalization missing
    r = evaluateCustomization(groups, []);
    assert.ok(r.issues.some(i=>i.field==='cover'&&i.code==='CUSTOM_REQUIRED'));
    assert.ok(r.issues.some(i=>i.field==='personalization'&&i.code==='CUSTOM_REQUIRED'));
    // exclusive violated
    r = evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['burgundy']},{groupCode:'initials',text:'TA'},{groupCode:'name',text:'Tarek'}]);
    assert.ok(r.issues.some(i=>i.code==='CUSTOM_EXCLUSIVE'));
    // too many accessories
    r = evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['burgundy']},{groupCode:'initials',text:'TA'},{groupCode:'accessories',optionCodes:['bookmark','charm','pen']}]);
    assert.ok(r.issues.some(i=>i.code==='CUSTOM_TOO_MANY'));
    // text rules
    assert.ok(validateText('TAAA', groups[3]).issues.some(i=>i.code==='CUSTOM_TEXT_TOO_LONG'));
    assert.ok(validateText('T1', groups[3]).issues.some(i=>i.code==='CUSTOM_TEXT_CHARSET'));
    assert.ok(validateText('<b>', groups[3]).issues.some(i=>i.code==='CUSTOM_TEXT_CHARSET'));
    assert.ok(validateText('ت‮م', groups[3]).issues.some(i=>i.code==='CUSTOM_TEXT_CHARSET'));
    assert.equal(validateText('تامر', groups[3]).issues.length, 1); // 4 graphemes > 3
    assert.equal(validateText('أح', groups[3]).issues.length, 0);
    assert.equal(validateText('مُحَمَّد', {...groups[4], maxLength:12}).issues.length, 0); // diacritics allowed, counted as grapheme
    // file rules
    const files = new Map([['f1',{id:'f1',status:'READY',groupId:'g6',mimeType:'image/png',sizeBytes:500000,widthPx:800,heightPx:800,ownedByActor:true}],
      ['f2',{id:'f2',status:'READY',groupId:'g6',mimeType:'image/jpeg',sizeBytes:500000,widthPx:800,heightPx:800,ownedByActor:true}],
      ['f3',{id:'f3',status:'READY',groupId:'g6',mimeType:'image/png',sizeBytes:500000,widthPx:100,heightPx:800,ownedByActor:true}],
      ['f4',{id:'f4',status:'READY',groupId:'g6',mimeType:'image/png',sizeBytes:500000,widthPx:800,heightPx:800,ownedByActor:false}]] as any);
    const withFile = (id:string)=>evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['burgundy']},{groupCode:'upload',artworkFileId:id}], files);
    assert.equal(withFile('f1').ok, true);
    assert.ok(withFile('f2').issues.some(i=>i.code==='FILE_TYPE_NOT_ALLOWED'));
    assert.ok(withFile('f3').issues.some(i=>i.code==='FILE_DIMENSIONS_INVALID'));
    assert.ok(withFile('f4').issues.some(i=>i.code==='CUSTOM_FILE_FORBIDDEN'));
    assert.ok(withFile('nope').issues.some(i=>i.code==='CUSTOM_FILE_NOT_FOUND'));
    // edit personalization keeps choices
    const first = evaluateCustomization(groups, [{groupCode:'cover',optionCodes:['burgundy']},{groupCode:'initials',text:'TA'}]);
    const snap = buildSnapshot(first);
    const edit = applyPersonalizationEdit(groups, snapshotToInput(snap), [{groupCode:'initials',text:'MK'},{groupCode:'cover',optionCodes:['sage']}]);
    assert.deepEqual(edit.illegalGroupCodes, ['cover']);
    const second = evaluateCustomization(groups, edit.input);
    assert.equal(second.ok, true, JSON.stringify(second.issues));
    assert.equal(second.priceDelta, first.priceDelta);
    assert.equal((second.summary as any).personalization.value, 'MK');
    console.log('engine smoke OK');

  });
});
